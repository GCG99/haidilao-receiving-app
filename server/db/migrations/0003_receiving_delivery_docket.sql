-- 三方匹配（Invoice ↔ 收货记录 ↔ ERP入库单）需要送货单号作为比日期窗口更可靠的匹配键。
-- 纯新增可空列，不影响现有收货 App 的读写（它目前完全不碰 Postgres，也不会去认识这个新列）。
ALTER TABLE receiving_records ADD COLUMN IF NOT EXISTS delivery_docket_no text;

CREATE INDEX IF NOT EXISTS idx_receiving_records_docket
  ON receiving_records (supplier_id, delivery_docket_no)
  WHERE delivery_docket_no IS NOT NULL;
