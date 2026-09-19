// 把 export_p1.py 生成的 data/*.json 快照灌进 Postgres。
// 可以重复运行：都是按主键 upsert，不会产生重复记录。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool, withTransaction } from "../pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8"));
}

async function loadSuppliers(client) {
  const suppliers = readJson("suppliers.json");

  // merged_into_id 是自引用外键，先插入不带这个字段，再补一次，避免插入顺序踩到还不存在的目标行。
  for (const s of suppliers) {
    await client.query(
      `INSERT INTO suppliers (id, name, receiving_app_name, internal_code, is_internal_warehouse, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         receiving_app_name = EXCLUDED.receiving_app_name,
         internal_code = EXCLUDED.internal_code,
         is_internal_warehouse = EXCLUDED.is_internal_warehouse,
         status = EXCLUDED.status,
         updated_at = now()`,
      [s.id, s.name, s.receiving_app_name, s.internal_code, s.is_internal_warehouse, s.status]
    );
  }

  for (const s of suppliers) {
    if (!s.merged_into_id) continue;
    await client.query(`UPDATE suppliers SET merged_into_id = $1 WHERE id = $2`, [s.merged_into_id, s.id]);
  }

  console.log(`suppliers: ${suppliers.length} 条已写入`);
}

async function loadCategories(client) {
  const categories = readJson("categories.json");

  // 分类字典有自引用外键（parent_code），先全部插入不带 parent，再补一次 parent，避免顺序依赖失败。
  for (const c of categories) {
    await client.query(
      `INSERT INTO categories (code, name, level, sort_order, description, material_count_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (code) DO UPDATE SET
         name = EXCLUDED.name,
         level = EXCLUDED.level,
         sort_order = EXCLUDED.sort_order,
         description = EXCLUDED.description,
         material_count_snapshot = EXCLUDED.material_count_snapshot`,
      [c.code, c.name, c.level, c.sort_order, c.description, c.material_count_snapshot]
    );
  }

  for (const c of categories) {
    if (!c.parent_code) continue;
    await client.query(`UPDATE categories SET parent_code = $1 WHERE code = $2`, [c.parent_code, c.code]);
  }

  console.log(`categories: ${categories.length} 条已写入`);
}

async function loadMaterials(client) {
  const materials = readJson("materials.json");

  // 物料有自引用外键（merged_into_sku），同样先插入不带这个字段，再补一次。
  for (const m of materials) {
    await client.query(
      `INSERT INTO materials (sku, name, english_name, original_name, category, subcategory, unit, spec,
         default_supplier_name, status, enabled_status, record_status, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (sku) DO UPDATE SET
         name = EXCLUDED.name,
         english_name = EXCLUDED.english_name,
         original_name = EXCLUDED.original_name,
         category = EXCLUDED.category,
         subcategory = EXCLUDED.subcategory,
         unit = EXCLUDED.unit,
         spec = EXCLUDED.spec,
         default_supplier_name = EXCLUDED.default_supplier_name,
         status = EXCLUDED.status,
         enabled_status = EXCLUDED.enabled_status,
         record_status = EXCLUDED.record_status,
         raw = EXCLUDED.raw`,
      [
        m.sku,
        m.name,
        m.english_name,
        m.original_name,
        m.category,
        m.subcategory,
        m.unit,
        m.spec,
        m.default_supplier_name,
        m.status,
        m.enabled_status,
        m.record_status,
        JSON.stringify(m.raw)
      ]
    );
  }

  // 2026-09-20发现的真实数据模型冲突：P1里"SKU拆分"这类特殊情况(一个原SKU被拆成
  // 多个真实SKU，比如SEA-0013拆成SEA-0012+VEG-0089)，"合并至SKU"字段存的是一段
  // 描述性文字("已拆分,见旧SKU映射:SEA-0012;VEG-0089")，不是单一可查找的SKU——
  // Postgres这边的materials_merged_into_sku_fkey要求这个字段要么是NULL要么是一个
  // 真实存在的SKU，两边模型不匹配。这类描述性文本不写进这个字段(会违反外键)，
  // 完整原文已经在raw字段里保留(供以后查证)，这里只是不让它去撞外键约束。
  const skuSet = new Set(materials.map((x) => x.sku));
  let skippedNonSkuMerge = 0;
  for (const m of materials) {
    if (!m.merged_into_sku) continue;
    if (!skuSet.has(m.merged_into_sku)) {
      skippedNonSkuMerge++;
      console.warn(`跳过非真实SKU的merged_into_sku(已保留在raw字段里)：${m.sku} -> ${m.merged_into_sku}`);
      continue;
    }
    await client.query(`UPDATE materials SET merged_into_sku = $1 WHERE sku = $2`, [m.merged_into_sku, m.sku]);
  }
  if (skippedNonSkuMerge > 0) {
    console.log(`共跳过 ${skippedNonSkuMerge} 条非真实SKU的merged_into_sku`);
  }

  console.log(`materials: ${materials.length} 条已写入`);
}

async function loadSchedule(client) {
  const schedule = readJson("schedule.json");

  // 每次全量重建：先清空再插入，避免飞书那边删掉的排班在数据库里留着删不掉的残留。
  await client.query(`TRUNCATE supplier_delivery_schedule`);

  for (const s of schedule) {
    await client.query(
      `INSERT INTO supplier_delivery_schedule (supplier_id, weekday, supplier_type, feishu_record_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (supplier_id, weekday, supplier_type) DO UPDATE SET feishu_record_id = EXCLUDED.feishu_record_id`,
      [s.supplier_id, s.weekday, s.supplier_type, s.feishu_record_id]
    );
  }

  console.log(`schedule: ${schedule.length} 条已写入`);
}

async function main() {
  await withTransaction(async (client) => {
    await loadSuppliers(client);
    await loadCategories(client);
    await loadMaterials(client);
    await loadSchedule(client);
  });

  await pool.end();
}

main().catch((error) => {
  console.error("导入失败：", error);
  process.exit(1);
});
