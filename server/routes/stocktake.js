// 周盘点"协助填写"：到点提醒该盘点的物料清单、预设默认值(上次盘点数+期间入库量，
// 简单加减法不是ML预测——单店规模+每周频率现阶段数据量不够训练模型，见
// P2_设计文档/线A线B整合规划.md第三节)，填的数字和预设差太多时前端自己判断要不要提示，
// 后端只负责把两个数字都给前端，不在后端定"差太多"的阈值(这是产品/展示层的判断)。
//
// "本周"按自然周一到周日计算，明确用Australia/Brisbane时区(门店所在地，昆士兰州
// 全年不实行夏令时，不用担心DST切换)，不依赖服务器自己的时区设置——服务器大概率
// 部署在别的时区(Render默认UTC)，如果不明确指定时区，"本周"的周界会算错。
import express from "express";
import { pool, withTransaction } from "../db/pool.js";
import { writeAuditLog, auditContextFromRequest } from "../services/auditService.js";

const STORE_TZ = "Australia/Brisbane";

export function createStocktakeRouter({ requireLogin }) {
  const router = express.Router();

  // 配置：哪些物料需要每周盘点
  router.get("/config", requireLogin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT c.*, m.name AS material_name, m.unit AS material_unit
         FROM stocktake_material_config c
         JOIN materials m ON m.sku = c.material_id
         WHERE c.active = true
         ORDER BY m.name`
      );
      res.json({ config: rows });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.post("/config", requireLogin, async (req, res) => {
    const { material_id: materialId } = req.body;
    if (!materialId) return res.status(400).json({ message: "material_id 必填。" });

    try {
      const { rows } = await pool.query(
        `INSERT INTO stocktake_material_config (material_id, active)
         VALUES ($1, true)
         ON CONFLICT (material_id) DO UPDATE SET active = true
         RETURNING *`,
        [materialId]
      );
      res.json({ config: rows[0] });
    } catch (error) {
      if (error.code === "23503") {
        return res.status(400).json({ message: "material_id 在物料主数据里不存在。" });
      }
      res.status(500).json({ message: error.message });
    }
  });

  router.delete("/config/:materialId", requireLogin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE stocktake_material_config SET active = false WHERE material_id = $1 RETURNING *`,
        [req.params.materialId]
      );
      if (rows.length === 0) return res.status(404).json({ message: "这个物料不在盘点配置清单里。" });
      res.json({ config: rows[0] });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // 本周该盘点的物料：配置清单里的全部active物料，附带预设默认值(来自stock_estimated_current视图)，
  // 以及"本周(周一到周日，Brisbane时区)是否已经盘过"的标记
  router.get("/due", requireLogin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `WITH week_bounds AS (
           SELECT date_trunc('week', now() AT TIME ZONE $1)::date AS week_start
         )
         SELECT
           c.material_id,
           m.name AS material_name,
           m.unit AS material_unit,
           e.estimated_current_quantity AS predicted_quantity,
           e.last_stocktake_at,
           r.id AS this_week_record_id,
           r.counted_quantity AS this_week_counted_quantity,
           r.counted_at AS this_week_counted_at
         FROM stocktake_material_config c
         JOIN materials m ON m.sku = c.material_id
         LEFT JOIN stock_estimated_current e ON e.material_id = c.material_id
         LEFT JOIN LATERAL (
           SELECT id, counted_quantity, counted_at
           FROM stocktake_records sr, week_bounds wb
           WHERE sr.material_id = c.material_id
             AND (sr.counted_at AT TIME ZONE $1)::date >= wb.week_start
           ORDER BY sr.counted_at DESC
           LIMIT 1
         ) r ON true
         WHERE c.active = true
         ORDER BY m.name`,
        [STORE_TZ]
      );
      res.json({ due: rows });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // 提交一条盘点记录：predicted_quantity在提交时由服务端重新计算并存下来，
  // 不信任前端传来的值——避免前端拿到的预设值是几分钟前的、跟提交时的实际库存流水对不上。
  router.post("/records", requireLogin, async (req, res) => {
    const { material_id: materialId, counted_quantity: countedQuantity, note } = req.body;
    if (!materialId) return res.status(400).json({ message: "material_id 必填。" });
    if (!(countedQuantity >= 0)) return res.status(400).json({ message: "counted_quantity 必须是不小于0的数字。" });

    try {
      const record = await withTransaction(async (client) => {
        const { rows: predictedRows } = await client.query(
          `SELECT estimated_current_quantity FROM stock_estimated_current WHERE material_id = $1`,
          [materialId]
        );
        const predictedQuantity = predictedRows[0]?.estimated_current_quantity ?? null;

        const { rows } = await client.query(
          `INSERT INTO stocktake_records (material_id, counted_quantity, predicted_quantity, counted_by, note)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [materialId, countedQuantity, predictedQuantity, req.user?.name || null, note || null]
        );
        const created = rows[0];

        await writeAuditLog(
          { ...auditContextFromRequest(req), action: "create", entityType: "stocktake_record", entityId: created.id, afterJson: created },
          client
        );

        return created;
      });

      res.json({ record });
    } catch (error) {
      if (error.code === "23503") {
        return res.status(400).json({ message: "material_id 在物料主数据里不存在。" });
      }
      res.status(500).json({ message: error.message });
    }
  });

  router.get("/records", requireLogin, async (req, res) => {
    try {
      const { material_id: materialId, from, to } = req.query;
      const conditions = [];
      const params = [];
      if (materialId) { params.push(materialId); conditions.push(`sr.material_id = $${params.length}`); }
      if (from) { params.push(from); conditions.push(`sr.counted_at >= $${params.length}`); }
      if (to) { params.push(to); conditions.push(`sr.counted_at <= $${params.length}`); }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const { rows } = await pool.query(
        `SELECT sr.*, m.name AS material_name, m.unit AS material_unit
         FROM stocktake_records sr
         JOIN materials m ON m.sku = sr.material_id
         ${where}
         ORDER BY sr.counted_at DESC LIMIT 200`,
        params
      );
      res.json({ records: rows });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.get("/estimated-current", requireLogin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT e.*, m.name AS material_name, m.unit AS material_unit
         FROM stock_estimated_current e
         JOIN materials m ON m.sku = e.material_id
         ORDER BY m.name`
      );
      res.json({ estimated_current: rows });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  return router;
}
