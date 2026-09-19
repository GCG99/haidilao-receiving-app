// P2历史数据清洗：供应商对账单(Statement)批量OCR导入。
// 范围：7月/2026.7.6d/<供应商文件夹>/ 和 AU6D8月/<供应商文件夹>/ 下文件名含
// "statement"/"对账"的文件(PDF或图片)。只处理落在"供应商文件夹"里的文件——
// 两个月份根目录下还各自散落着几份不在任何供应商文件夹里的"statement [Brisbane CBD]..."
// 文件(AU6D8月下有5份不同日期快照)，因为不知道这些文件到底是哪个真实供应商发出的
// (文件名只写了收件门店"Brisbane CBD"，没写发件供应商)，这属于供应商身份判断，
// 不能靠猜，本批明确排除，留给用户确认后再处理。
// 复用 server/services/ocrParsingService.js 的 parseStatementDocument，不重新写OCR逻辑。
// 本地Postgres only。供应商精确匹配失败一律进pending，不自动写正式表；供应商已被合并
// (merged_into_id不为空)则自动落到合并后的目标供应商，跟invoices导入脚本的既定处理方式一致。
import "dotenv/config";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pool } from "../pool.js";
import { parseStatementDocument, isOcrConfigured } from "../../services/ocrParsingService.js";

const ROOTS = [
  "C:\\Users\\18426\\Desktop\\库管\\7月\\2026.7.6d",
  "C:\\Users\\18426\\Desktop\\库管\\AU6D8月"
];
const PENDING_OUT = "C:\\Users\\18426\\Desktop\\库管\\haidilao-receiving-app\\库管数据\\P2_ocr_pending\\statements_ocr_pending.json";

const STATEMENT_NAME_RE = /statement|对账/i;
const MIME_BY_EXT = { ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

async function findSupplier(client, candidateName) {
  // 跟import_p2_august_bundled_invoices_split.mjs的findSupplier同一套逻辑：先精确匹配，
  // 不行再试大小写不敏感匹配，但只有唯一候选时才采用——同一大小写不敏感结果命中多个不同
  // 供应商ID的话不擅自选一个，进pending。这次新发现AU6D8月/下的FRIENDSHIP、SUPAGAS两个
  // 文件夹名跟suppliers.name大小写不一致，之前的精确匹配版本会把这两个供应商的Statement
  // 文件错误地扔进pending——这是纯字符串匹配容错，不是供应商身份判断。
  const exact = await client.query("SELECT id, name, merged_into_id FROM suppliers WHERE name = $1", [candidateName]);
  let supplier = null;
  let matchType = null;
  if (exact.rows.length === 1) {
    supplier = exact.rows[0];
    matchType = "exact";
  } else {
    const ci = await client.query("SELECT id, name, merged_into_id FROM suppliers WHERE LOWER(name) = LOWER($1)", [candidateName]);
    if (ci.rows.length === 1) {
      supplier = ci.rows[0];
      matchType = "case_insensitive_unique";
    } else if (ci.rows.length > 1) {
      return { supplier: null, matchType: "case_insensitive_ambiguous", candidates: ci.rows };
    } else {
      return { supplier: null, matchType: "no_match" };
    }
  }
  // 沿用invoices导入脚本的既定处理：供应商已被合并的话，落到合并后的目标供应商，
  // 不要求每个历史批次自己重复判断合并关系。
  if (supplier.merged_into_id) {
    const target = await client.query("SELECT id, name FROM suppliers WHERE id = $1", [supplier.merged_into_id]);
    if (target.rows.length > 0) return { supplier: target.rows[0], matchType };
  }
  return { supplier: { id: supplier.id, name: supplier.name }, matchType };
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

function collectTargets() {
  const targets = [];
  for (const root of ROOTS) {
    const folders = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const folder of folders) {
      const folderPath = path.join(root, folder.name);
      const files = fs.readdirSync(folderPath);
      for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        if (STATEMENT_NAME_RE.test(f) && MIME_BY_EXT[ext]) {
          targets.push({ supplierFolder: folder.name, filePath: path.join(folderPath, f), mimeType: MIME_BY_EXT[ext] });
        }
      }
    }
  }
  return targets;
}

async function main() {
  if (!isOcrConfigured()) {
    console.error("ANTHROPIC_API_KEY 未配置，无法OCR。中止。");
    process.exit(1);
  }

  const targets = collectTargets();
  console.log(`找到 ${targets.length} 份供应商Statement文件待处理:`);
  for (const t of targets) console.log(`  ${t.supplierFolder}: ${t.filePath}`);

  const client = await pool.connect();
  const results = { success: [], pending: [], failed: [] };

  try {
    for (const { supplierFolder, filePath, mimeType } of targets) {
      console.log(`\n--- 处理 ${supplierFolder}: ${filePath} ---`);
      const { supplier, matchType, candidates } = await findSupplier(client, supplierFolder);
      if (!supplier) {
        console.log(`  [pending] 供应商文件夹名"${supplierFolder}"匹配失败(${matchType})`);
        results.pending.push({ reason: "supplier_no_match", matchType, candidates, supplierFolder, filePath });
        continue;
      }
      if (matchType === "case_insensitive_unique") {
        console.log(`  (大小写不敏感匹配到唯一候选: ${supplier.name})`);
      }

      const buf = fs.readFileSync(filePath);
      let parsed;
      try {
        parsed = await parseStatementDocument(buf, mimeType);
      } catch (err) {
        console.log(`  [failed] OCR调用失败: ${err.message}`);
        results.failed.push({ supplierFolder, filePath, error: err.message });
        continue;
      }

      if (!parsed.is_invoice) {
        console.log(`  [pending] 模型判定不是对账单: ${parsed.notes || "(无说明)"}`);
        results.pending.push({ reason: "not_recognized_as_statement", supplierFolder, filePath, notes: parsed.notes });
        continue;
      }

      const header = parsed.header || {};
      const items = Array.isArray(parsed.items) ? parsed.items : [];

      await client.query("BEGIN");
      try {
        const { id: sourceFileId, reused } = await getOrCreateSourceFile(client, filePath, buf, mimeType);

        if (reused) {
          const dupBySource = await client.query(
            "SELECT id FROM supplier_statements WHERE source_file_id = $1",
            [sourceFileId]
          );
          if (dupBySource.rows.length > 0) {
            console.log(`  [pending] 该文件(sha256已存在)已导入过statement id=${dupBySource.rows[0].id}，跳过`);
            await client.query("ROLLBACK");
            results.pending.push({ reason: "duplicate_source_file", supplierFolder, filePath, existingId: dupBySource.rows[0].id });
            continue;
          }
        }

        // 期末总额核对：只用来打状态标记，不改动任何金额字段，也不据此臆造/修正任何数据——
        // 纯粹是给人工复核用的信号，不是自动纠错。
        const sumOfAmounts = items.reduce((s, it) => s + (typeof it.amount === "number" ? it.amount : 0), 0);
        const closing = header.closing_balance;
        const hasBothTotals = typeof closing === "number" && items.length > 0;
        const discrepancy = hasBothTotals ? Number((closing - sumOfAmounts).toFixed(2)) : null;
        // 千分之一或1澳元(取较大者)以内的差异算浮点/取整噪音，不算真实不平——门槛本身不是
        // 精确计算出来的，只是一个防止把正常四舍五入噪音当成异常来标记的粗筛门槛。
        const tolerance = Math.max(1, Math.abs(closing || 0) * 0.001);
        const status = discrepancy === null ? "new" : Math.abs(discrepancy) <= tolerance ? "reconciled" : "discrepancy";

        const { rows: stRows } = await client.query(
          `INSERT INTO supplier_statements
             (supplier_id, statement_date, account_no, total_balance, source_file_id, status)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id`,
          [supplier.id, header.statement_date || null, header.account_no || null, closing ?? null, sourceFileId, status]
        );
        const statementId = stRows[0].id;

        let matchedInvoiceCount = 0;
        let matchedCreditCount = 0;
        for (const it of items) {
          let matchedInvoiceId = null;
          let matchedCreditId = null;
          if (it.reference) {
            const invMatch = await client.query(
              "SELECT id FROM invoices WHERE supplier_id = $1 AND invoice_no = $2",
              [supplier.id, it.reference]
            );
            if (invMatch.rows.length === 1) {
              matchedInvoiceId = invMatch.rows[0].id;
              matchedInvoiceCount++;
            } else if (invMatch.rows.length === 0) {
              const crMatch = await client.query(
                "SELECT id FROM credits WHERE supplier_id = $1 AND credit_note_no = $2",
                [supplier.id, it.reference]
              );
              if (crMatch.rows.length === 1) {
                matchedCreditId = crMatch.rows[0].id;
                matchedCreditCount++;
              }
              // reference能对应多条(理论上不该发生，unique约束保证不了跨表)或完全查不到，
              // 一律保持NULL，留给人工核对，不猜哪一条才是对的。
            }
          }
          await client.query(
            `INSERT INTO supplier_statement_items
               (statement_id, transaction_date, reference, transaction_type, amount, running_balance,
                due_date, matched_invoice_id, matched_credit_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              statementId, it.transaction_date || null, it.reference || null, it.transaction_type || null,
              it.amount ?? null, it.running_balance ?? null, it.due_date || null,
              matchedInvoiceId, matchedCreditId
            ]
          );
        }

        await client.query("COMMIT");
        console.log(
          `  [success] statement id=${statementId}, supplier=${supplier.name}, ` +
          `closing_balance=${closing}, items=${items.length}, ` +
          `matched_invoice=${matchedInvoiceCount}, matched_credit=${matchedCreditCount}, ` +
          `status=${status}${discrepancy !== null ? ` (discrepancy=${discrepancy})` : ""}`
        );
        results.success.push({
          supplierFolder, filePath, statementId, supplierId: supplier.id, closingBalance: closing,
          itemCount: items.length, matchedInvoiceCount, matchedCreditCount, status, discrepancy
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
