import { writeAuditLog } from "./auditService.js";

// 从 routes/invoices.js 的 /fields、/items 路由handler里抽出来的共享逻辑（第3轮ChatGPT复核方向），
// 现在被人工录入（/fields、/items）和OCR解析（/parse）两条路径共用，避免出现两份几乎一样的UPDATE语句。
// 所有函数都要求调用方传入已经开启事务的 client，路由层负责 withTransaction 包裹。

export async function updateInvoiceFields(client, invoiceId, fields, auditContext) {
  const { rows: existingRows } = await client.query(
    "SELECT * FROM invoices WHERE id = $1 FOR UPDATE",
    [invoiceId]
  );
  if (existingRows.length === 0) {
    return { notFound: true };
  }
  const before = existingRows[0];

  if (fields.invoice_no) {
    const { rows: conflictRows } = await client.query(
      "SELECT * FROM invoices WHERE supplier_id = $1 AND invoice_no = $2 AND id <> $3",
      [before.supplier_id, fields.invoice_no, before.id]
    );
    if (conflictRows.length > 0) {
      // 按第7轮讨论：不静默吞掉、也不直接500——把已存在的那张发票原样返回，
      // 由前端提示"检测到可能重复"，让人工确认是重复上传还是需要修正发票号。
      return { conflict: conflictRows[0] };
    }
  }

  const { rows: updatedRows } = await client.query(
    `UPDATE invoices SET
       invoice_no = COALESCE($1, invoice_no),
       invoice_date = COALESCE($2, invoice_date),
       due_date = COALESCE($3, due_date),
       invoice_type = COALESCE($4, invoice_type),
       currency = COALESCE($5, currency),
       subtotal = COALESCE($6, subtotal),
       gst = COALESCE($7, gst),
       total_amount = COALESCE($8, total_amount),
       ocr_confidence = COALESCE($9, ocr_confidence),
       parser_version = COALESCE($10, parser_version),
       ocr_raw_response = COALESCE($11, ocr_raw_response),
       status = CASE WHEN status IN ('new', 'parse_failed') THEN 'parsed' ELSE status END,
       updated_at = now()
     WHERE id = $12
     RETURNING *`,
    [
      fields.invoice_no ?? null, fields.invoice_date ?? null, fields.due_date ?? null,
      fields.invoice_type ?? null, fields.currency ?? null, fields.subtotal ?? null,
      fields.gst ?? null, fields.total_amount ?? null, fields.ocr_confidence ?? null,
      fields.parser_version ?? null,
      // 只有OCR路径(/parse)会传这个字段(完整header+items+notes，含每个字段的source_quote
      // 原文摘抄)；人工录入(/fields)不传，COALESCE保留已有值不会被清空。纯审计用途，
      // 不参与任何业务逻辑，下面SELECT/RETURNING带出来的这份数据不应被当成其他字段的数据源。
      fields.ocr_raw_response ? JSON.stringify(fields.ocr_raw_response) : null,
      invoiceId
    ]
  );

  await writeAuditLog(
    {
      ...auditContext,
      action: "update",
      entityType: "invoice",
      entityId: before.id,
      beforeJson: before,
      afterJson: updatedRows[0]
    },
    client
  );

  return { invoice: updatedRows[0] };
}

export async function replaceInvoiceItems(client, invoiceId, items, auditContext) {
  const { rows: invoiceRows } = await client.query(
    "SELECT id FROM invoices WHERE id = $1 FOR UPDATE",
    [invoiceId]
  );
  if (invoiceRows.length === 0) {
    return { notFound: true };
  }

  await client.query("DELETE FROM invoice_items WHERE invoice_id = $1", [invoiceId]);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    await client.query(
      `INSERT INTO invoice_items
         (invoice_id, line_no, supplier_item_name, supplier_item_code, description, material_id,
          quantity, unit, unit_price, amount, gst_rate, gst_amount, delivery_docket_no, purchase_order_no,
          match_status, match_confidence, ocr_line_confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        invoiceId, item.line_no ?? i + 1, item.supplier_item_name || null, item.supplier_item_code || null,
        item.description || null, item.material_id || null, item.quantity ?? null, item.unit || null,
        item.unit_price ?? null, item.amount ?? null, item.gst_rate ?? null, item.gst_amount ?? null,
        item.delivery_docket_no || null, item.purchase_order_no || null,
        item.material_id ? "matched" : "unmatched", item.match_confidence ?? null, item.ocr_line_confidence ?? null
      ]
    );
  }

  await writeAuditLog(
    {
      ...auditContext,
      action: "update",
      entityType: "invoice_items",
      entityId: invoiceId,
      afterJson: { item_count: items.length }
    },
    client
  );

  const { rows } = await client.query(
    "SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY line_no NULLS LAST, id",
    [invoiceId]
  );
  return { items: rows };
}

// OCR判定"这不是一张发票"或者解析过程出错时调用——标记状态，留人工兜底重新触发解析或直接手动录入。
export async function markInvoiceParseFailed(client, invoiceId, notes, auditContext) {
  const { rows } = await client.query(
    `UPDATE invoices SET status = 'parse_failed', updated_at = now() WHERE id = $1 RETURNING *`,
    [invoiceId]
  );
  if (rows.length === 0) {
    return { notFound: true };
  }

  await writeAuditLog(
    {
      ...auditContext,
      action: "update",
      entityType: "invoice",
      entityId: invoiceId,
      afterJson: { status: "parse_failed", notes: notes ?? null }
    },
    client
  );

  return { invoice: rows[0] };
}

// 第8轮讨论的轻量业务规则校验：金额算不拢只提醒，不阻止写入，判断交给人工核对环节。
export function checkInvoiceConsistency(header) {
  const warnings = [];
  if (header.subtotal != null && header.gst != null && header.total_amount != null) {
    const expected = Number(header.subtotal) + Number(header.gst);
    if (Math.abs(expected - Number(header.total_amount)) > 1) {
      warnings.push(
        `subtotal(${header.subtotal}) + gst(${header.gst}) = ${expected.toFixed(2)}，` +
        `跟识别出的 total_amount(${header.total_amount}) 对不上，请人工核对。`
      );
    }
  }
  return warnings;
}
