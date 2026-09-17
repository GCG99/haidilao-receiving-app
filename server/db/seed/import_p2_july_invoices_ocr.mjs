// P2历史数据清洗：7月供应商Invoice PDF批量OCR导入。
// 范围：7月/2026.7.6d/<供应商文件夹>/ 下文件名含"Invoice"的PDF(一个供应商一份)，
// 不含Statement对账单(对账单目标表是supplier_statements，不是这批的范围，另开一批处理)。
// 复用 server/services/ocrParsingService.js 的 parseInvoiceDocument，不重新写OCR逻辑。
// 本地Postgres only。5级匹配铁律：供应商/物料非精确匹配一律进pending，不自动写正式表。
import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pool } from "../pool.js";
import { parseInvoiceDocument, isOcrConfigured } from "../../services/ocrParsingService.js";

const ROOT = "C:\\Users\\18426\\Desktop\\库管\\7月\\2026.7.6d";
const PENDING_OUT = "C:\\Users\\18426\\Desktop\\库管\\haidilao-receiving-app\\库管数据\\P2_ocr_pending\\7月_invoice_ocr_pending.json";

// 文件夹名 -> suppliers.name 精确匹配候选(文件夹名本身就是精确匹配的第一优先级，
// 因为这是用户自己组织的目录，等同于"标准名称"层级；如果文件夹名在suppliers表里查不到，
// 才降级去试文件内OCR识别出的供应商名)
async function findSupplierExact(client, candidateName) {
  const { rows } = await client.query("SELECT id, name FROM suppliers WHERE name = $1", [candidateName]);
  return rows[0] || null;
}

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

async function main() {
  if (!isOcrConfigured()) {
    console.error("ANTHROPIC_API_KEY 未配置，无法OCR。中止。");
    process.exit(1);
  }

  const folders = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  const targets = [];
  for (const folder of folders) {
    const folderPath = path.join(ROOT, folder.name);
    const files = fs.readdirSync(folderPath);
    const invoiceFile = files.find((f) => /invoice/i.test(f) && f.toLowerCase().endsWith(".pdf"));
    if (invoiceFile) {
      targets.push({ supplierFolder: folder.name, filePath: path.join(folderPath, invoiceFile) });
    }
  }
  console.log(`找到 ${targets.length} 个供应商Invoice PDF待处理:`, targets.map((t) => t.supplierFolder).join(", "));

  const client = await pool.connect();
  const results = { success: [], pending: [], failed: [] };

  try {
    for (const { supplierFolder, filePath } of targets) {
      console.log(`\n--- 处理 ${supplierFolder}: ${filePath} ---`);
      const supplier = await findSupplierExact(client, supplierFolder);
      if (!supplier) {
        console.log(`  [pending] 供应商文件夹名"${supplierFolder}"在suppliers表无精确匹配`);
        results.pending.push({ reason: "supplier_no_exact_match", supplierFolder, filePath });
        continue;
      }

      const buf = fs.readFileSync(filePath);
      let parsed;
      try {
        parsed = await parseInvoiceDocument(buf, "application/pdf");
      } catch (err) {
        console.log(`  [failed] OCR调用失败: ${err.message}`);
        results.failed.push({ supplierFolder, filePath, error: err.message });
        continue;
      }

      if (!parsed.is_invoice) {
        console.log(`  [pending] 模型判定不是发票: ${parsed.notes || "(无说明)"}`);
        results.pending.push({ reason: "not_recognized_as_invoice", supplierFolder, filePath, notes: parsed.notes });
        continue;
      }

      const header = parsed.header || {};
      if (!header.invoice_no) {
        console.log(`  [pending] 识别不到发票号，不能满足(supplier_id,invoice_no)唯一约束`);
        results.pending.push({ reason: "no_invoice_no", supplierFolder, filePath, header });
        continue;
      }

      await client.query("BEGIN");
      try {
        const { id: sourceFileId } = await getOrCreateSourceFile(client, filePath, buf, "application/pdf");

        const dup = await client.query(
          "SELECT id FROM invoices WHERE supplier_id=$1 AND invoice_no=$2",
          [supplier.id, header.invoice_no]
        );
        if (dup.rows.length > 0) {
          console.log(`  [pending] (supplier_id,invoice_no) 已存在于invoices表(id=${dup.rows[0].id})，疑似重复导入`);
          await client.query("ROLLBACK");
          results.pending.push({ reason: "duplicate_invoice_no", supplierFolder, filePath, existingId: dup.rows[0].id });
          continue;
        }

        const { rows: invRows } = await client.query(
          `INSERT INTO invoices
             (supplier_id, invoice_no, invoice_date, due_date, invoice_type, currency,
              subtotal, gst, total_amount, source, source_file_id, status, ocr_confidence, parser_version)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'p2_historical_ocr',$10,'parsed',$11,'claude-sonnet-5-p2-batch')
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
        console.log(`  [success] invoice id=${invoiceId}, invoice_no=${header.invoice_no}, ` +
          `total=${header.total_amount}, items=${items.length}`);
        results.success.push({
          supplierFolder, filePath, invoiceId, invoiceNo: header.invoice_no,
          totalAmount: header.total_amount, itemCount: items.length, confidence: header.confidence
        });
      } catch (err) {
        await client.query("ROLLBACK");
        console.log(`  [failed] 写入DB出错: ${err.message}`);
        results.failed.push({ supplierFolder, filePath, error: err.message });
      }
    }
  } finally {
    client.release();
  }

  fs.mkdirSync(path.dirname(PENDING_OUT), { recursive: true });
  fs.writeFileSync(PENDING_OUT, JSON.stringify(results, null, 2), "utf-8");

  console.log(`\n===== 汇总 =====`);
  console.log(`成功写入: ${results.success.length}`);
  console.log(`pending(需人工): ${results.pending.length}`);
  console.log(`failed(OCR/写入出错): ${results.failed.length}`);
  console.log(`详情已写入: ${PENDING_OUT}`);

  await pool.end();
}

main().catch((err) => {
  console.error("脚本异常终止:", err);
  process.exit(1);
});
