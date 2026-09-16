-- 第一阶段：录单工作台 / ERP入库单 / Invoice / Credit / Statement / 三方匹配。
-- 只新增表，不修改 0001 里已有的表结构，不影响现有收货功能。

-- ========== 供应商物料名称映射（"学习"机制：状态机而非连续置信度分数） ==========
-- 首次出现的供应商物料名称由 AI 推荐生成一条 pending 记录；人工确认后变 active。
-- 如果同一个 supplier_material_name 后来被人工改判到另一个 material_id，
-- 旧记录标记 superseded 并指向新记录，改判本身写入 audit_logs，不在这里存历史。
CREATE TABLE IF NOT EXISTS supplier_material_mapping (
  id serial PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES suppliers(id),
  supplier_material_name text NOT NULL,
  supplier_material_code text,
  material_id text REFERENCES materials(sku),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'superseded', 'disputed', 'discarded')),
  confirmed_count int NOT NULL DEFAULT 0,
  last_confirmed_at timestamptz,
  superseded_by_mapping_id int REFERENCES supplier_material_mapping(id),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 同一供应商同一物料名称，同一时间最多一条 active 映射（历史 superseded/discarded 记录不受限）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_material_mapping_active
  ON supplier_material_mapping (supplier_id, supplier_material_name)
  WHERE status = 'active';
-- 同一供应商同一物料名称，同一时间最多一条待确认的 AI 推荐（避免并发 OCR/重复请求插入重复 pending）。
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_material_mapping_pending
  ON supplier_material_mapping (supplier_id, supplier_material_name)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_supplier_material_mapping_lookup
  ON supplier_material_mapping (supplier_id, supplier_material_name);

-- ========== 单位换算（供应商+物料维度，未确认不得自动猜） ==========
CREATE TABLE IF NOT EXISTS unit_conversions (
  id serial PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES suppliers(id),
  material_id text NOT NULL REFERENCES materials(sku),  -- 换算关系天然挂在具体物料上；不允许物料为空的换算记录
  from_unit text NOT NULL,
  to_unit text NOT NULL,
  factor numeric(10,4) NOT NULL CHECK (factor > 0),  -- 1 from_unit = factor * to_unit，例如 1箱=4包 → from_unit=箱, to_unit=包, factor=4
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disputed')),
  confirmed_count int NOT NULL DEFAULT 0,
  last_confirmed_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, material_id, from_unit, to_unit)
);

-- ========== 收货明细（逐SKU结构化，新增表；现有 receiving_records.selections 打勾模型不变不删） ==========
-- 注意（第8轮ChatGPT复核确认）：这张表当前在全部代码里零写入路径、零查询依赖——
-- 现有 POST /api/receiving 还是纯飞书打勾模型，workbench/matching 等新功能也都只查
-- receiving_records，不查这张表。纯粹是为后续"结构化收货流程接入"预留的干净占位表，
-- 不是没接完的半成品。以后如果查这张表查到空结果，先确认写入路径是否已经接上。
CREATE TABLE IF NOT EXISTS receiving_items (
  id serial PRIMARY KEY,
  receiving_record_id text NOT NULL REFERENCES receiving_records(id) ON DELETE CASCADE,
  material_id text REFERENCES materials(sku),
  supplier_material_name text,
  supplier_material_spec text,
  ordered_quantity numeric(14,3),
  received_quantity numeric(14,3),
  unit text,
  package_quantity numeric(14,3),
  package_unit text,
  accepted_quantity numeric(14,3),
  rejected_quantity numeric(14,3),
  return_quantity numeric(14,3),
  exception_type text,
  exception_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_receiving_items_record ON receiving_items (receiving_record_id);

-- ========== 原始文件元数据（sha256 去重） ==========
CREATE TABLE IF NOT EXISTS source_files (
  id serial PRIMARY KEY,
  file_name text NOT NULL,
  mime_type text,
  storage_provider text NOT NULL,
  storage_path text NOT NULL,
  uploaded_by text,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  sha256 text NOT NULL
);
-- 不做硬唯一约束：不同供应商凑巧上传字节相同的文件不该被数据库拒绝；
-- "同一文件重复上传"的判断和复用交给应用层查询处理（见 fileStorageService.js）。
CREATE INDEX IF NOT EXISTS idx_source_files_sha256 ON source_files (sha256);

-- ========== ERP 入库单 ==========
CREATE TABLE IF NOT EXISTS erp_receipts (
  id serial PRIMARY KEY,
  store_id text,
  supplier_id text REFERENCES suppliers(id),
  erp_document_no text NOT NULL,
  purchase_order_no text,
  erp_receiving_date date,
  document_date date,
  inventory_location text,
  movement_type text,
  total_amount numeric(14,2),
  currency text NOT NULL DEFAULT 'AUD',
  source_file_id int REFERENCES source_files(id),
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, erp_document_no)
);

CREATE TABLE IF NOT EXISTS erp_receipt_items (
  id serial PRIMARY KEY,
  erp_receipt_id int NOT NULL REFERENCES erp_receipts(id) ON DELETE CASCADE,
  line_no int,
  material_id text REFERENCES materials(sku),
  erp_material_code text,
  erp_material_description text,
  unit text,
  unit_description text,
  order_quantity numeric(14,3),
  received_quantity numeric(14,3),
  unit_price numeric(14,4),
  amount numeric(14,2),
  short_text text,
  production_date date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_erp_receipt_items_receipt ON erp_receipt_items (erp_receipt_id);

-- ========== Invoice ==========
-- 注意：不设 matched_receiving_id / matched_erp_receipt_id 单值外键——
-- 一张 invoice 可能合并覆盖多次送货（例如按周开票），必须用下面的关联表表示一对多。
CREATE TABLE IF NOT EXISTS invoices (
  id serial PRIMARY KEY,
  store_id text,
  supplier_id text NOT NULL REFERENCES suppliers(id),
  invoice_no text,  -- 上传时还不知道，OCR/人工解析回填后才有值
  invoice_date date,
  due_date date,
  invoice_type text,
  currency text NOT NULL DEFAULT 'AUD',
  subtotal numeric(14,2),
  gst numeric(14,2),
  total_amount numeric(14,2),
  source text,
  source_file_id int REFERENCES source_files(id),
  status text NOT NULL DEFAULT 'new' CHECK (status IN (
    'new', 'parsed', 'pending_match', 'matched', 'partially_matched',
    'discrepancy', 'confirmed', 'entered_to_erp', 'closed'
  )),
  ocr_confidence numeric(4,3),
  parser_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, invoice_no)
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id serial PRIMARY KEY,
  invoice_id int NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  line_no int,
  supplier_item_name text,
  supplier_item_code text,
  description text,
  material_id text REFERENCES materials(sku),
  quantity numeric(14,3),
  unit text,
  unit_price numeric(14,4),
  amount numeric(14,2),
  gst_rate numeric(6,4),  -- 存储惯例：小数形式，10% GST 存成 0.1000，不是 10.00（第7轮ChatGPT复核确认）
  gst_amount numeric(14,2),
  delivery_docket_no text,
  purchase_order_no text,
  match_status text NOT NULL DEFAULT 'unmatched'
    CHECK (match_status IN ('unmatched', 'matched', 'disputed')),
  match_confidence numeric(4,3),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items (invoice_id);

-- Invoice ↔ 收货记录：一对多（一张发票合并覆盖多次送货）。
CREATE TABLE IF NOT EXISTS invoice_receiving_links (
  id serial PRIMARY KEY,
  invoice_id int NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  receiving_record_id text NOT NULL REFERENCES receiving_records(id),
  matched_amount numeric(14,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, receiving_record_id)
);

-- Invoice ↔ ERP 入库单：一对多。
CREATE TABLE IF NOT EXISTS invoice_erp_receipt_links (
  id serial PRIMARY KEY,
  invoice_id int NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  erp_receipt_id int NOT NULL REFERENCES erp_receipts(id),
  matched_amount numeric(14,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, erp_receipt_id)
);

-- ========== Credit Note ==========
CREATE TABLE IF NOT EXISTS credits (
  id serial PRIMARY KEY,
  store_id text,
  supplier_id text NOT NULL REFERENCES suppliers(id),
  credit_note_no text,  -- 同上，上传时可能还不知道
  credit_date date,
  invoice_id int REFERENCES invoices(id),
  delivery_docket_no text,
  receiving_record_id text REFERENCES receiving_records(id),
  reason text,
  total_amount numeric(14,2),
  currency text NOT NULL DEFAULT 'AUD',
  source text,
  source_file_id int REFERENCES source_files(id),
  status text NOT NULL DEFAULT 'new' CHECK (status IN (
    'new', 'pending_review', 'pending_erp_entry', 'entered_to_erp', 'closed'
  )),
  entered_to_erp_at timestamptz,
  entered_to_erp_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, credit_note_no)
);

-- ========== Supplier Statement ==========
CREATE TABLE IF NOT EXISTS supplier_statements (
  id serial PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES suppliers(id),
  statement_date date,  -- 上传时可能还不知道，跟 invoice_no/credit_note_no 同样的道理
  account_no text,
  total_balance numeric(14,2),
  source_file_id int REFERENCES source_files(id),
  status text NOT NULL DEFAULT 'new',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, statement_date, source_file_id)
);

CREATE TABLE IF NOT EXISTS supplier_statement_items (
  id serial PRIMARY KEY,
  statement_id int NOT NULL REFERENCES supplier_statements(id) ON DELETE CASCADE,
  transaction_date date,
  reference text,
  transaction_type text,
  amount numeric(14,2),
  running_balance numeric(14,2),
  due_date date,
  matched_invoice_id int REFERENCES invoices(id),
  matched_credit_id int REFERENCES credits(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_supplier_statement_items_statement ON supplier_statement_items (statement_id);

-- ========== 审计日志（关键数据不物理删除，所有关键操作都记一笔） ==========
CREATE TABLE IF NOT EXISTS audit_logs (
  id bigserial PRIMARY KEY,
  store_id text,
  user_id text,
  user_name text,
  action text NOT NULL CHECK (action IN (
    'create', 'update', 'delete', 'confirm', 'match', 'unmatch', 'enter_erp', 'close'
  )),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  ip text,
  user_agent text
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id);
