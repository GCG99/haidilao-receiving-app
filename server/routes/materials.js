import express from "express";
import { pool } from "../db/pool.js";
import {
  createPendingMapping,
  findActiveMapping,
  confirmMapping
} from "../services/materialMatchingService.js";
import { findConversion, confirmConversion } from "../services/unitConversionService.js";

export function createMaterialsRouter({ requireLogin }) {
  const router = express.Router();

  // 注意：`/:sku` 必须放在这个文件最后注册。它是单段通配路由，
  // 如果排在 `/unit-conversion` 这种同样是单段字面路径的路由前面，
  // Express 会按注册顺序优先匹配到 `/:sku`（sku='unit-conversion'），
  // 导致 `/unit-conversion` 的真正处理逻辑永远执行不到（自查时发现的真实bug，已修正）。

  // 录单工作台 Step 1 加载 / 逐行录入时调用：拿这个供应商物料名称当前的映射建议。
  // 命中 active 映射直接返回；没有的话，用简单的名称精确/子串匹配当"AI推荐"占位
  // （规模小，第5轮已经和 ChatGPT 讨论过精确匹配够用，暂不引入模糊/向量匹配）。
  router.get("/mapping/suggest", requireLogin, async (req, res) => {
    const { supplier_id: supplierId, name } = req.query;
    if (!supplierId || !name) {
      return res.status(400).json({ message: "缺少 supplier_id 或 name。" });
    }

    try {
      const active = await findActiveMapping(supplierId, name);
      if (active) {
        return res.json({ mapping: active, source: "active_mapping" });
      }

      const { rows: exactMatches } = await pool.query(
        "SELECT sku, name FROM materials WHERE name = $1 LIMIT 1",
        [name]
      );
      const { rows: fuzzyMatches } = await pool.query(
        "SELECT sku, name FROM materials WHERE name ILIKE $1 LIMIT 5",
        [`%${name}%`]
      );

      const recommended = exactMatches[0] || fuzzyMatches[0] || null;
      let pending = null;
      if (recommended) {
        pending = await createPendingMapping(supplierId, name, recommended.sku);
      }

      res.json({
        mapping: null,
        pending,
        candidates: fuzzyMatches,
        source: recommended ? "suggested" : "no_candidate"
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.post("/mapping/confirm", requireLogin, async (req, res) => {
    const { supplier_id: supplierId, supplier_material_name: name, material_id: materialId, supplier_material_code: code } = req.body;
    if (!supplierId || !name || !materialId) {
      return res.status(400).json({ message: "缺少 supplier_id / supplier_material_name / material_id。" });
    }

    try {
      const mapping = await confirmMapping(
        { supplierId, supplierMaterialName: name, confirmedMaterialId: materialId, supplierMaterialCode: code },
        { user: req.user, ip: req.ip, userAgent: req.get("user-agent") }
      );
      res.json({ mapping });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.get("/unit-conversion", requireLogin, async (req, res) => {
    const { supplier_id: supplierId, material_id: materialId, from_unit: fromUnit, to_unit: toUnit } = req.query;
    try {
      const conversion = await findConversion(supplierId, materialId, fromUnit, toUnit);
      res.json({ conversion, confirmed: Boolean(conversion) });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  router.post("/unit-conversion/confirm", requireLogin, async (req, res) => {
    const { supplier_id: supplierId, material_id: materialId, from_unit: fromUnit, to_unit: toUnit, factor } = req.body;
    if (!supplierId || !materialId || !fromUnit || !toUnit || !factor) {
      return res.status(400).json({ message: "缺少必填字段。" });
    }
    try {
      const conversion = await confirmConversion({
        supplierId, materialId, fromUnit, toUnit, factor, createdBy: req.user.name
      });
      res.json({ conversion });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // 单段通配路由放在最后，避免遮住上面那些同样是单段字面路径的路由。
  router.get("/:sku", requireLogin, async (req, res) => {
    try {
      const { rows } = await pool.query("SELECT * FROM materials WHERE sku = $1", [req.params.sku]);
      if (rows.length === 0) return res.status(404).json({ message: "找不到这个物料。" });
      res.json({ material: rows[0] });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  return router;
}
