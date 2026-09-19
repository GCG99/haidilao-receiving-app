import express from "express";
import { pool } from "../db/pool.js";

export function createWorkbenchRouter({ requireLogin }) {
  const router = express.Router();

  // 首页四块：今日待录单 / 待匹配 Invoice / Credit 待录入 / 异常。
  // 都是只读汇总查询，不产生任何写操作，所以不需要事务、也不需要审计日志。
  router.get("/", requireLogin, async (req, res) => {
    try {
      const [pendingEntry, pendingInvoiceMatch, pendingCreditEntry, discrepancies] = await Promise.all([
        // 已有收货记录、但还没有任何 Invoice 关联上的，需要有人去"继续录单/匹配Invoice"。
        // 注意：不按日期过滤——这是全部历史待录单积压，不只是"今天"的（功能刚上线时会包含所有历史收货记录，
        // 因为 invoice_receiving_links 是这次新建的表，之前的收货记录天然都还没有关联）。
        // 是否需要按日期做"今日/本周"分组是前端UI层的展示选择，不在这里做后端过滤。
        pool.query(
          `SELECT r.id, r.date AS receiving_date, r.supplier_id, r.supplier_name,
                  r.delivery_docket_no, r.status
           FROM receiving_records r
           LEFT JOIN invoice_receiving_links l ON l.receiving_record_id = r.id
           WHERE l.id IS NULL
           ORDER BY r.date DESC
           LIMIT 100`
        ),
        pool.query(
          `SELECT id, supplier_id, invoice_no, invoice_date, total_amount, status
           FROM invoices
           WHERE status IN ('parsed', 'pending_match', 'discrepancy')
           ORDER BY created_at DESC
           LIMIT 100`
        ),
        pool.query(
          `SELECT id, supplier_id, credit_note_no, credit_date, total_amount, status
           FROM credits
           WHERE status IN ('pending_review', 'pending_erp_entry')
           ORDER BY created_at DESC
           LIMIT 100`
        ),
        pool.query(
          `SELECT id, supplier_id, invoice_no, total_amount, status
           FROM invoices
           WHERE status = 'discrepancy'
           ORDER BY created_at DESC
           LIMIT 100`
        )
      ]);

      res.json({
        pending_entry: pendingEntry.rows,
        pending_invoice_match: pendingInvoiceMatch.rows,
        pending_credit_entry: pendingCreditEntry.rows,
        exceptions: discrepancies.rows
      });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  // 供应商全量列表(Postgres suppliers表，不是按日期过滤的飞书配送计划)，
  // 给"录单工作台"上传发票时选供应商用，也被StatementsPage/OpsPage复用做供应商名称
  // 查找。带上merged_into_id(不过滤)，让前端自己决定：新建记录(上传发票/新建叫货)
  // 这类"选一个供应商"的下拉框应该排除已合并的旧供应商(避免选到SKYJ这种已经并入
  // 领鲜、不该再被引用的旧ID)，但按supplier_id反查名称做展示用途的地方不能过滤
  // (万一历史数据还挂在旧ID下，过滤掉会导致查不到名字)。
  router.get("/suppliers", requireLogin, async (req, res) => {
    try {
      const { rows } = await pool.query("SELECT id, name, merged_into_id FROM suppliers ORDER BY name");
      res.json({ suppliers: rows });
    } catch (error) {
      res.status(500).json({ message: error.message });
    }
  });

  return router;
}
