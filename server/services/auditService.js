import { pool } from "../db/pool.js";

const VALID_ACTIONS = new Set([
  "create",
  "update",
  "delete",
  "confirm",
  "match",
  "unmatch",
  "enter_erp",
  "close"
]);

// 关键数据不物理删除；所有 create/update/confirm/match 等操作都应该调用这个函数留痕。
// client 可选：如果调用方已经在一个事务里（withTransaction 的 client），传进来一起提交，
// 保证"业务数据改了但审计没记上"这种情况不会发生。
export async function writeAuditLog(entry, client = pool) {
  const {
    storeId = null,
    user,
    action,
    entityType,
    entityId,
    beforeJson = null,
    afterJson = null,
    ip = null,
    userAgent = null
  } = entry;

  if (!VALID_ACTIONS.has(action)) {
    throw new Error(`未知的审计操作类型：${action}`);
  }
  if (!entityType || !entityId) {
    throw new Error("写审计日志缺少 entityType 或 entityId。");
  }

  await client.query(
    `INSERT INTO audit_logs
      (store_id, user_id, user_name, action, entity_type, entity_id, before_json, after_json, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      storeId,
      user?.open_id || user?.id || null,
      user?.name || null,
      action,
      entityType,
      String(entityId),
      beforeJson ? JSON.stringify(beforeJson) : null,
      afterJson ? JSON.stringify(afterJson) : null,
      ip,
      userAgent
    ]
  );
}

export function auditContextFromRequest(req) {
  return {
    user: req.user,
    ip: req.ip,
    userAgent: req.get("user-agent") || null
  };
}
