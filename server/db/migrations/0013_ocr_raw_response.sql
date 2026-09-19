-- 2026-09-17设计讨论时就提出、一直没做的技术改进：ocrParsingService.js的
-- callExtractionTool()把模型返回的完整结果(header/items/notes，含每个字段的
-- source_quote原文摘抄)只用来做一次性的响应完整性校验，校验完就整个丢弃——
-- 数据库里只留下经过挑选的几个字段(invoice_no/total_amount/ocr_confidence等)，
-- 每个字段具体是从原文哪句话读出来的这个信息完全没有保留。
-- 2026-09-19实测踩坑：核实CFC某张发票的日期字段时，只能靠"当初拆分出来的子PDF
-- 文件还留在库管目录里"这个运气去翻找原始文件对照，如果原始文件被清理掉就
-- 没法复核了。存住原始响应后，以后任何字段有疑问，直接查这个jsonb字段里的
-- source_quote就行，不用再去翻文件系统。

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS ocr_raw_response jsonb;
ALTER TABLE credits ADD COLUMN IF NOT EXISTS ocr_raw_response jsonb;

COMMENT ON COLUMN invoices.ocr_raw_response IS
  'parseInvoiceDocument()返回的完整原始结果(header/items/notes，含每个字段的
   source_quote原文摘抄)，人工录入(非OCR路径)的发票这个字段是NULL。纯审计/复核用途，
   不参与任何业务逻辑判断，也不是任何其他字段的数据来源(那些字段各自独立存储)。';
COMMENT ON COLUMN credits.ocr_raw_response IS
  '同 invoices.ocr_raw_response，parseCreditDocument()的完整原始结果。';
