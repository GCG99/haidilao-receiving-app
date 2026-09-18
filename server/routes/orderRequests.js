// 叫货记录：用户确认"全部都是我叫货了才送"——每次给供应商打电话/下单叫货时记一笔，
// 没有供应商确认/审批这种正式PO环节，不建状态机。主要价值是到货后能核对"叫的和到的
// 是否一致"，不是走审批流程。见 P2_设计文档/线A线B整合规划.md 第二节。
import express from "express";
import { pool, withTransaction } from "../db/pool.js";
import { writeAuditLog, auditContextFromRequest } from "../services/auditService.js";

export function createOrderRequestsRouter({ requireLogin }) {
  const router = express.Router();

  router.get("/", requireLogin, async (req, res) => {
    try {
      const { supplier_id: supplierId, from, to } = req.query;
      const conditions = [];
      const params = [];
      if (supplierId) { params.push(supplierId); conditions.push(`supplier_id = $${params.length}`); }
      if (from) { params.push(from); conditions.push(`order_date >= $${params.length}`); }
      if (to) { params.push(to); conditions.push(`order_date <= $${params.length}`); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const { rows } = await pool.query(
        `SELECT r.*, s.name AS supplier_name,
                (SELECT COUNT(*) FROM order_request_items WHERE order_request_id = r.id) AS item_count
         FROM order_requests r
         JOIN suppliers s ON s.id = r.supplier_id
         ${where}
         ORDER BY r.order_date DESC, r.id DESC LIMIT 200`,
        params
      );
      res.json({ order_requests: rows });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.post("/", requireLogin, async (req, res) => {
    const { order_date: orderDate, supplier_id: supplierId, note } = req.body;
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    if (!orderDate || !supplierId) {
      return res.status(400).json({ message: "order_date 和 supplier_id 必填。" });
    }
    if (items.length === 0) {
      return res.status(400).json({ message: "至少要有一条叫货明细。" });
    }
    for (const it of items) {
      if (!(it.ordered_quantity > 0)) {
        return res.status(400).json({ message: "每条明细的 ordered_quantity 必须大于0。" });
      }
    }

    try {
      const created = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO order_requests (order_date, supplier_id, note, created_by)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [orderDate, supplierId, note || null, req.user?.name || null]
        );
        const orderRequest = rows[0];

        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          await client.query(
            `INSERT INTO order_request_items
               (order_request_id, material_id, supplier_material_name, ordered_quantity, unit, note)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [orderRequest.id, it.material_id || null, it.supplier_material_name || null,
             it.ordered_quantity, it.unit || null, it.note || null]
          );
        }

        await writeAuditLog(
          { ...auditContextFromRequest(req), action: "create", entityType: "order_request", entityId: orderRequest.id, afterJson: orderRequest },
          client
        );

        return orderRequest;
      });

      res.json({ order_request: created });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.get("/:id", requireLogin, async (req, res) => {
    try {
      const { rows: reqRows } = await pool.query(
        `SELECT r.*, s.name AS supplier_name FROM order_requests r
         JOIN suppliers s ON s.id = r.supplier_id WHERE r.id = $1`,
        [req.params.id]
      );
      if (reqRows.length === 0) return res.status(404).json({ message: "找不到这条叫货记录。" });

      const { rows: items } = await pool.query(
        `SELECT i.*, m.name AS material_name FROM order_request_items i
         LEFT JOIN materials m ON m.sku = i.material_id
         WHERE i.order_request_id = $1 ORDER BY i.id`,
        [req.params.id]
      );
      res.json({ order_request: reqRows[0], items });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  return router;
}
