import express from "express";
import multer from "multer";
import { pool, withTransaction } from "../db/pool.js";
import { storeFile } from "../storage/fileStorageService.js";
import { writeAuditLog, auditContextFromRequest } from "../services/auditService.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) return cb(Object.assign(new Error("只支持 PDF / JPEG / PNG / WEBP 格式。"), { statusCode: 400 }));
    cb(null, true);
  }
});

export function createStatementsRouter({ requireLogin }) {
  const router = express.Router();

  router.get("/", requireLogin, async (req, res) => {
    try {
      const { supplier_id: supplierId } = req.query;
      const conditions = [];
      const params = [];
      if (supplierId) { params.push(supplierId); conditions.push(`supplier_id = $${params.length}`); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const { rows } = await pool.query(
        `SELECT * FROM supplier_statements ${where} ORDER BY created_at DESC LIMIT 200`,
        params
      );
      res.json({ statements: rows });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // statement_date 在上传时通常还不知道（跟 invoice_no 一样要等解析），
  // 所以幂等判断不能只靠 (supplier_id, statement_date, source_file_id) 这个唯一约束——
  // 两条 statement_date 都是 NULL 的行，在 SQL 里不会被当成"相同"而拦下来。
  // 这里改成上传时先查"这个文件（source_file_id）是否已经建过 statement"，同一文件重复上传直接复用旧记录。
  router.post("/upload", requireLogin, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "没有收到文件。" });
      const supplierId = req.body.supplier_id;
      if (!supplierId) return res.status(400).json({ message: "缺少 supplier_id。" });

      const { file: sourceFile, reused: fileReused } = await storeFile(req.file.buffer, {
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        uploadedBy: req.user.name
      });

      const { rows: existingStatements } = await pool.query(
        "SELECT * FROM supplier_statements WHERE source_file_id = $1",
        [sourceFile.id]
      );
      if (existingStatements.length > 0) {
        return res.json({ statement: existingStatements[0], source_file: sourceFile, file_reused: true, statement_reused: true });
      }

      const statement = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO supplier_statements (supplier_id, statement_date, status, source_file_id)
           VALUES ($1, NULL, 'new', $2)
           RETURNING *`,
          [supplierId, sourceFile.id]
        );
        const created = rows[0];

        await writeAuditLog(
          { ...auditContextFromRequest(req), action: "create", entityType: "supplier_statement", entityId: created.id, afterJson: created },
          client
        );

        return created;
      });

      res.json({ statement, source_file: sourceFile, file_reused: fileReused, statement_reused: false });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.get("/:id", requireLogin, async (req, res) => {
    try {
      const { rows: statementRows } = await pool.query("SELECT * FROM supplier_statements WHERE id = $1", [req.params.id]);
      if (statementRows.length === 0) return res.status(404).json({ message: "找不到这份对账单。" });

      const { rows: items } = await pool.query(
        "SELECT * FROM supplier_statement_items WHERE statement_id = $1 ORDER BY transaction_date NULLS LAST, id",
        [req.params.id]
      );
      res.json({ statement: statementRows[0], items });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.post("/:id/fields", requireLogin, async (req, res) => {
    const { statement_date: statementDate, account_no: accountNo, total_balance: totalBalance } = req.body;

    try {
      const statement = await withTransaction(async (client) => {
        const { rows: existingRows } = await client.query(
          "SELECT * FROM supplier_statements WHERE id = $1 FOR UPDATE",
          [req.params.id]
        );
        if (existingRows.length === 0) return null;
        const before = existingRows[0];

        const { rows: updatedRows } = await client.query(
          `UPDATE supplier_statements SET
             statement_date = COALESCE($1, statement_date),
             account_no = COALESCE($2, account_no),
             total_balance = COALESCE($3, total_balance),
             status = CASE WHEN status = 'new' THEN 'parsed' ELSE status END,
             updated_at = now()
           WHERE id = $4
           RETURNING *`,
          [statementDate, accountNo, totalBalance, req.params.id]
        );

        await writeAuditLog(
          { ...auditContextFromRequest(req), action: "update", entityType: "supplier_statement", entityId: before.id, beforeJson: before, afterJson: updatedRows[0] },
          client
        );

        return updatedRows[0];
      });

      if (!statement) return res.status(404).json({ message: "找不到这份对账单。" });
      res.json({ statement });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // Statement 明细：running balance、跟 Invoice/Credit 的关联(matched_invoice_id/matched_credit_id)
  // 现阶段由人工在录单工作台里逐行核对后填入，不做自动匹配。
  router.put("/:id/items", requireLogin, async (req, res) => {
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    try {
      await withTransaction(async (client) => {
        await client.query("DELETE FROM supplier_statement_items WHERE statement_id = $1", [req.params.id]);

        for (const item of items) {
          await client.query(
            `INSERT INTO supplier_statement_items
               (statement_id, transaction_date, reference, transaction_type, amount, running_balance, due_date, matched_invoice_id, matched_credit_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              req.params.id, item.transaction_date || null, item.reference || null, item.transaction_type || null,
              item.amount ?? null, item.running_balance ?? null, item.due_date || null,
              item.matched_invoice_id || null, item.matched_credit_id || null
            ]
          );
        }

        await writeAuditLog(
          { ...auditContextFromRequest(req), action: "update", entityType: "supplier_statement", entityId: req.params.id, afterJson: { item_count: items.length } },
          client
        );
      });

      const { rows } = await pool.query(
        "SELECT * FROM supplier_statement_items WHERE statement_id = $1 ORDER BY transaction_date NULLS LAST, id",
        [req.params.id]
      );
      res.json({ items: rows });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  return router;
}
