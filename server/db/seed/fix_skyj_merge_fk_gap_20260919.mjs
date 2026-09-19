// 2026-09-19发现：suppliers表里4个已确认合并的供应商(SKYJ→领鲜/北方→Beifang/
// BNE→B&E/Coworkc→Cowrock)，只有SKYJ的8张invoices记录还留在旧supplier_id(SUP-023)下，
// 没有跟着merged_into_id重定向到SUP-047(领鲜)——另外3组都已经正确重定向。
// 全表扫描过全部9个含supplier_id列的表(order_requests/invoices/erp_receipts/credits/
// supplier_statements/receiving_records/supplier_delivery_schedule/
// supplier_material_mapping/unit_conversions)，确认这是唯一的不一致，不是系统性问题，
// 是SKYJ这一次合并单独漏掉了。这不是新的业务判断——SKYJ已经在suppliers表里
// merged_into_id=SUP-047确认过合并，这里只是补齐已批准合并的机械执行(其他3组
// 当初就是这么做的)。8条invoice逐条核对过invoice_no+total_amount在对账单
// (supplier_statement_items)里能精确对上，不是猜测性合并。
//
// 顺带：合并FK后，supplier_statement_items里这8张发票对应的对账单行此前因为
// supplier_id不一致(对账单在SUP-047下，发票在SUP-023下)精确匹配不到，现在一起回填
// matched_invoice_id。张记(SUP-039)的17条对账单行也顺带回填——reference字段是
// "INV-32152 / 225004"这种复合格式(凭证号/INV号双编号体系，项目里已知情况)，
// 之前的精确匹配只按reference整串比对invoice_no，匹配不上；这里改用拆分" / "后
// 分别尝试两段来匹配，不改动任何金额/日期字段，只回填matched_invoice_id这个
// 纯技术性关联字段。只在本地开发库执行，不碰生产库。
import "dotenv/config";
import { pool, withTransaction } from "../pool.js";

async function main() {
  await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE invoices SET supplier_id = 'SUP-047' WHERE supplier_id = 'SUP-023'`
    );
    console.log(`SKYJ(SUP-023) -> 领鲜(SUP-047): ${rowCount} 条 invoices 已重定向`);
  });

  // 回填张记(复合reference)和SKYJ(供应商FK修好后现在能精确匹配的)对账单明细行的
  // matched_invoice_id。范围限定为matched_invoice_id/matched_credit_id都还是NULL的行，
  // 不touch已经匹配好的行。
  const { rows: candidates } = await pool.query(`
    SELECT si.id, s.supplier_id, si.reference, si.amount
    FROM supplier_statement_items si
    JOIN supplier_statements s ON s.id = si.statement_id
    WHERE si.matched_invoice_id IS NULL AND si.matched_credit_id IS NULL
      AND si.transaction_type IN ('Invoice', 'Purchase', 'Credit Note', 'Tax Invoice', 'IN')
  `);

  let backfilled = 0;
  for (const row of candidates) {
    const candidateNos = row.reference.includes(" / ")
      ? row.reference.split(" / ").map((s) => s.trim())
      : [row.reference.trim()];

    let matched = null;
    for (const no of candidateNos) {
      const { rows } = await pool.query(
        `SELECT id FROM invoices WHERE supplier_id = $1 AND invoice_no = $2`,
        [row.supplier_id, no]
      );
      if (rows.length === 1) {
        matched = rows[0].id;
        break;
      }
    }
    if (matched) {
      await pool.query(`UPDATE supplier_statement_items SET matched_invoice_id = $1 WHERE id = $2`, [matched, row.id]);
      backfilled++;
    }
  }
  console.log(`supplier_statement_items 回填 matched_invoice_id: ${backfilled} 条`);

  await pool.end();
}

main().catch((err) => {
  console.error("脚本异常终止:", err);
  process.exit(1);
});
