// 2026-09-19发现：生产库suppliers表只有SKYJ→领鲜这一组合并生效了，另外3组
// (北方→Beifang/BNE→B&E/Coworkc→Cowrock)只在本地开发库执行过——这3组合并本身
// 是用户已经明确确认过的真实供应商身份("三组都是同一真实供应商"，见项目memory)，
// 不是这次新做的业务判断，只是当初的确认结果没有同步到生产库。这次会话另外
// 发现SKYJ那组合并本身也有FK重定向遗漏(invoices表没跟着改)，所以这次连同FK
// 重定向一起检查，不能只改merged_into_id。
//
// 用户已明确说"要"，同意把这3组已确认的合并同步到生产库。用DATABASE_URL环境变量
// 临时指向生产库运行(不写入.env)，跑完清空。
import "dotenv/config";
import pg from "pg";

if (!process.env.DATABASE_URL || !process.env.DATABASE_URL.includes("render.com")) {
  console.error("安全检查：DATABASE_URL看起来不是生产库(不含render.com)，中止。");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const MERGES = [
  { old: "SUP-034", target: "SUP-005", name: "北方 -> Beifang" },
  { old: "SUP-004", target: "SUP-003", name: "BNE -> B&E" },
  { old: "SUP-010", target: "SUP-011", name: "Coworkc -> Cowrock" }
];

const FK_TABLES = [
  "order_requests", "invoices", "erp_receipts", "credits", "supplier_statements",
  "receiving_records", "supplier_delivery_schedule", "supplier_material_mapping", "unit_conversions"
];

async function main() {
  console.log("=== 执行前审计：这3组旧supplier_id在全部FK表里的引用数 ===");
  for (const m of MERGES) {
    for (const table of FK_TABLES) {
      const { rows } = await pool.query(`SELECT count(*) FROM ${table} WHERE supplier_id = $1`, [m.old]);
      const count = Number(rows[0].count);
      if (count > 0) console.log(`  ${m.name}: ${table} 有 ${count} 条引用旧ID(${m.old})，将重定向到${m.target}`);
    }
  }

  console.log("\n=== 执行合并 ===");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const m of MERGES) {
      await client.query("UPDATE suppliers SET merged_into_id = $1 WHERE id = $2", [m.target, m.old]);
      console.log(`suppliers.merged_into_id 已设置: ${m.name}`);

      for (const table of FK_TABLES) {
        const { rowCount } = await client.query(
          `UPDATE ${table} SET supplier_id = $1 WHERE supplier_id = $2`,
          [m.target, m.old]
        );
        if (rowCount > 0) console.log(`  ${table}: ${rowCount} 条已重定向`);
      }
    }
    await client.query("COMMIT");
    console.log("\n全部提交成功。");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("出错，已回滚:", err);
    throw err;
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((err) => {
  console.error("脚本异常终止:", err);
  process.exit(1);
});
