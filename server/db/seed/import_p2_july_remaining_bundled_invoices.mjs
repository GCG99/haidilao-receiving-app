// P2历史数据清洗：修复原7月OCR批次(25个供应商，除SKYJ/CFC外)全部存在的同一类问题——
// 每个供应商的"XX 7月 Invoice.pdf"几乎都是把整月多张独立发票(部分还混了Credit Note)
// 扫描粘在一个PDF里，原批次脚本对着这种文件只识别出第一张单据的内容，把文件里其余单据
// 当成看不懂的内容默默忽略，不报错也不进pending——SKYJ/CFC是这个问题第一次被发现的地方
// (见import_p2_july_bundled_invoices_split.mjs)，这次系统性核查全部23个供应商文件后
// (Liquorland/福嘉本来就是1页，不受影响)，确认另外21个供应商同样受影响，共150份单据。
//
// 流程：用一次Claude API多页PDF理解调用识别每个文件的页面边界(scratchpad/build_master_manifest.py
// 的输入all_boundaries.json)，pymupdf按边界拆成150份子PDF，本脚本对每份子PDF复用
// parseInvoiceDocument/parseCreditDocument，按(supplier_id,invoice_no)去重后插入——
// 原批次已经成功捕获的那一张（通常是文件里第1张）会被去重逻辑正确跳过，不会重复插入。
//
// 依赖scratchpad临时目录的manifest.json+150份子PDF，这些不进git，本脚本是这次修复的历史记录，
// 不是可重复执行的通用工具（跟import_p2_july_bundled_invoices_split.mjs同样的性质）。
import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pool } from "../pool.js";
import { parseInvoiceDocument, parseCreditDocument, isOcrConfigured } from "../../services/ocrParsingService.js";

const MANIFEST_PATH =
  "C:\\Users\\18426\\AppData\\Local\\Temp\\claude\\C--Users-18426-Desktop---\\e05e78aa-5762-4e61-8148-a9d172c772a5\\scratchpad\\split_pdfs2\\manifest.json";

function sha256File(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function getOrCreateSourceFile(client, filePath, buf, mimeType) {
  const sha256 = sha256File(buf);
  const existing = await client.query("SELECT id FROM source_files WHERE sha256 = $1", [sha256]);
  if (existing.rows.length > 0) return { id: existing.rows[0].id, reused: true };
  const { rows } = await client.query(
    `INSERT INTO source_files (file_name, mime_type, storage_provider, storage_path, uploaded_by, sha256)
     VALUES ($1,$2,'local',$3,'p2_historical_import',$4) RETURNING id`,
    [path.basename(filePath), mimeType, filePath, sha256]
  );
  return { id: rows[0].id, reused: false };
}

async function findSupplierExact(client, candidateName) {
  const { rows } = await client.query("SELECT id, name FROM suppliers WHERE name = $1", [candidateName]);
  return rows[0] || null;
}

async function main() {
  if (!isOcrConfigured()) {
    console.error("ANTHROPIC_API_KEY 未配置，无法OCR。中止。");
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
  console.log(`读取到 ${manifest.length} 份子文档待处理`);

  const client = await pool.connect();
  const results = { invoices_success: [], credits_success: [], skipped_duplicate: [], pending: [], failed: [] };

  try {
    for (const [idx, doc] of manifest.entries()) {
      console.log(`\n[${idx + 1}/${manifest.length}] --- ${doc.supplier_folder} ${doc.doc_no} (${doc.doc_type}) ---`);
      const supplier = await findSupplierExact(client, doc.supplier_folder);
      if (!supplier) {
        console.log(`  [pending] 供应商文件夹名"${doc.supplier_folder}"在suppliers表无精确匹配`);
        results.pending.push({ reason: "supplier_no_exact_match", ...doc });
        continue;
      }

      const buf = fs.readFileSync(doc.split_path);

      if (doc.doc_type === "tax_invoice") {
        let parsed;
        try {
          parsed = await parseInvoiceDocument(buf, "application/pdf");
        } catch (err) {
          console.log(`  [failed] OCR调用失败: ${err.message}`);
          results.failed.push({ ...doc, error: err.message });
          continue;
        }
        if (!parsed.is_invoice) {
          console.log(`  [pending] 模型判定不是发票: ${parsed.notes || "(无说明)"}`);
          results.pending.push({ reason: "not_recognized_as_invoice", ...doc, notes: parsed.notes });
          continue;
        }
        const header = parsed.header || {};
        if (!header.invoice_no) {
          console.log(`  [pending] 识别不到发票号`);
          results.pending.push({ reason: "no_invoice_no", ...doc, header });
          continue;
        }

        await client.query("BEGIN");
        try {
          const dup = await client.query(
            "SELECT id FROM invoices WHERE supplier_id=$1 AND invoice_no=$2",
            [supplier.id, header.invoice_no]
          );
          if (dup.rows.length > 0) {
            console.log(`  [skip] (supplier_id,invoice_no) 已存在(id=${dup.rows[0].id})`);
            await client.query("ROLLBACK");
            results.skipped_duplicate.push({ ...doc, existingId: dup.rows[0].id });
            continue;
          }

          const { id: sourceFileId } = await getOrCreateSourceFile(client, doc.split_path, buf, "application/pdf");
          const { rows: invRows } = await client.query(
            `INSERT INTO invoices
               (supplier_id, invoice_no, invoice_date, due_date, invoice_type, currency,
                subtotal, gst, total_amount, source, source_file_id, status, ocr_confidence, parser_version)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'p2_historical_ocr',$10,'parsed',$11,'claude-sonnet-5-p2-batch-split-full')
             RETURNING id`,
            [
              supplier.id, header.invoice_no, header.invoice_date || null, header.due_date || null,
              header.invoice_type || null, header.currency || "AUD",
              header.subtotal ?? null, header.gst ?? null, header.total_amount ?? null,
              sourceFileId, header.confidence ?? null
            ]
          );
          const invoiceId = invRows[0].id;

          const items = Array.isArray(parsed.items) ? parsed.items : [];
          for (let i = 0; i < items.length; i++) {
            const it = items[i];
            await client.query(
              `INSERT INTO invoice_items
                 (invoice_id, line_no, supplier_item_name, description, quantity, unit, unit_price,
                  amount, gst_rate, delivery_docket_no, purchase_order_no, match_status, ocr_line_confidence)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'unmatched',$12)`,
              [
                invoiceId, it.line_no ?? i + 1, it.supplier_item_name || null, it.description || null,
                it.quantity ?? null, it.unit || null, it.unit_price ?? null, it.amount ?? null,
                it.gst_rate ?? null, it.delivery_docket_no || null, it.purchase_order_no || null,
                it.confidence ?? null
              ]
            );
          }
          await client.query("COMMIT");
          console.log(`  [success] invoice id=${invoiceId}, total=${header.total_amount}, items=${items.length}`);
          results.invoices_success.push({ ...doc, invoiceId, totalAmount: header.total_amount, itemCount: items.length });
        } catch (err) {
          await client.query("ROLLBACK");
          console.log(`  [failed] 写入DB出错: ${err.message}`);
          results.failed.push({ ...doc, error: err.message });
        }
      } else if (doc.doc_type === "adjustment_credit_note") {
        let parsed;
        try {
          parsed = await parseCreditDocument(buf, "application/pdf");
        } catch (err) {
          console.log(`  [failed] OCR调用失败: ${err.message}`);
          results.failed.push({ ...doc, error: err.message });
          continue;
        }
        if (!parsed.is_invoice) {
          console.log(`  [pending] 模型判定不是Credit Note: ${parsed.notes || "(无说明)"}`);
          results.pending.push({ reason: "not_recognized_as_credit", ...doc, notes: parsed.notes });
          continue;
        }
        const header = parsed.header || {};

        await client.query("BEGIN");
        try {
          if (header.credit_note_no) {
            const dup = await client.query(
              "SELECT id FROM credits WHERE supplier_id=$1 AND credit_note_no=$2",
              [supplier.id, header.credit_note_no]
            );
            if (dup.rows.length > 0) {
              console.log(`  [skip] (supplier_id,credit_note_no) 已存在(id=${dup.rows[0].id})`);
              await client.query("ROLLBACK");
              results.skipped_duplicate.push({ ...doc, existingId: dup.rows[0].id });
              continue;
            }
          }
          const { id: sourceFileId } = await getOrCreateSourceFile(client, doc.split_path, buf, "application/pdf");
          const { rows: credRows } = await client.query(
            `INSERT INTO credits
               (supplier_id, credit_note_no, credit_date, delivery_docket_no, reason,
                total_amount, currency, source, source_file_id, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'p2_historical_ocr',$8,'new')
             RETURNING id`,
            [
              supplier.id, header.credit_note_no || null, header.credit_date || null,
              header.delivery_docket_no || null, header.reason || null,
              header.total_amount ?? null, "AUD", sourceFileId
            ]
          );
          await client.query("COMMIT");
          console.log(`  [success] credit id=${credRows[0].id}, total=${header.total_amount}`);
          results.credits_success.push({ ...doc, creditId: credRows[0].id, totalAmount: header.total_amount });
        } catch (err) {
          await client.query("ROLLBACK");
          console.log(`  [failed] 写入DB出错: ${err.message}`);
          results.failed.push({ ...doc, error: err.message });
        }
      } else {
        console.log(`  [pending] 未知doc_type: ${doc.doc_type}`);
        results.pending.push({ reason: "unknown_doc_type", ...doc });
      }
    }
  } finally {
    client.release();
  }

  console.log(`\n===== 汇总 =====`);
  console.log(`invoices成功: ${results.invoices_success.length}`);
  console.log(`credits成功: ${results.credits_success.length}`);
  console.log(`跳过(已存在): ${results.skipped_duplicate.length}`);
  console.log(`pending: ${results.pending.length}`);
  console.log(`failed: ${results.failed.length}`);

  const OUT_JSON = "C:\\Users\\18426\\AppData\\Local\\Temp\\claude\\C--Users-18426-Desktop---\\e05e78aa-5762-4e61-8148-a9d172c772a5\\scratchpad\\split_pdfs2\\results.json";
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2), "utf-8");
  console.log(`详细结果写入: ${OUT_JSON}`);

  await pool.end();
}

main().catch((err) => {
  console.error("脚本异常终止:", err);
  process.exit(1);
});
