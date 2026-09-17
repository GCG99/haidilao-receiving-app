-- 收货记录关联到对应的叫货记录，用于核对"叫的和到的是否一致"。
-- 纯新增可空列，历史 receiving_records 天然没有对应叫货记录，不回填、不强制。
-- 同一模式见 0003（delivery_docket_no）：新增可空列不影响现有收货 App 的读写。
ALTER TABLE receiving_records ADD COLUMN IF NOT EXISTS order_request_id int REFERENCES order_requests(id);

CREATE INDEX IF NOT EXISTS idx_receiving_records_order_request
  ON receiving_records (order_request_id)
  WHERE order_request_id IS NOT NULL;
