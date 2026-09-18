-- 海底捞内部ERP系统导出的月度出入库/领用/报损/调拨单据历史数据归档。
-- 背景：0008_stock_ledger.sql（已应用，不原地改）的设计前提是"出库方向没有可靠数据源"——
-- 2026-09-18历史数据扫描时只看到「盘点」快照（stocktake_official_import），当时判断出库
-- 只能靠盘点前后倒算区间估计。这次实际打开`盘点/4月`~`盘点/7月`目录下的PDF原始文件才发现，
-- 海底捞内部系统其实按月导出了真实的逐单据出入库记录（成品入库/成品原材料出库/酱料入库/
-- 酱料出库/员工餐领用/报损/调拨），文本可直接提取（不是扫描图片，不需要OCR）。
-- 这个前提不完整的地方是"没有持续实时数据源"，不是"完全没有数据"——月度批量导出也是数据源，
-- 跟stocktake_official_import发现的情况是同一类教训。
--
-- 不改0008/不复用stock_ledger：stock_ledger的quantity字段有CHECK约束恒正、语义被设计成
-- "只记入库方向"，跟这批数据里"调拨明细"quantity本身带符号（源文件示例是-10.000，代表
-- 从本店调出）、"报损"是纯出库损耗、"出库/领用"单据虽然数字恒正但方向由单据类型决定
-- 而非数字符号——三种不同的数字语义硬塞进同一个"恒正"字段会互相矛盾。跟stocktake_official_import
-- 的先例一样：已应用的迁移不动，新数据建独立的历史归档表。
--
-- 字段设计原则：忠实转录源文件字段，不做符号/方向的二次解读——quantity按源文件原样存储
-- (成品入库/出库类单据恒正，调拨类单据保留源文件自带的符号)，direction只是从单据本身的
-- 字段名（"反冲数量"=入库 vs "实发数量"=出库）或单据类型（报损/调拨）机械推导出来的标注，
-- 不代表对業務含義的二次判断。
--
-- haidilao_material_code是海底捞内部系统编码，不是P1 SKU体系，material_id允许NULL、
-- 等物料匹配清洗完成后回填（跟stocktake_official_import一致的处理方式）。
CREATE TABLE IF NOT EXISTS internal_movement_import (
  id serial PRIMARY KEY,
  movement_type text NOT NULL,       -- 源文件/单据标题的原始类型描述，如"加工领用出库单"/"物料领用单"/"报损"/"调拨"，不强行归一化
  direction text NOT NULL CHECK (direction IN ('in', 'out')),  -- 机械推导：入库单据/反冲数量→in；出库领用单据/报损/调拨→out
  voucher_no text,                   -- 凭证编号，出入库/领用单据都有；报损、调拨单据源文件没有此字段，允许NULL
  document_date date NOT NULL,       -- 领料日期（出入库/领用）或 时间/月份（报损/调拨）
  material_id text REFERENCES materials(sku),   -- 允许NULL，物料匹配清洗完成后回填
  haidilao_material_code text NOT NULL,          -- 海底捞内部系统物料编码，原始值，永远保留
  material_name text,                            -- 源文件物料名称/物料描述，原始值
  spec text,                                     -- 规格（报损/调拨单据源文件没有独立规格列，为NULL）
  unit text,
  quantity numeric(14,3) NOT NULL,   -- 按源文件原样存储，不二次判断符号；出入库/领用单据恒正，调拨单据保留源文件自带符号
  reason text,                       -- 报损原因，仅报损单据有
  transfer_from_store text,          -- 调出门店，仅调拨单据有
  transfer_to_store text,            -- 调入门店，仅调拨单据有
  line_no int NOT NULL,              -- 源文件内的行序号（多页单据跨页连续编号），用于溯源+去重键的一部分
  source_file text NOT NULL,         -- 原始文件名，供溯源
  imported_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_file, line_no)      -- 防止同一文件被重复导入产生重复行；同一凭证编号可能跨多个文件重复出现的情况不由这个约束处理，由导入脚本自行核对
);
CREATE INDEX IF NOT EXISTS idx_internal_movement_import_material_date
  ON internal_movement_import (material_id, document_date);
CREATE INDEX IF NOT EXISTS idx_internal_movement_import_code
  ON internal_movement_import (haidilao_material_code);
CREATE INDEX IF NOT EXISTS idx_internal_movement_import_voucher
  ON internal_movement_import (voucher_no) WHERE voucher_no IS NOT NULL;
