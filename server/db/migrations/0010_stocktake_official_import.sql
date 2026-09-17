-- 海底捞内部系统月度正式盘点导出（跟 0009 的 stocktake_records 是两种不同粒度/权威级别的盘点事件，
-- 不混进同一张表：stocktake_records 是员工每周手动做的轻量盘点，这张是海底捞系统每月导出的正式报表，
-- 字段丰富得多（部门/库位分列、系统自算的消耗量、异常备注），讨论见 P2_设计文档/线A线B整合规划.md，
-- ChatGPT复核确认拆表更经得起长期维护。
--
-- 背景：2026-09-18历史数据扫描发现 `盘点/7月/附表2：AU6D-20260731 库存盘点表.xlsx` 的"盘点数据填写"sheet
-- （760行真实数据）里，消耗量 = 库存数量(期初) - 总盘点数量(本期)，已用真实数据逐行验证：757行有完整数据
-- 的行里，这个等式100%精确成立，0个例外——消耗量是纯派生值，海底捞系统只是把算术结果也一起导出了。
-- 即便如此仍然存储 consumption_quantity 原样：一是延续P1"原始字段永远保留、不因为能推导就丢弃"的规矩，
-- 二是万一海底捞系统未来算法口径变了，当时真实导出的值才是历史真相，不能靠现在的公式反推旧数据。
--
-- material_id 允许为空：源文件用的是海底捞内部系统自己的物料编码，不是P1的SKU体系，这批历史数据还没做
-- 物料匹配清洗，不能强行外键约束——按P1一贯规矩，原始编码(haidilao_material_code)必须原样留痕，
-- 匹配结果（material_id）是清洗之后才回填的独立字段，未匹配之前允许是 NULL。
--
-- 这张表现在只是历史数据的静态归档入口，material_id 大概率还是 NULL（等物料匹配清洗跑完才会回填），
-- 所以 stock_estimated_current 视图暂不接入这张表——等清洗完、material_id 可靠关联上SKU之后再评估。
CREATE TABLE IF NOT EXISTS stocktake_official_import (
  id serial PRIMARY KEY,
  material_id text REFERENCES materials(sku),  -- 允许NULL，物料匹配清洗完成后回填
  haidilao_material_code text NOT NULL,          -- 海底捞内部系统物料编码，原始值，永远保留
  material_name text,                            -- 源文件里的物料名称，原始值，供人工核对匹配用
  period_end_date date NOT NULL,                 -- 本次盘点周期结束日期，如 2026-07-31
  opening_quantity numeric(14,3),                -- 期初库存数量（源文件"库存数量"列）
  counted_quantity numeric(14,3),                -- 本期盘点数量（源文件"总盘点数量"列，各部门/库位求和后的值）
  consumption_quantity numeric(14,3),            -- 消耗量（源文件原样给出的值，= opening - counted，纯派生但原样保留）
  anomaly_note text,                             -- 消耗量异常原因备注（源文件独立信息，不可从其它字段派生）
  department_breakdown jsonb,                    -- {部门/库位名: 数量} 字典；11个部门列展开成jsonb而非固定列，
                                                  -- 因为不确定不同月份部门清单是否稳定，jsonb比开11列更能扛住变化
  source_file text NOT NULL,                     -- 原始文件名，供溯源
  imported_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stocktake_official_import_material_period
  ON stocktake_official_import (material_id, period_end_date);
CREATE INDEX IF NOT EXISTS idx_stocktake_official_import_haidilao_code
  ON stocktake_official_import (haidilao_material_code);
