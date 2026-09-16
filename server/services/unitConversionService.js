import { pool } from "../db/pool.js";

// 供应商+物料维度；找不到就返回 null，调用方必须把这一行标"单位待确认"，不能自己猜换算。
export async function findConversion(supplierId, materialId, fromUnit, toUnit) {
  const { rows } = await pool.query(
    `SELECT * FROM unit_conversions
     WHERE supplier_id = $1 AND material_id = $2 AND from_unit = $3 AND to_unit = $4 AND status = 'active'`,
    [supplierId, materialId, fromUnit, toUnit]
  );
  return rows[0] || null;
}

export async function confirmConversion({ supplierId, materialId, fromUnit, toUnit, factor, createdBy = null }) {
  const { rows } = await pool.query(
    `INSERT INTO unit_conversions (supplier_id, material_id, from_unit, to_unit, factor, confirmed_count, last_confirmed_at, created_by)
     VALUES ($1, $2, $3, $4, $5, 1, now(), $6)
     ON CONFLICT (supplier_id, material_id, from_unit, to_unit)
     DO UPDATE SET
       factor = EXCLUDED.factor,
       confirmed_count = unit_conversions.confirmed_count + 1,
       last_confirmed_at = now(),
       status = 'active'
     RETURNING *`,
    [supplierId, materialId, fromUnit, toUnit, factor, createdBy]
  );
  return rows[0];
}
