-- 第10轮ChatGPT复核结论：source_files 原来只有普通索引，没有唯一约束，
-- storeFile() 是"查不存在再插入"（不在事务里），同一份文件被并发上传两次
-- （网络卡顿重试、或同一操作短时间内重复点击）会产生两条 sha256 相同的记录，
-- 破坏"同一文件只存一份"的设计承诺。改成数据库层唯一约束兜底。
ALTER TABLE source_files ADD CONSTRAINT uq_source_files_sha256 UNIQUE (sha256);
-- 唯一约束自带一个唯一索引，跟 0002 里建的普通索引重复，删掉旧的避免冗余索引。
DROP INDEX IF EXISTS idx_source_files_sha256;
