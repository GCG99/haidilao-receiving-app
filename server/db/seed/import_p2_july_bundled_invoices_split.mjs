// P2历史数据清洗：修复7月批量OCR导入时SKYJ/CFC两份失败的文件。
//
// 根因诊断(不是靠猜，是打开PDF实际看过)：这两份"XX 7月 Invoice.pdf"根本不是单张发票，
// 而是把7月一整个月的多张独立发票(SKYJ 4张)、外加CFC那份还混了1张Credit Note/Adjustment，
// 全部扫描粘在一个PDF文件里——SKYJ 8页/CFC 20页。parseInvoiceDocument是按"一张发票"设计的，
// 面对这种文件必然拿不出唯一的发票号/日期/金额，这正是第一批脚本报"结构化结果缺少必要字段"
// 的真实原因，不是OCR质量问题也不是文档渲染失败。
//
// 修复方式：用一次性的Claude API多页PDF理解调用(不是靠人工翻页数)逐页识别出"这一页属于
// 哪一张发票/哪一张调整单"的边界(见 P2_设计文档/线A线B整合规划.md 对应章节的记录)，
// 用pymupdf按边界把原PDF物理拆成16份子PDF(手工核对过原文16份图片截图，边界跟API识别结果
// 完全吻合)，再对每份子PDF复用现成的 parseInvoiceDocument/parseCreditDocument，不重新写OCR逻辑。
//
// 本脚本只吃拆分脚本(scratchpad/split_bundled_pdfs.py)产出的manifest.json+对应子PDF文件，
// 不重新做拆分——拆分是一次性的人工核实+API调用产出的确定性结果，没有必要在这个脚本里重跑。
//
// 注意：manifest.json和拆分出的16份子PDF都在会话scratchpad临时目录，不进git，这次会话结束后
// 大概率会被清理掉。这个脚本因此不能直接重跑第二次——它是"这次修复做了什么"的历史记录，
// 不是可重复执行的通用工具。如果以后还要处理同类"多张单据拼一个PDF"的情况，重新走一遍
// 页面边界识别(见P2_设计文档记录的检测prompt)+pymupdf拆分+这个脚本的写入逻辑三步即可，
// 不需要也不应该假设scratchpad里的文件还在。
import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pool } from "../pool.js";
import { parseInvoiceDocument, parseCreditDocument, isOcrConfigured } from "../../services/ocrParsingService.js";

const MANIFEST_PATH =
  "C:\\Users\\18426\\AppData\\Local\\Temp\\claude\\C--Users-18426-Desktop---\\e05e78aa-5762-4e61-8148-a9d172c772a5\\scratchpad\\split_pdfs\\manifest.json";

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
  const results = { invoices_success: [], credits_success: [], pending: [], failed: [] };

  try {
    for (const doc of manifest) {
      console.log(`\n--- ${doc.supplier_folder} ${doc.doc_no} (${doc.doc_type}, 原文件页${doc.pages.join("-")}) ---`);
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
          const { id: sourceFileId } = await getOrCreateSourceFile(client, doc.split_path, buf, "application/pdf");
          const dup = await client.query(
            "SELECT id FROM invoices WHERE supplier_id=$1 AND invoice_no=$2",
            [supplier.id, header.invoice_no]
          );
          if (dup.rows.length > 0) {
            console.log(`  [pending] (supplier_id,invoice_no) 已存在(id=${dup.rows[0].id})，疑似重复导入`);
            await client.query("ROLLBACK");
            results.pending.push({ reason: "duplicate_invoice_no", ...doc, existingId: dup.rows[0].id });
            continue;
          }

          const { rows: invRows } = await client.query(
            `INSERT INTO invoices
               (supplier_id, invoice_no, invoice_date, due_date, invoice_type, currency,
                subtotal, gst, total_amount, source, source_file_id, status, ocr_confidence, parser_version)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'p2_historical_ocr',$10,'parsed',$11,'claude-sonnet-5-p2-batch-split')
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
          const { id: sourceFileId } = await getOrCreateSourceFile(client, doc.split_path, buf, "application/pdf");
          if (header.credit_note_no) {
            const dup = await client.query(
              "SELECT id FROM credits WHERE supplier_id=$1 AND credit_note_no=$2",
              [supplier.id, header.credit_note_no]
            );
            if (dup.rows.length > 0) {
              console.log(`  [pending] (supplier_id,credit_note_no) 已存在(id=${dup.rows[0].id})，疑似重复导入`);
              await client.query("ROLLBACK");
              results.pending.push({ reason: "duplicate_credit_note_no", ...doc, existingId: dup.rows[0].id });
              continue;
            }
          }

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
      }
    }
  } finally {
    client.release();
  }

  console.log(`\n===== 汇总 =====`);
  console.log(`invoices成功: ${results.invoices_success.length}`);
  console.log(`credits成功: ${results.credits_success.length}`);
  console.log(`pending(需人工): ${results.pending.length}`, JSON.stringify(results.pending, null, 2));
  console.log(`failed: ${results.failed.length}`, JSON.stringify(results.failed, null, 2));

  await pool.end();
}

main().catch((err) => {
  console.error("脚本异常终止:", err);
  process.exit(1);
});
