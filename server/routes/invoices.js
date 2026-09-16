import express from "express";
import multer from "multer";
import { pool, withTransaction } from "../db/pool.js";
import { storeFile } from "../storage/fileStorageService.js";
import { writeAuditLog, auditContextFromRequest } from "../services/auditService.js";
import { suggestMatchesForInvoice } from "../services/matchingService.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("只支持 PDF / JPEG / PNG / WEBP 格式。"));
    }
    cb(null, true);
  }
});

export function createInvoicesRouter({ requireLogin }) {
  const router = express.Router();

  router.get("/", requireLogin, async (req, res) => {
    try {
      const { status, supplier_id: supplierId } = req.query;
      const conditions = [];
      const params = [];

      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
      if (supplierId) {
        params.push(supplierId);
        conditions.push(`supplier_id = $${params.length}`);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const { rows } = await pool.query(
        `SELECT * FROM invoices ${where} ORDER BY created_at DESC LIMIT 200`,
        params
      );

      res.json({ invoices: rows });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Step 2（来源）：上传 Invoice 原始文件，先不知道 invoice_no，status=new。
  router.post("/upload", requireLogin, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "没有收到文件。" });
      }
      const supplierId = req.body.supplier_id;
      if (!supplierId) {
        return res.status(400).json({ message: "缺少 supplier_id。" });
      }

      const { file: sourceFile, reused } = await storeFile(req.file.buffer, {
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        uploadedBy: req.user.name
      });

      const invoice = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO invoices (supplier_id, invoice_no, status, source, source_file_id)
           VALUES ($1, NULL, 'new', 'upload', $2)
           RETURNING *`,
          [supplierId, sourceFile.id]
        );
        const created = rows[0];

        await writeAuditLog(
          {
            ...auditContextFromRequest(req),
            action: "create",
            entityType: "invoice",
            entityId: created.id,
            afterJson: created
          },
          client
        );

        return created;
      });

      res.json({ invoice, source_file: sourceFile, file_reused: reused });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.get("/:id", requireLogin, async (req, res) => {
    try {
      const { rows: invoiceRows } = await pool.query(
        "SELECT * FROM invoices WHERE id = $1",
        [req.params.id]
      );
      if (invoiceRows.length === 0) {
        return res.status(404).json({ message: "找不到这张发票。" });
      }
      const { rows: items } = await pool.query(
        "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY line_no NULLS LAST, id",
        [req.params.id]
      );
      const { rows: receivingLinks } = await pool.query(
        "SELECT * FROM invoice_receiving_links WHERE invoice_id = $1",
        [req.params.id]
      );
      const { rows: erpLinks } = await pool.query(
        "SELECT * FROM invoice_erp_receipt_links WHERE invoice_id = $1",
        [req.params.id]
      );

      res.json({ invoice: invoiceRows[0], items, receiving_links: receivingLinks, erp_receipt_links: erpLinks });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Step 3（识别）：人工或 OCR/解析结果回填表头字段。这个阶段第一次真正确定 invoice_no，
  // 是唯一约束 (supplier_id, invoice_no) 会被触发的地方——因此不能让它变成一个用户看不懂的 500。
  router.post("/:id/fields", requireLogin, async (req, res) => {
    const { invoice_no: invoiceNo, invoice_date: invoiceDate, due_date: dueDate,
      invoice_type: invoiceType, currency, subtotal, gst, total_amount: totalAmount,
      ocr_confidence: ocrConfidence, parser_version: parserVersion } = req.body;

    try {
      let conflict = null;

      const updated = await withTransaction(async (client) => {
        const { rows: existingRows } = await client.query(
          "SELECT * FROM invoices WHERE id = $1 FOR UPDATE",
          [req.params.id]
        );
        if (existingRows.length === 0) {
          return null;
        }
        const before = existingRows[0];

        if (invoiceNo) {
          const { rows: conflictRows } = await client.query(
            "SELECT * FROM invoices WHERE supplier_id = $1 AND invoice_no = $2 AND id <> $3",
            [before.supplier_id, invoiceNo, before.id]
          );
          if (conflictRows.length > 0) {
            // 按第7轮讨论：不静默吞掉、也不直接500——把已存在的那张发票原样返回，
            // 由前端提示"检测到可能重复"，让人工确认是重复上传还是需要修正单号。
            conflict = conflictRows[0];
            return null;
          }
        }

        const { rows: updatedRows } = await client.query(
          `UPDATE invoices SET
             invoice_no = COALESCE($1, invoice_no),
             invoice_date = COALESCE($2, invoice_date),
             due_date = COALESCE($3, due_date),
             invoice_type = COALESCE($4, invoice_type),
             currency = COALESCE($5, currency),
             subtotal = COALESCE($6, subtotal),
             gst = COALESCE($7, gst),
             total_amount = COALESCE($8, total_amount),
             ocr_confidence = COALESCE($9, ocr_confidence),
             parser_version = COALESCE($10, parser_version),
             status = CASE WHEN status = 'new' THEN 'parsed' ELSE status END,
             updated_at = now()
           WHERE id = $11
           RETURNING *`,
          [invoiceNo, invoiceDate, dueDate, invoiceType, currency, subtotal, gst, totalAmount, ocrConfidence, parserVersion, req.params.id]
        );

        await writeAuditLog(
          {
            ...auditContextFromRequest(req),
            action: "update",
            entityType: "invoice",
            entityId: before.id,
            beforeJson: before,
            afterJson: updatedRows[0]
          },
          client
        );

        return updatedRows[0];
      });

      if (conflict) {
        return res.status(409).json({
          code: "DUPLICATE_INVOICE_NO",
          message: "这个供应商+发票号已经存在，请确认是重复上传还是需要修正发票号。",
          existing_invoice: conflict
        });
      }
      if (!updated) {
        return res.status(404).json({ message: "找不到这张发票。" });
      }

      res.json({ invoice: updated });
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({ code: "DUPLICATE_INVOICE_NO", message: "发票号冲突，请人工确认。" });
      }
      res.status(500).json({ message: error.message });
    }
  });

  // 录单工作台的 spreadsheet 表格：整体替换这张发票的明细行。
  // 第3轮ChatGPT复核结论：明细行全量替换属于关键数据操作，之前漏写了审计日志
  // （跟 statements.js 的同类路由不一致），也没有先确认发票存在就返回404——补齐这两点。
  router.put("/:id/items", requireLogin, async (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    try {
      const notFound = await withTransaction(async (client) => {
        const { rows: invoiceRows } = await client.query(
          "SELECT id FROM invoices WHERE id = $1 FOR UPDATE",
          [req.params.id]
        );
        if (invoiceRows.length === 0) return true;

        await client.query("DELETE FROM invoice_items WHERE invoice_id = $1", [req.params.id]);

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          await client.query(
            `INSERT INTO invoice_items
               (invoice_id, line_no, supplier_item_name, supplier_item_code, description, material_id,
                quantity, unit, unit_price, amount, gst_rate, gst_amount, delivery_docket_no, purchase_order_no,
                match_status, match_confidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
            [
              req.params.id, item.line_no ?? i + 1, item.supplier_item_name || null, item.supplier_item_code || null,
              item.description || null, item.material_id || null, item.quantity ?? null, item.unit || null,
              item.unit_price ?? null, item.amount ?? null, item.gst_rate ?? null, item.gst_amount ?? null,
              item.delivery_docket_no || null, item.purchase_order_no || null,
              item.material_id ? "matched" : "unmatched", item.match_confidence ?? null
            ]
          );
        }

        await writeAuditLog(
          {
            ...auditContextFromRequest(req),
            action: "update",
            entityType: "invoice_items",
            entityId: req.params.id,
            afterJson: { item_count: items.length }
          },
          client
        );

        return false;
      });

      if (notFound) {
        return res.status(404).json({ message: "找不到这张发票。" });
      }

      const { rows } = await pool.query(
        "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY line_no NULLS LAST, id",
        [req.params.id]
      );
      res.json({ items: rows });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // 只返回排序后的候选，不落库——人工确认后前端再调 /confirm-match。
  router.post("/:id/match", requireLogin, async (req, res) => {
    try {
      const suggestions = await suggestMatchesForInvoice(req.params.id);
      if (!suggestions) {
        return res.status(404).json({ message: "找不到这张发票。" });
      }
      res.json(suggestions);
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // 人工确认某个候选，写入关联表 + 审计日志。
  router.post("/:id/confirm-match", requireLogin, async (req, res) => {
    const { receiving_record_id: receivingRecordId, erp_receipt_id: erpReceiptId, matched_amount: matchedAmount } = req.body;

    try {
      await withTransaction(async (client) => {
        if (receivingRecordId) {
          await client.query(
            `INSERT INTO invoice_receiving_links (invoice_id, receiving_record_id, matched_amount)
             VALUES ($1, $2, $3)
             ON CONFLICT (invoice_id, receiving_record_id) DO NOTHING`,
            [req.params.id, receivingRecordId, matchedAmount || null]
          );
        }
        if (erpReceiptId) {
          await client.query(
            `INSERT INTO invoice_erp_receipt_links (invoice_id, erp_receipt_id, matched_amount)
             VALUES ($1, $2, $3)
             ON CONFLICT (invoice_id, erp_receipt_id) DO NOTHING`,
            [req.params.id, erpReceiptId, matchedAmount || null]
          );
        }
        await client.query(
          `UPDATE invoices SET status = 'matched', updated_at = now() WHERE id = $1 AND status IN ('parsed', 'pending_match', 'discrepancy')`,
          [req.params.id]
        );
        await writeAuditLog(
          {
            ...auditContextFromRequest(req),
            action: "match",
            entityType: "invoice",
            entityId: req.params.id,
            afterJson: { receiving_record_id: receivingRecordId || null, erp_receipt_id: erpReceiptId || null }
          },
          client
        );
      });

      res.json({ ok: true });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.post("/:id/confirm", requireLogin, async (req, res) => {
    try {
      const invoice = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `UPDATE invoices SET status = 'confirmed', updated_at = now() WHERE id = $1 RETURNING *`,
          [req.params.id]
        );
        if (rows.length === 0) return null;

        await writeAuditLog(
          {
            ...auditContextFromRequest(req),
            action: "confirm",
            entityType: "invoice",
            entityId: req.params.id,
            afterJson: rows[0]
          },
          client
        );

        return rows[0];
      });

      if (!invoice) {
        return res.status(404).json({ message: "找不到这张发票。" });
      }
      res.json({ invoice });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  return router;
}
