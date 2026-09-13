import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf8");

  console.log("正在执行 schema.sql ...");
  await pool.query(schema);
  console.log("完成。");

  await pool.end();
}

main().catch((error) => {
  console.error("迁移失败：", error);
  process.exit(1);
});
