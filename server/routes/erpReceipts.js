import express from "express";
import { pool, withTransaction } from "../db/pool.js";
import { writeAuditLog, auditContextFromRequest } from "../services/auditService.js";

export function createErpReceiptsRouter({ requireLogin }) {
  const router = express.Router();

  router.get("/", requireLogin, async (req, res) => {
    try {
      const { supplier_id: supplierId, status } = req.query;
      const conditions = [];
      const params = [];
      if (supplierId) { params.push(supplierId); conditions.push(`supplier_id = $${params.length}`); }
      if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const { rows } = await pool.query(
        `SELECT * FROM erp_receipts ${where} ORDER BY created_at DESC LIMIT 200`,
        params
      );
      res.json({ erp_receipts: rows });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // 手工录入 ERP 入库单表头 + 明细行（这个阶段假设没有 ERP API，人工从纸质/系统截图录入）。
  router.post("/", requireLogin, async (req, res) => {
    const header = req.body.header || {};
    const lines = Array.isArray(req.body.lines) ? req.body.lines : [];

    try {
      const receipt = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO erp_receipts
             (store_id, supplier_id, erp_document_no, purchase_order_no, erp_receiving_date, document_date,
              inventory_location, movement_type, total_amount, currency, source_file_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 'AUD'), $11, 'new')
           RETURNING *`,
          [
            header.store_id || null, header.supplier_id, header.erp_document_no, header.purchase_order_no || null,
            header.erp_receiving_date || null, header.document_date || null, header.inventory_location || null,
            header.movement_type || null, header.total_amount || null, header.currency || null,
            header.source_file_id || null
          ]
        );
        const created = rows[0];

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          await client.query(
            `INSERT INTO erp_receipt_items
               (erp_receipt_id, line_no, material_id, erp_material_code, erp_material_description,
                unit, unit_description, order_quantity, received_quantity, unit_price, amount, short_text, production_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
              created.id, line.line_no ?? i + 1, line.material_id || null, line.erp_material_code || null,
              line.erp_material_description || null, line.unit || null, line.unit_description || null,
              line.order_quantity ?? null, line.received_quantity ?? null, line.unit_price ?? null,
              line.amount ?? null, line.short_text || null, line.production_date || null
            ]
          );
        }

        await writeAuditLog(
          { ...auditContextFromRequest(req), action: "create", entityType: "erp_receipt", entityId: created.id, afterJson: created },
          client
        );

        return created;
      });

      res.json({ erp_receipt: receipt });
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({ code: "DUPLICATE_ERP_DOCUMENT_NO", message: "这个供应商+入库单号已经存在，请确认是否重复录入。" });
      }
      res.status(500).json({ message: error.message });
    }
  });

  router.get("/:id", requireLogin, async (req, res) => {
    try {
      const { rows: receiptRows } = await pool.query("SELECT * FROM erp_receipts WHERE id = $1", [req.params.id]);
      if (receiptRows.length === 0) return res.status(404).json({ message: "找不到这张入库单。" });

      const { rows: items } = await pool.query(
        "SELECT * FROM erp_receipt_items WHERE erp_receipt_id = $1 ORDER BY line_no NULLS LAST, id",
        [req.params.id]
      );
      res.json({ erp_receipt: receiptRows[0], items });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  return router;
}
