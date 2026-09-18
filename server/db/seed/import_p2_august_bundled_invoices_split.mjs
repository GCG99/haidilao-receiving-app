// P2历史数据清洗：修复8月批次同样存在的"多单据拼一个PDF"问题(跟7月是同一类bug，
// 见import_p2_july_remaining_bundled_invoices.mjs的详细说明)。
//
// 8月的情况比7月复杂一点：8月发票校验总表.xlsx已经先导入了149条发票表头(有真实invoice_no，
// 但0条明细行)，原批次OCR脚本对着这些多单据拼一个的PDF文件，同样只识别第一张单据，
// 于是"补挂明细行"逻辑只针对文件里第一张发票生效，文件里其余发票的表头虽然已经从
// spreadsheet正确导入，但明细行始终是空的、从未被真正处理过。
//
// 三态去重逻辑（跟7月单纯"跳过重复"不一样，8月需要额外处理"表头已有、明细未补"这种情况）：
//   1. (supplier_id,invoice_no)已存在 且 已有明细行(items>0) -> 跳过，已经完整
//   2. (supplier_id,invoice_no)已存在 但 0条明细行(通常是spreadsheet导入的表头) -> 补挂明细行，
//      同时用OCR结果补齐表头里为NULL的字段(比如subtotal/gst/ocr_confidence)，不覆盖已有非NULL值
//      (spreadsheet给的invoice_date/total_amount已经是人工核对过的可信数据，不用OCR结果覆盖)
//   3. (supplier_id,invoice_no)不存在 -> 全新插入(表头+明细)
//
// 供应商文件夹名匹配：AU6D8月/下的文件夹名有几个跟suppliers.name大小写不完全一致
// (DISCOUNT SOLUTIONS/FRIENDSHIP/FUJA/HAC/Sunstae/YUENS，原批次已经发现这个问题、
// 记录在pending里，不是这次新发现)。这次做法：先精确匹配，不行就试大小写不敏感匹配，
// 但只有唯一候选时才采用（比如YUENS只对应一个"Yuens"，采用；DISCOUNT SOLUTIONS大小写不敏感后
// 会同时命中"Discount Solutions"和"Discount solution"两个不同的供应商ID，判定为不能自动决定
// 该算谁，进pending，不擅自选一个）——这是纯技术性的字符串匹配容错，不是编造供应商身份。
import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pool } from "../pool.js";
import { parseInvoiceDocument, parseCreditDocument, isOcrConfigured } from "../../services/ocrParsingService.js";

const MANIFEST_PATH =
  "C:\\Users\\18426\\AppData\\Local\\Temp\\claude\\C--Users-18426-Desktop---\\e05e78aa-5762-4e61-8148-a9d172c772a5\\scratchpad\\split_pdfs_aug\\manifest.json";

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

async function findSupplier(client, candidateName) {
  const exact = await client.query("SELECT id, name FROM suppliers WHERE name = $1", [candidateName]);
  if (exact.rows.length === 1) return { supplier: exact.rows[0], matchType: "exact" };

  const ci = await client.query("SELECT id, name FROM suppliers WHERE LOWER(name) = LOWER($1)", [candidateName]);
  if (ci.rows.length === 1) return { supplier: ci.rows[0], matchType: "case_insensitive_unique" };
  if (ci.rows.length > 1) return { supplier: null, matchType: "case_insensitive_ambiguous", candidates: ci.rows };

  return { supplier: null, matchType: "no_match" };
}

async function main() {
  if (!isOcrConfigured()) {
    console.error("ANTHROPIC_API_KEY 未配置，无法OCR。中止。");
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8"));
  console.log(`读取到 ${manifest.length} 份子文档待处理`);

  const client = await pool.connect();
  const results = {
    invoices_new: [], invoices_items_attached: [], credits_new: [],
    skipped_complete: [], pending: [], failed: [],
  };

  try {
    for (const [idx, doc] of manifest.entries()) {
      console.log(`\n[${idx + 1}/${manifest.length}] --- ${doc.supplier_folder} ${doc.doc_no} (${doc.doc_type}) ---`);
      const { supplier, matchType, candidates } = await findSupplier(client, doc.supplier_folder);
      if (!supplier) {
        console.log(`  [pending] 供应商文件夹名"${doc.supplier_folder}"匹配失败(${matchType})`);
        results.pending.push({ reason: "supplier_no_match", matchType, candidates, ...doc });
        continue;
      }
      if (matchType === "case_insensitive_unique") {
        console.log(`  (大小写不敏感匹配到唯一候选: ${supplier.name})`);
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
        if (!parsed.is_invoice || !parsed.header?.invoice_no) {
          console.log(`  [pending] 非发票或无发票号`);
          results.pending.push({ reason: "not_invoice_or_no_no", ...doc, notes: parsed.notes });
          continue;
        }
        const header = parsed.header;

        await client.query("BEGIN");
        try {
          const existing = await client.query(
            `SELECT i.id, (SELECT COUNT(*) FROM invoice_items WHERE invoice_id=i.id) AS item_count
             FROM invoices i WHERE i.supplier_id=$1 AND i.invoice_no=$2`,
            [supplier.id, header.invoice_no]
          );

          if (existing.rows.length > 0 && Number(existing.rows[0].item_count) > 0) {
            console.log(`  [skip] id=${existing.rows[0].id} 已有${existing.rows[0].item_count}条明细，跳过`);
            await client.query("ROLLBACK");
            results.skipped_complete.push({ ...doc, existingId: existing.rows[0].id });
            continue;
          }

          const { id: sourceFileId } = await getOrCreateSourceFile(client, doc.split_path, buf, "application/pdf");
          let invoiceId;

          if (existing.rows.length > 0) {
            // 表头已存在(spreadsheet导入)、0条明细 -> 只补齐NULL字段+挂明细，不覆盖已有非NULL值
            invoiceId = existing.rows[0].id;
            await client.query(
              `UPDATE invoices SET
                 subtotal = COALESCE(subtotal, $1),
                 gst = COALESCE(gst, $2),
                 invoice_type = COALESCE(invoice_type, $3),
                 due_date = COALESCE(due_date, $4),
                 source_file_id = COALESCE(source_file_id, $5),
                 ocr_confidence = COALESCE(ocr_confidence, $6),
                 updated_at = now()
               WHERE id = $7`,
              [header.subtotal ?? null, header.gst ?? null, header.invoice_type || null,
               header.due_date || null, sourceFileId, header.confidence ?? null, invoiceId]
            );
          } else {
            const { rows: invRows } = await client.query(
              `INSERT INTO invoices
                 (supplier_id, invoice_no, invoice_date, due_date, invoice_type, currency,
                  subtotal, gst, total_amount, source, source_file_id, status, ocr_confidence, parser_version)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'p2_historical_ocr',$10,'parsed',$11,'claude-sonnet-5-p2-aug-batch-split')
               RETURNING id`,
              [
                supplier.id, header.invoice_no, header.invoice_date || null, header.due_date || null,
                header.invoice_type || null, header.currency || "AUD",
                header.subtotal ?? null, header.gst ?? null, header.total_amount ?? null,
                sourceFileId, header.confidence ?? null
              ]
            );
            invoiceId = invRows[0].id;
          }

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

          if (existing.rows.length > 0) {
            console.log(`  [items_attached] invoice id=${invoiceId}, 补挂${items.length}条明细`);
            results.invoices_items_attached.push({ ...doc, invoiceId, itemCount: items.length });
          } else {
            console.log(`  [new] invoice id=${invoiceId}, total=${header.total_amount}, items=${items.length}`);
            results.invoices_new.push({ ...doc, invoiceId, totalAmount: header.total_amount, itemCount: items.length });
          }
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
          console.log(`  [pending] 非Credit Note`);
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
              console.log(`  [skip] credit id=${dup.rows[0].id} 已存在`);
              await client.query("ROLLBACK");
              results.skipped_complete.push({ ...doc, existingId: dup.rows[0].id });
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
          console.log(`  [new] credit id=${credRows[0].id}, total=${header.total_amount}`);
          results.credits_new.push({ ...doc, creditId: credRows[0].id, totalAmount: header.total_amount });
        } catch (err) {
          await client.query("ROLLBACK");
          console.log(`  [failed] 写入DB出错: ${err.message}`);
          results.failed.push({ ...doc, error: err.message });
        }
      }
    }
  } finally {
    client.release();
  }

  console.log(`\n===== 汇总 =====`);
  console.log(`全新发票: ${results.invoices_new.length}`);
  console.log(`补挂明细行(表头本来就有): ${results.invoices_items_attached.length}`);
  console.log(`全新Credit Note: ${results.credits_new.length}`);
  console.log(`跳过(已完整): ${results.skipped_complete.length}`);
  console.log(`pending: ${results.pending.length}`);
  console.log(`failed: ${results.failed.length}`);

  const OUT_JSON = "C:\\Users\\18426\\AppData\\Local\\Temp\\claude\\C--Users-18426-Desktop---\\e05e78aa-5762-4e61-8148-a9d172c772a5\\scratchpad\\split_pdfs_aug\\results.json";
  fs.writeFileSync(OUT_JSON, JSON.stringify(results, null, 2), "utf-8");
  console.log(`详细结果写入: ${OUT_JSON}`);

  await pool.end();
}

main().catch((err) => {
  console.error("脚本异常终止:", err);
  process.exit(1);
});
