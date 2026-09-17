-- 库存流水表：只记"入库方向"，语义单一（一律是正数入库变动量）。
-- 不记"出库/消耗"——目前没有可靠数据源，逐笔消耗数据装不出来。
-- 盘点（绝对数量快照）不放这张表，见 0009 stocktake_records（语义不同，不能跟流水混在一张表同一个字段里，
-- 讨论见 P2_设计文档/线A线B整合规划.md 第二节 + ChatGPT复核确认拆两张表更经得起长期维护）。
CREATE TABLE IF NOT EXISTS stock_ledger (
  id serial PRIMARY KEY,
  material_id text NOT NULL REFERENCES materials(sku),
  entry_date date NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('receiving', 'erp_receipt')),
  source_table text NOT NULL,   -- 'receiving_items' / 'erp_receipt_items'，标注这条流水具体来自哪张表
  source_id int NOT NULL,       -- 指向来源表的具体行ID，便于溯源；未来若接入内部系统入库API，加新source_type即可，不改表结构
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),  -- 恒正：这张表只记入库，不记出库
  unit text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_type, source_table, source_id)  -- 防止同一来源行被重复计入两次流水
);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_material_date ON stock_ledger (material_id, entry_date);
