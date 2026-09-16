import { pool } from "../db/pool.js";

// 三方匹配只产生"建议"，从不自动写 invoice_receiving_links / invoice_erp_receipt_links——
// 必须经过 POST /api/invoices/:id/match 由人工确认后才落库。
// 日期只能辅助评分，不能作为唯一匹配条件（文档明确要求）。
const DATE_WINDOW_DAYS = 3;
const AMOUNT_CLOSE_RATIO = 0.05;

function amountsClose(a, b) {
  if (a == null || b == null) return false;
  const base = Math.max(Math.abs(Number(a)), Math.abs(Number(b)), 1);
  return Math.abs(Number(a) - Number(b)) / base <= AMOUNT_CLOSE_RATIO;
}

function withinDateWindow(dateA, dateB, days = DATE_WINDOW_DAYS) {
  if (!dateA || !dateB) return false;
  const diffMs = Math.abs(new Date(dateA).getTime() - new Date(dateB).getTime());
  return diffMs <= days * 24 * 60 * 60 * 1000;
}

async function getInvoiceWithItems(invoiceId) {
  const { rows: invoiceRows } = await pool.query(
    "SELECT * FROM invoices WHERE id = $1",
    [invoiceId]
  );
  const invoice = invoiceRows[0];
  if (!invoice) return null;

  const { rows: items } = await pool.query(
    "SELECT * FROM invoice_items WHERE invoice_id = $1",
    [invoiceId]
  );

  return { invoice, items };
}

function extractDocketNos(items) {
  return [...new Set(items.map((item) => item.delivery_docket_no).filter(Boolean))];
}

function extractPurchaseOrderNos(items) {
  return [...new Set(items.map((item) => item.purchase_order_no).filter(Boolean))];
}

// 评分公式（可解释的加权评分，不用机器学习）：
//   PO 号精确匹配        +40
//   送货单号精确匹配      +30
//   金额差异 <= 5%       +20
//   日期在 ±3 天窗口内    +10
// supplier 不一致的候选直接不返回（必要条件，不计分）。
async function suggestReceivingMatches(invoice, docketNos) {
  const { rows: candidates } = await pool.query(
    `SELECT * FROM receiving_records
     WHERE supplier_id = $1
       AND date BETWEEN $2::date - ${DATE_WINDOW_DAYS} AND $2::date + ${DATE_WINDOW_DAYS}`,
    [invoice.supplier_id, invoice.invoice_date]
  );

  return candidates
    .map((record) => {
      let score = 0;
      const reasons = [];

      if (record.delivery_docket_no && docketNos.includes(record.delivery_docket_no)) {
        score += 30;
        reasons.push("delivery_docket_no_match");
      }
      if (withinDateWindow(record.date, invoice.invoice_date)) {
        score += 10;
        reasons.push("date_within_window");
      }

      return { type: "receiving_record", id: record.id, score, reasons, record };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
}

async function suggestErpReceiptMatches(invoice, poNos) {
  let candidates;

  if (poNos.length > 0) {
    ({ rows: candidates } = await pool.query(
      `SELECT * FROM erp_receipts WHERE supplier_id = $1 AND purchase_order_no = ANY($2::text[])`,
      [invoice.supplier_id, poNos]
    ));
  } else {
    ({ rows: candidates } = await pool.query(
      `SELECT * FROM erp_receipts
       WHERE supplier_id = $1
         AND document_date BETWEEN $2::date - ${DATE_WINDOW_DAYS} AND $2::date + ${DATE_WINDOW_DAYS}`,
      [invoice.supplier_id, invoice.invoice_date]
    ));
  }

  return candidates
    .map((receipt) => {
      let score = 0;
      const reasons = [];

      if (poNos.length > 0 && poNos.includes(receipt.purchase_order_no)) {
        score += 40;
        reasons.push("purchase_order_match");
      }
      if (amountsClose(receipt.total_amount, invoice.total_amount)) {
        score += 20;
        reasons.push("amount_close");
      }
      if (withinDateWindow(receipt.document_date, invoice.invoice_date)) {
        score += 10;
        reasons.push("date_within_window");
      }

      return { type: "erp_receipt", id: receipt.id, score, reasons, receipt };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);
}

// 同步计算：这个规模（几十个供应商、每天几十张单子）不需要异步任务队列或缓存，
// 用户点一次"匹配"按钮时现算现返回即可。
export async function suggestMatchesForInvoice(invoiceId) {
  const data = await getInvoiceWithItems(invoiceId);
  if (!data) return null;

  const { invoice, items } = data;
  const docketNos = extractDocketNos(items);
  const poNos = extractPurchaseOrderNos(items);

  const [receivingMatches, erpReceiptMatches] = await Promise.all([
    suggestReceivingMatches(invoice, docketNos),
    suggestErpReceiptMatches(invoice, poNos)
  ]);

  return {
    invoice_id: invoice.id,
    extracted: { docket_nos: docketNos, purchase_order_nos: poNos },
    receiving_record_candidates: receivingMatches,
    erp_receipt_candidates: erpReceiptMatches
  };
}
