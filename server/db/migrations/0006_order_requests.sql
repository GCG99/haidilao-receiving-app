-- 叫货记录：用户确认"全部都是我叫货了才送"——每次送货前都有一次报数量的行为，
-- 但没有供应商确认/审批这种正式PO环节，所以不建状态机，只是一条"意图记录"，
-- 主要价值是到货后能核对"叫的和到的是否一致"，不是走审批流程。
-- 见 P2_设计文档/线A线B整合规划.md 第二节。

CREATE TABLE IF NOT EXISTS order_requests (
  id serial PRIMARY KEY,
  order_date date NOT NULL,
  supplier_id text NOT NULL REFERENCES suppliers(id),
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_requests_supplier_date ON order_requests (supplier_id, order_date);

CREATE TABLE IF NOT EXISTS order_request_items (
  id serial PRIMARY KEY,
  order_request_id int NOT NULL REFERENCES order_requests(id) ON DELETE CASCADE,
  material_id text REFERENCES materials(sku),  -- 叫货时可能还没精确匹配到SKU，允许为空，后续按P1物料匹配规则补
  supplier_material_name text,                 -- 叫货时报的原始物料说法
  ordered_quantity numeric(14,3) NOT NULL CHECK (ordered_quantity > 0),
  unit text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_order_request_items_request ON order_request_items (order_request_id);
