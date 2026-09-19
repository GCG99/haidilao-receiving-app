-- 2026-09-19发现的真实bug：import_p2_statements_ocr.mjs的discrepancy核对只比较
-- sum(逐行明细金额) vs closing_balance，完全没算上账户的期初余额(opening_balance)。
-- OCR的STATEMENT_TOOL其实一直有提取header.opening_balance，但这个字段从来没存进过
-- 表里，也没进discrepancy公式——导致任何有跨期结转余额的正常贸易账户(几乎所有真实
-- 供应商账户都是这样)都会被错误标成discrepancy。真实案例：Kleanking 7月账单期初
-- 4528.08+本期明细406.98=期末4935.06；8月账单期初4935.06(=7月期末，独立交叉验证
-- 完全吻合)+本期明细264.16=期末5199.22——两期数字互相印证，证明这不是数据错误，
-- 是核对公式漏了一项。

ALTER TABLE supplier_statements ADD COLUMN IF NOT EXISTS opening_balance numeric(14,2);

COMMENT ON COLUMN supplier_statements.opening_balance IS
  '账户期初余额(跨期结转)，来自OCR header.opening_balance；discrepancy核对公式应为
   opening_balance + sum(明细金额) ≈ total_balance，不是单纯sum(明细金额) ≈ total_balance';
