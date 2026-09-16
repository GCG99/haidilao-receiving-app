import express from "express";
import { pool } from "../db/pool.js";

export function createAuditLogsRouter({ requireLogin }) {
  const router = express.Router();

  router.get("/", requireLogin, async (req, res) => {
    const { entity_type: entityType, entity_id: entityId } = req.query;
    const conditions = [];
    const params = [];
    if (entityType) { params.push(entityType); conditions.push(`entity_type = $${params.length}`); }
    if (entityId) { params.push(String(entityId)); conditions.push(`entity_id = $${params.length}`); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    try {
      const { rows } = await pool.query(
        `SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT 500`,
        params
      );
      res.json({ audit_logs: rows });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  return router;
}
