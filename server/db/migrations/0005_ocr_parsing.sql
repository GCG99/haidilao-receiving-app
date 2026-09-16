-- OCR/PDF解析引擎（第20+轮ChatGPT复核确认的方案）：
-- invoices/credits 都需要一个"识别失败/判定非发票"的状态，跟其他正常流转状态区分开；
-- invoice_items 需要一个明细行级别的OCR识别置信度，跟 match_confidence（三方匹配置信度）语义分开。
ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check CHECK (status IN (
  'new', 'parsed', 'pending_match', 'matched', 'partially_matched',
  'discrepancy', 'confirmed', 'entered_to_erp', 'closed', 'parse_failed'
));

ALTER TABLE credits DROP CONSTRAINT credits_status_check;
ALTER TABLE credits ADD CONSTRAINT credits_status_check CHECK (status IN (
  'new', 'pending_review', 'pending_erp_entry', 'entered_to_erp', 'closed', 'parse_failed'
));

ALTER TABLE invoice_items ADD COLUMN ocr_line_confidence numeric(4,3);
