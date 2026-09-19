import { writeAuditLog } from "./auditService.js";

// credits 表没有明细子表，只有表头字段——跟 invoiceService.js 分开写而不是共享一个"文档表头基础schema"，
// 因为字段名不完全一样（invoice_no vs credit_note_no），第4轮ChatGPT复核结论：分开定义更清晰，重复成本不高。

export async function updateCreditFields(client, creditId, fields, auditContext) {
  const { rows: existingRows } = await client.query(
    "SELECT * FROM credits WHERE id = $1 FOR UPDATE",
    [creditId]
  );
  if (existingRows.length === 0) {
    return { notFound: true };
  }
  const before = existingRows[0];

  if (fields.credit_note_no) {
    const { rows: conflictRows } = await client.query(
      "SELECT id FROM credits WHERE supplier_id = $1 AND credit_note_no = $2 AND id <> $3",
      [before.supplier_id, fields.credit_note_no, before.id]
    );
    if (conflictRows.length > 0) {
      return { conflict: conflictRows[0] };
    }
  }

  const { rows } = await client.query(
    `UPDATE credits SET
       credit_note_no = COALESCE($1, credit_note_no),
       credit_date = COALESCE($2, credit_date),
       invoice_id = COALESCE($3, invoice_id),
       delivery_docket_no = COALESCE($4, delivery_docket_no),
       receiving_record_id = COALESCE($5, receiving_record_id),
       reason = COALESCE($6, reason),
       total_amount = COALESCE($7, total_amount),
       ocr_raw_response = COALESCE($8, ocr_raw_response),
       status = CASE WHEN status IN ('new', 'parse_failed') THEN 'pending_review' ELSE status END,
       updated_at = now()
     WHERE id = $9
     RETURNING *`,
    [
      fields.credit_note_no ?? null, fields.credit_date ?? null, fields.invoice_id ?? null,
      fields.delivery_docket_no ?? null, fields.receiving_record_id ?? null, fields.reason ?? null,
      fields.total_amount ?? null,
      // 只有OCR路径(/parse)传，人工录入(/confirm)不传，COALESCE保留已有值。见
      // invoiceService.js同款字段的注释，两边是同一个设计。
      fields.ocr_raw_response ? JSON.stringify(fields.ocr_raw_response) : null,
      creditId
    ]
  );

  await writeAuditLog(
    { ...auditContext, action: "confirm", entityType: "credit", entityId: creditId, beforeJson: before, afterJson: rows[0] },
    client
  );

  return { credit: rows[0] };
}

export async function markCreditParseFailed(client, creditId, notes, auditContext) {
  const { rows } = await client.query(
    `UPDATE credits SET status = 'parse_failed', updated_at = now() WHERE id = $1 RETURNING *`,
    [creditId]
  );
  if (rows.length === 0) {
    return { notFound: true };
  }

  await writeAuditLog(
    { ...auditContext, action: "update", entityType: "credit", entityId: creditId, afterJson: { status: "parse_failed", notes: notes ?? null } },
    client
  );

  return { credit: rows[0] };
}
