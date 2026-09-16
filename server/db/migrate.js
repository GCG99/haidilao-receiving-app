import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "migrations");

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getAppliedVersions() {
  const { rows } = await pool.query("SELECT version FROM schema_migrations");
  return new Set(rows.map((row) => row.version));
}

async function applyMigration(fileName) {
  const filePath = path.join(migrationsDir, fileName);
  const sql = fs.readFileSync(filePath, "utf8");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query(
      "INSERT INTO schema_migrations (version) VALUES ($1)",
      [fileName]
    );
    await client.query("COMMIT");
    console.log(`已应用：${fileName}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`迁移 ${fileName} 执行失败：${error.message}`);
  } finally {
    client.release();
  }
}

async function main() {
  await ensureMigrationsTable();
  const applied = await getAppliedVersions();

  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    console.log("没有找到任何迁移文件。");
  }

  let appliedCount = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`跳过（已应用）：${file}`);
      continue;
    }

    await applyMigration(file);
    appliedCount += 1;
  }

  console.log(`完成。本次新应用 ${appliedCount} 个迁移文件。`);
  await pool.end();
}

main().catch((error) => {
  console.error("迁移失败：", error);
  process.exit(1);
});
