// P2历史数据清洗：8月供应商Invoice PDF批量OCR导入，带去重合并。
// 范围：AU6D8月/<供应商文件夹>/ 下的发票PDF(排除Statement对账单)。
// 8月发票校验总表.xlsx已经导入过149条invoices(仅表头，无明细行，source != 'p2_historical_ocr')，
// 这批PDF大概率是那些发票的原始单据——OCR后按(supplier_id,invoice_no)匹配：
//   - 匹配到已有的非OCR来源发票 且 该发票当前0条invoice_items -> 把OCR出的明细行补挂上去，不新建发票
//   - 匹配到已有OCR来源发票(重复PDF) -> pending，不重复处理
//   - 没匹配到 -> 当作全新发票插入(表头+明细)，复用7月批次的写法
import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pool } from "../pool.js";
import { parseInvoiceDocument, isOcrConfigured } from "../../services/ocrParsingService.js";

const ROOT = "C:\\Users\\18426\\Desktop\\库管\\AU6D8月";
const PENDING_OUT = "C:\\Users\\18426\\Desktop\\库管\\haidilao-receiving-app\\库管数据\\P2_ocr_pending\\8月_invoice_ocr_pending.json";

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

function pickInvoiceFile(files) {
  const nonStatement = files.filter((f) => !/statement|statemnt/i.test(f) && f.toLowerCase().endsWith(".pdf"));
  if (nonStatement.length === 0) return { file: null, ambiguousOthers: [] };
  const preferred = nonStatement.filter((f) => /发票|invoice/i.test(f));
  if (preferred.length >= 1) return { file: preferred[0], ambiguousOthers: nonStatement.filter((f) => f !== preferred[0]) };
  nonStatement.sort();
  return { file: nonStatement[0], ambiguousOthers: nonStatement.slice(1) };
}

async function insertItems(client, invoiceId, items) {
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
}

async function main() {
  if (!isOcrConfigured()) {
    console.error("ANTHROPIC_API_KEY 未配置，无法OCR。中止。");
    process.exit(1);
  }

  const folders = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  const targets = [];
  const skippedNoInvoiceFile = [];
  for (const folder of folders) {
    const folderPath = path.join(ROOT, folder.name);
    const files = fs.readdirSync(folderPath);
    const { file, ambiguousOthers } = pickInvoiceFile(files);
    if (!file) {
      skippedNoInvoiceFile.push(folder.name);
      continue;
    }
    targets.push({ supplierFolder: folder.name, filePath: path.join(folderPath, file), ambiguousOthers });
  }
  console.log(`找到 ${targets.length} 个供应商Invoice PDF待处理(排除${skippedNoInvoiceFile.length}个无发票文件的文件夹: ${skippedNoInvoiceFile.join(",")})`);

  const client = await pool.connect();
  const results = { success_new: [], success_merged: [], pending: [], failed: [] };

  try {
    for (const { supplierFolder, filePath, ambiguousOthers } of targets) {
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
        console.log(`  [pending] 识别不到发票号`);
        results.pending.push({ reason: "no_invoice_no", supplierFolder, filePath, header });
        continue;
      }

      await client.query("BEGIN");
      try {
        const { id: sourceFileId } = await getOrCreateSourceFile(client, filePath, buf, "application/pdf");

        const dup = await client.query(
          "SELECT id, source FROM invoices WHERE supplier_id=$1 AND invoice_no=$2",
          [supplier.id, header.invoice_no]
        );

        if (dup.rows.length > 0) {
          const existing = dup.rows[0];
          if (existing.source === "p2_historical_ocr") {
            console.log(`  [pending] 已有同来源OCR发票(id=${existing.id})，疑似重复PDF`);
            await client.query("ROLLBACK");
            results.pending.push({ reason: "duplicate_ocr_invoice", supplierFolder, filePath, existingId: existing.id });
            continue;
          }
          const itemCount = await client.query("SELECT count(*) FROM invoice_items WHERE invoice_id=$1", [existing.id]);
          if (Number(itemCount.rows[0].count) > 0) {
            console.log(`  [pending] 已有表头记录(id=${existing.id})且已有${itemCount.rows[0].count}条明细，不重复补挂`);
            await client.query("ROLLBACK");
            results.pending.push({ reason: "existing_has_items_already", supplierFolder, filePath, existingId: existing.id });
            continue;
          }
          const items = Array.isArray(parsed.items) ? parsed.items : [];
          await insertItems(client, existing.id, items);
          await client.query(
            "UPDATE invoices SET source_file_id = COALESCE(source_file_id, $1) WHERE id = $2",
            [sourceFileId, existing.id]
          );
          await client.query("COMMIT");
          console.log(`  [merged] 把${items.length}条OCR明细行补挂到已有表头发票(id=${existing.id})`);
          results.success_merged.push({
            supplierFolder, filePath, invoiceId: existing.id, invoiceNo: header.invoice_no,
            itemCount: items.length
          });
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
        await insertItems(client, invoiceId, items);
        await client.query("COMMIT");
        console.log(`  [new] invoice id=${invoiceId}, invoice_no=${header.invoice_no}, total=${header.total_amount}, items=${items.length}`);
        results.success_new.push({
          supplierFolder, filePath, invoiceId, invoiceNo: header.invoice_no,
          totalAmount: header.total_amount, itemCount: items.length
        });
      } catch (err) {
        await client.query("ROLLBACK");
        console.log(`  [failed] 写入DB出错: ${err.message}`);
        results.failed.push({ supplierFolder, filePath, error: err.message });
      }

      if (ambiguousOthers.length > 0) {
        results.pending.push({ reason: "ambiguous_extra_file_in_folder", supplierFolder, ambiguousOthers });
      }
    }
  } finally {
    client.release();
  }

  console.log("\n===== 汇总 =====");
  console.log(`新建发票: ${results.success_new.length}`);
  console.log(`合并明细到已有发票: ${results.success_merged.length}`);
  console.log(`pending: ${results.pending.length}`);
  console.log(`failed: ${results.failed.length}`);

  fs.mkdirSync(path.dirname(PENDING_OUT), { recursive: true });
  fs.writeFileSync(PENDING_OUT, JSON.stringify(results, null, 2), "utf-8");
  console.log(`详细结果(含pending清单)写入: ${PENDING_OUT}`);

  await pool.end();
}

main().catch((err) => {
  console.error("脚本异常终止:", err);
  process.exit(1);
});
