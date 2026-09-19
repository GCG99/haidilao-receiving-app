import express from "express";
import multer from "multer";
import { pool, withTransaction } from "../db/pool.js";
import { storeFile, getFileById, getFileBuffer } from "../storage/fileStorageService.js";
import { writeAuditLog, auditContextFromRequest } from "../services/auditService.js";
import { suggestMatchesForInvoice } from "../services/matchingService.js";
import {
  updateInvoiceFields,
  replaceInvoiceItems,
  markInvoiceParseFailed,
  checkInvoiceConsistency
} from "../services/invoiceService.js";
import { parseInvoiceDocument, isOcrConfigured } from "../services/ocrParsingService.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.mimetype)) {
      return cb(Object.assign(new Error("只支持 PDF / JPEG / PNG / WEBP 格式。"), { statusCode: 400 }));
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

  // Step 3（识别，OCR自动路径）：拿视觉LLM解析上传时存的文件，解析结果走跟人工回填(/fields、/items)
  // 同一段共享写入逻辑。跟upload分两步、不阻塞上传本身的响应（第6轮ChatGPT复核方向）。
  router.post("/:id/parse", requireLogin, async (req, res) => {
    if (!isOcrConfigured()) {
      return res.status(503).json({
        code: "OCR_NOT_CONFIGURED",
        message: "OCR解析功能需要配置 ANTHROPIC_API_KEY，当前未配置。可以走人工录入(/fields、/items)。"
      });
    }

    const auditContext = auditContextFromRequest(req);

    try {
      const { rows: invoiceRows } = await pool.query("SELECT * FROM invoices WHERE id = $1", [req.params.id]);
      if (invoiceRows.length === 0) {
        return res.status(404).json({ message: "找不到这张发票。" });
      }
      const invoice = invoiceRows[0];
      if (!invoice.source_file_id) {
        return res.status(400).json({ message: "这张发票没有关联的源文件，没法解析。" });
      }

      const sourceFile = await getFileById(invoice.source_file_id);
      const buffer = await getFileBuffer(sourceFile);

      let parsed;
      try {
        parsed = await parseInvoiceDocument(buffer, sourceFile.mime_type);
      } catch (parseError) {
        // 调用失败（超时/限流/服务不可用）：第9轮结论，不做自动重试，标记异常状态让人工点按钮重试。
        const failResult = await withTransaction((client) => markInvoiceParseFailed(client, req.params.id, parseError.message, auditContext));
        return res.status(502).json({
          code: "OCR_CALL_FAILED",
          message: `调用OCR解析失败：${parseError.message}`,
          invoice: failResult.invoice
        });
      }

      if (!parsed.is_invoice) {
        const failResult = await withTransaction((client) => markInvoiceParseFailed(client, req.params.id, parsed.notes, auditContext));
        return res.status(422).json({
          code: "NOT_AN_INVOICE",
          message: "模型判断这份文件不像是一张发票，请人工核实。",
          notes: parsed.notes,
          invoice: failResult.invoice
        });
      }

      const warnings = checkInvoiceConsistency(parsed.header);

      const result = await withTransaction(async (client) => {
        const fieldsResult = await updateInvoiceFields(
          client,
          req.params.id,
          {
            invoice_no: parsed.header.invoice_no, invoice_date: parsed.header.invoice_date,
            due_date: parsed.header.due_date, invoice_type: parsed.header.invoice_type,
            currency: parsed.header.currency, subtotal: parsed.header.subtotal, gst: parsed.header.gst,
            total_amount: parsed.header.total_amount, ocr_confidence: parsed.header.confidence,
            parser_version: "claude-sonnet-5",
            ocr_raw_response: parsed
          },
          auditContext
        );
        if (fieldsResult.conflict || fieldsResult.notFound) {
          return fieldsResult;
        }

        const itemsResult = await replaceInvoiceItems(
          client,
          req.params.id,
          (parsed.items || []).map((item) => ({ ...item, ocr_line_confidence: item.confidence ?? null })),
          auditContext
        );

        return { invoice: fieldsResult.invoice, items: itemsResult.items };
      });

      if (result.conflict) {
        return res.status(409).json({
          code: "DUPLICATE_INVOICE_NO",
          message: "OCR识别出的发票号跟已有发票冲突，请人工确认是否重复上传。",
          existing_invoice: result.conflict
        });
      }
      if (result.notFound) {
        return res.status(404).json({ message: "找不到这张发票。" });
      }

      res.json({
        invoice: result.invoice,
        items: result.items,
        warnings,
        ocr_notes: parsed.notes,
        source_quotes: { header: parsed.header.source_quotes || null }
      });
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
      const result = await withTransaction((client) => updateInvoiceFields(
        client,
        req.params.id,
        { invoice_no: invoiceNo, invoice_date: invoiceDate, due_date: dueDate, invoice_type: invoiceType,
          currency, subtotal, gst, total_amount: totalAmount, ocr_confidence: ocrConfidence, parser_version: parserVersion },
        auditContextFromRequest(req)
      ));

      if (result.conflict) {
        return res.status(409).json({
          code: "DUPLICATE_INVOICE_NO",
          message: "这个供应商+发票号已经存在，请确认是重复上传还是需要修正发票号。",
          existing_invoice: result.conflict
        });
      }
      if (result.notFound) {
        return res.status(404).json({ message: "找不到这张发票。" });
      }

      res.json({ invoice: result.invoice });
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
      const result = await withTransaction((client) => replaceInvoiceItems(
        client,
        req.params.id,
        items,
        auditContextFromRequest(req)
      ));

      if (result.notFound) {
        return res.status(404).json({ message: "找不到这张发票。" });
      }

      res.json({ items: result.items });
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
