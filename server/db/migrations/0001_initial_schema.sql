-- Phase 0 schema：只建收货小程序现在用得上的表 + P1 物料/供应商/分类字典。
-- 采购单/到货验收/入库单/发票/库存流水等 P2 表，等对应 Phase 真正需要时再加，不在这里预建。
-- 参见：P2_设计文档/全系统合并架构与路线图.md

-- ========== 供应商（P1 正式供应商主数据 + 收货小程序对齐结果） ==========
CREATE TABLE IF NOT EXISTS suppliers (
  id text PRIMARY KEY,                     -- P1 供应商ID，例如 SUP-004
  name text NOT NULL,                      -- P1 正式供应商名称
  receiving_app_name text,                 -- 收货小程序/飞书"供应商计划"里实际使用的名字，可能拼写不同于 name
  internal_code text,                      -- 供应商代码.xls 里的内部系统代号（9AUxxx），内部仓库路径留空
  is_internal_warehouse boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT '在用',      -- 在用 / 已合并停用
  merged_into_id text REFERENCES suppliers(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ========== 供应商送货计划（原飞书"供应商计划"Base：哪个供应商哪天送货、属于哪个验收类别） ==========
CREATE TABLE IF NOT EXISTS supplier_delivery_schedule (
  id serial PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES suppliers(id),
  weekday text NOT NULL,                   -- 周一..周日
  supplier_type text NOT NULL,             -- produce / frozen / meat / northern / other，对应旧"验收类型"
  feishu_record_id text,                   -- 来源飞书供应商计划表的 record_id，便于对照排查
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (supplier_id, weekday, supplier_type)
);

-- ========== 分类字典（P1，暂未被收货小程序直接使用，先导入备用） ==========
CREATE TABLE IF NOT EXISTS categories (
  code text PRIMARY KEY,
  name text NOT NULL,
  level int,
  parent_code text REFERENCES categories(code),
  sort_order int,
  description text,
  material_count_snapshot int
);

-- ========== 物料主数据（P1，暂未被收货小程序直接使用，先导入备用） ==========
-- raw 保留完整原始行（P1 全部37个字段），避免过早决定哪些字段该建成正式列、哪些不用；
-- 常用的几个字段额外拆成正式列方便查询。
CREATE TABLE IF NOT EXISTS materials (
  sku text PRIMARY KEY,
  name text NOT NULL,
  english_name text,
  original_name text,
  category text,
  subcategory text,
  unit text,
  spec text,
  default_supplier_name text,
  status text,                             -- 采购状态
  enabled_status text,                     -- 启用状态
  record_status text,                      -- 记录状态（在用 / 已合并等）
  merged_into_sku text REFERENCES materials(sku),
  raw jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ========== 收货记录（原飞书"收货记录"Base，现在数据库是权威源，飞书是同步副本） ==========
CREATE TABLE IF NOT EXISTS receiving_records (
  id text PRIMARY KEY,
  date date NOT NULL,
  supplier_id text REFERENCES suppliers(id),   -- 临时叫货的供应商可能对不上字典，允许为空
  supplier_name text NOT NULL,                 -- 提交时的字面供应商名，始终保留
  supplier_type text,
  status text NOT NULL DEFAULT 'completed',    -- completed / no_goods
  selections jsonb NOT NULL DEFAULT '{}'::jsonb,
  exception_note text NOT NULL DEFAULT '',
  operator text,
  operator_open_id text,
  feishu_record_id text,                       -- 同步成功后回填
  sync_status text NOT NULL DEFAULT 'pending', -- pending / synced / failed
  sync_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_receiving_records_date ON receiving_records(date);
CREATE INDEX IF NOT EXISTS idx_receiving_records_sync_status ON receiving_records(sync_status) WHERE sync_status <> 'synced';

-- ========== 收货照片（照片文件本体仍存在飞书 Drive，这里只存 file_token 等元数据） ==========
CREATE TABLE IF NOT EXISTS receiving_photos (
  id serial PRIMARY KEY,
  receiving_record_id text NOT NULL REFERENCES receiving_records(id) ON DELETE CASCADE,
  kind text NOT NULL,
  file_token text NOT NULL,
  file_name text,
  sequence int,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_receiving_photos_record ON receiving_photos(receiving_record_id);
