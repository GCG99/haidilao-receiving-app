import { pool, withTransaction } from "../db/pool.js";
import { writeAuditLog } from "./auditService.js";

// 供应商物料名称第一次出现：创建一条待确认的 AI 推荐（不直接采用）。
// 并发/重复触发时用 ON CONFLICT DO NOTHING 兜底，避免重复 pending 记录（见 uq_supplier_material_mapping_pending）。
export async function createPendingMapping(supplierId, supplierMaterialName, recommendedMaterialId, { supplierMaterialCode = null, createdBy = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO supplier_material_mapping
        (supplier_id, supplier_material_name, supplier_material_code, material_id, status, created_by)
     VALUES ($1, $2, $3, $4, 'pending', $5)
     ON CONFLICT (supplier_id, supplier_material_name) WHERE status = 'pending'
     DO NOTHING
     RETURNING *`,
    [supplierId, supplierMaterialName, supplierMaterialCode, recommendedMaterialId, createdBy]
  );

  if (rows.length > 0) return rows[0];

  // 已经有一条 pending 在等确认，直接返回它，不重复创建。
  const existing = await pool.query(
    `SELECT * FROM supplier_material_mapping
     WHERE supplier_id = $1 AND supplier_material_name = $2 AND status = 'pending'`,
    [supplierId, supplierMaterialName]
  );
  return existing.rows[0] || null;
}

// 查找某个供应商物料名称当前生效的映射（给录单工作台自动预填用）。
export async function findActiveMapping(supplierId, supplierMaterialName) {
  const { rows } = await pool.query(
    `SELECT * FROM supplier_material_mapping
     WHERE supplier_id = $1 AND supplier_material_name = $2 AND status = 'active'`,
    [supplierId, supplierMaterialName]
  );
  return rows[0] || null;
}

// 人工确认/改判。confirmedMaterialId 是用户在录单工作台上选定的最终物料。
export async function confirmMapping({ supplierId, supplierMaterialName, confirmedMaterialId, supplierMaterialCode = null }, auditContext) {
  return withTransaction(async (client) => {
    // 锁住这个 (supplier, name) 下所有相关行，避免同一时刻多个请求并发改判。
    const { rows: locked } = await client.query(
      `SELECT * FROM supplier_material_mapping
       WHERE supplier_id = $1 AND supplier_material_name = $2
         AND status IN ('pending', 'active')
       FOR UPDATE`,
      [supplierId, supplierMaterialName]
    );

    const currentActive = locked.find((row) => row.status === "active") || null;
    const pendingRows = locked.filter((row) => row.status === "pending");

    if (currentActive && currentActive.material_id === confirmedMaterialId) {
      // 用户确认的就是当前生效的映射，只是再次确认，不产生新记录，不算改判。
      const { rows: updated } = await client.query(
        `UPDATE supplier_material_mapping
         SET confirmed_count = confirmed_count + 1, last_confirmed_at = now(), updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [currentActive.id]
      );

      if (pendingRows.length > 0) {
        await client.query(
          `UPDATE supplier_material_mapping SET status = 'discarded', updated_at = now()
           WHERE id = ANY($1::int[])`,
          [pendingRows.map((r) => r.id)]
        );
      }

      return updated[0];
    }

    // 先作废旧的 active（如果有），再插入新的 active——顺序不能反，
    // 否则会瞬间出现两条 active，撞上 uq_supplier_material_mapping_active。
    if (currentActive) {
      await client.query(
        `UPDATE supplier_material_mapping SET status = 'superseded', updated_at = now()
         WHERE id = $1`,
        [currentActive.id]
      );
    }

    const { rows: inserted } = await client.query(
      `INSERT INTO supplier_material_mapping
          (supplier_id, supplier_material_name, supplier_material_code, material_id, status, confirmed_count, last_confirmed_at, created_by)
       VALUES ($1, $2, $3, $4, 'active', 1, now(), $5)
       RETURNING *`,
      [supplierId, supplierMaterialName, supplierMaterialCode, confirmedMaterialId, auditContext?.user?.name || null]
    );

    if (currentActive) {
      await client.query(
        `UPDATE supplier_material_mapping SET superseded_by_mapping_id = $1 WHERE id = $2`,
        [inserted[0].id, currentActive.id]
      );
    }

    if (pendingRows.length > 0) {
      await client.query(
        `UPDATE supplier_material_mapping SET status = 'discarded', updated_at = now()
         WHERE id = ANY($1::int[])`,
        [pendingRows.map((r) => r.id)]
      );
    }

    // 只有"从一个 active 改判到另一个 active"才算真正的改判，值得单独审计一笔；
    // 从空/pending 到第一个 active 只是正常确认，已经通过 confirm 这个 action 记录。
    await writeAuditLog(
      {
        user: auditContext?.user,
        ip: auditContext?.ip,
        userAgent: auditContext?.userAgent,
        action: currentActive ? "update" : "confirm",
        entityType: "supplier_material_mapping",
        entityId: inserted[0].id,
        beforeJson: currentActive
          ? { material_id: currentActive.material_id, mapping_id: currentActive.id }
          : null,
        afterJson: { material_id: confirmedMaterialId, mapping_id: inserted[0].id }
      },
      client
    );

    return inserted[0];
  });
}
