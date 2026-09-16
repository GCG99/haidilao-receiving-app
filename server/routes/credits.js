import express from "express";
import multer from "multer";
import { pool, withTransaction } from "../db/pool.js";
import { storeFile, getFileById, getFileBuffer } from "../storage/fileStorageService.js";
import { writeAuditLog, auditContextFromRequest } from "../services/auditService.js";
import { updateCreditFields, markCreditParseFailed } from "../services/creditService.js";
import { parseCreditDocument, isOcrConfigured } from "../services/ocrParsingService.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) return cb(new Error("只支持 PDF / JPEG / PNG / WEBP 格式。"));
    cb(null, true);
  }
});

export function createCreditsRouter({ requireLogin }) {
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
        `SELECT * FROM credits ${where} ORDER BY created_at DESC LIMIT 200`,
        params
      );
      res.json({ credits: rows });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // 来源：邮箱自动发现（未来）或微信手动上传（现在）。这里先只做手动上传这一条路径。
  router.post("/upload", requireLogin, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: "没有收到文件。" });
      const supplierId = req.body.supplier_id;
      if (!supplierId) return res.status(400).json({ message: "缺少 supplier_id。" });

      const { file: sourceFile, reused } = await storeFile(req.file.buffer, {
        fileName: req.file.originalname,
        mimeType: req.file.mimetype,
        uploadedBy: req.user.name
      });

      const credit = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `INSERT INTO credits (supplier_id, credit_note_no, status, source, source_file_id)
           VALUES ($1, NULL, 'new', 'wechat_manual_upload', $2)
           RETURNING *`,
          [supplierId, sourceFile.id]
        );
        const created = rows[0];

        await writeAuditLog(
          { ...auditContextFromRequest(req), action: "create", entityType: "credit", entityId: created.id, afterJson: created },
          client
        );

        return created;
      });

      res.json({ credit, source_file: sourceFile, file_reused: reused });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.get("/:id", requireLogin, async (req, res) => {
    try {
      const { rows } = await pool.query("SELECT * FROM credits WHERE id = $1", [req.params.id]);
      if (rows.length === 0) return res.status(404).json({ message: "找不到这条 Credit。" });
      res.json({ credit: rows[0] });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // 人工确认识别出来的字段（Credit 不强制要求 invoice_id，可能只有 docket/statement 关联）。
  router.post("/:id/confirm", requireLogin, async (req, res) => {
    const { credit_note_no: creditNoteNo, credit_date: creditDate, invoice_id: invoiceId,
      delivery_docket_no: docketNo, receiving_record_id: receivingRecordId, reason, total_amount: totalAmount } = req.body;

    try {
      const result = await withTransaction((client) => updateCreditFields(
        client,
        req.params.id,
        { credit_note_no: creditNoteNo, credit_date: creditDate, invoice_id: invoiceId,
          delivery_docket_no: docketNo, receiving_record_id: receivingRecordId, reason, total_amount: totalAmount },
        auditContextFromRequest(req)
      ));

      if (result.conflict) {
        return res.status(409).json({
          code: "DUPLICATE_CREDIT_NO",
          message: "这个供应商+Credit号已经存在，请确认是否重复上传。",
          existing_credit_id: result.conflict.id
        });
      }
      if (result.notFound) return res.status(404).json({ message: "找不到这条 Credit。" });

      res.json({ credit: result.credit });
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({ code: "DUPLICATE_CREDIT_NO", message: "Credit 号冲突，请人工确认。" });
      }
      res.status(500).json({ message: error.message });
    }
  });

  // OCR自动路径：解析上传时存的文件，写入逻辑跟人工 /confirm 共用同一个 updateCreditFields。
  router.post("/:id/parse", requireLogin, async (req, res) => {
    if (!isOcrConfigured()) {
      return res.status(503).json({
        code: "OCR_NOT_CONFIGURED",
        message: "OCR解析功能需要配置 ANTHROPIC_API_KEY，当前未配置。可以走人工录入(/confirm)。"
      });
    }

    const auditContext = auditContextFromRequest(req);

    try {
      const { rows: creditRows } = await pool.query("SELECT * FROM credits WHERE id = $1", [req.params.id]);
      if (creditRows.length === 0) return res.status(404).json({ message: "找不到这条 Credit。" });
      const credit = creditRows[0];
      if (!credit.source_file_id) {
        return res.status(400).json({ message: "这条 Credit 没有关联的源文件，没法解析。" });
      }

      const sourceFile = await getFileById(credit.source_file_id);
      const buffer = await getFileBuffer(sourceFile);

      let parsed;
      try {
        parsed = await parseCreditDocument(buffer, sourceFile.mime_type);
      } catch (parseError) {
        const failResult = await withTransaction((client) => markCreditParseFailed(client, req.params.id, parseError.message, auditContext));
        return res.status(502).json({
          code: "OCR_CALL_FAILED",
          message: `调用OCR解析失败：${parseError.message}`,
          credit: failResult.credit
        });
      }

      if (!parsed.is_invoice) {
        const failResult = await withTransaction((client) => markCreditParseFailed(client, req.params.id, parsed.notes, auditContext));
        return res.status(422).json({
          code: "NOT_A_CREDIT_NOTE",
          message: "模型判断这份文件不像是一张Credit Note，请人工核实。",
          notes: parsed.notes,
          credit: failResult.credit
        });
      }

      const result = await withTransaction((client) => updateCreditFields(
        client,
        req.params.id,
        {
          credit_note_no: parsed.header.credit_note_no, credit_date: parsed.header.credit_date,
          delivery_docket_no: parsed.header.delivery_docket_no, reason: parsed.header.reason,
          total_amount: parsed.header.total_amount
        },
        auditContext
      ));

      if (result.conflict) {
        return res.status(409).json({
          code: "DUPLICATE_CREDIT_NO",
          message: "OCR识别出的Credit号跟已有记录冲突，请人工确认是否重复上传。",
          existing_credit_id: result.conflict.id
        });
      }
      if (result.notFound) return res.status(404).json({ message: "找不到这条 Credit。" });

      res.json({ credit: result.credit, ocr_notes: parsed.notes, source_quotes: parsed.header.source_quotes || null });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // 人工在海底捞 ERP 里手动录入这条 Credit 之后，回来标记"已录入"——系统从不自动操作 ERP。
  router.post("/:id/mark-entered", requireLogin, async (req, res) => {
    try {
      const credit = await withTransaction(async (client) => {
        const { rows } = await client.query(
          `UPDATE credits SET status = 'entered_to_erp', entered_to_erp_at = now(), entered_to_erp_by = $1, updated_at = now()
           WHERE id = $2 RETURNING *`,
          [req.user.name, req.params.id]
        );
        if (rows.length === 0) return null;

        await writeAuditLog(
          { ...auditContextFromRequest(req), action: "enter_erp", entityType: "credit", entityId: req.params.id, afterJson: rows[0] },
          client
        );

        return rows[0];
      });

      if (!credit) return res.status(404).json({ message: "找不到这条 Credit。" });
      res.json({ credit });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  return router;
}
