-- 周盘点：配置清单（哪些物料需要盘点）+ 盘点记录（绝对数量快照，不是流水delta）。
-- predicted_quantity：填写界面给出的预设默认值(上次盘点数+期间入库量，简单加减法，不是机器学习预测——
-- 单店规模+每周频率现阶段数据量不够训练模型，属于冷启动场景，先攒真实数据，见整合规划文档第三节)，
-- 跟 counted_quantity(员工实际填的数) 一起存，供以后分析"预测跟实际差多少"，为将来要不要上ML留数据基础。

CREATE TABLE IF NOT EXISTS stocktake_material_config (
  id serial PRIMARY KEY,
  material_id text NOT NULL REFERENCES materials(sku),
  frequency text NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('weekly')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (material_id)
);

CREATE TABLE IF NOT EXISTS stocktake_records (
  id serial PRIMARY KEY,
  material_id text NOT NULL REFERENCES materials(sku),
  counted_at timestamptz NOT NULL DEFAULT now(),
  counted_quantity numeric(14,3) NOT NULL CHECK (counted_quantity >= 0),
  predicted_quantity numeric(14,3),  -- 填写时展示的预设默认值，可为空（比如物料第一次盘点、没有历史数据可推算）
  counted_by text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stocktake_records_material_date ON stocktake_records (material_id, counted_at DESC);

-- 估算当前库存：取该物料最近一次盘点的绝对数量 + 盘点之后的入库流水之和。
-- 只对"有盘点记录"的物料返回一行——没盘点过的物料不出现在这个视图里，
-- 调用方据此判断"这个物料压根没有当前库存估算"，不会看到一个假装准确的0或NULL。
CREATE OR REPLACE VIEW stock_estimated_current AS
SELECT
  st.material_id,
  st.counted_quantity AS last_stocktake_quantity,
  st.counted_at AS last_stocktake_at,
  COALESCE(inflow.qty, 0) AS inflow_since_stocktake,
  st.counted_quantity + COALESCE(inflow.qty, 0) AS estimated_current_quantity
FROM (
  SELECT DISTINCT ON (material_id) material_id, counted_quantity, counted_at
  FROM stocktake_records
  ORDER BY material_id, counted_at DESC
) st
LEFT JOIN LATERAL (
  SELECT SUM(sl.quantity) AS qty
  FROM stock_ledger sl
  WHERE sl.material_id = st.material_id
    AND sl.entry_date > st.counted_at::date
) inflow ON true;
