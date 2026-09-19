// 覆盖invoices.js里这个项目历史上真实出过bug/需要锁定行为的部分：
// - invoice_no可空 + (supplier_id,invoice_no)冲突时返回409而不是500
// - PUT /:id/items 对不存在的发票要404(不能因为FK报错变成500)，且不写审计日志
// - PUT /:id/items 对存在的发票要在同一事务里写审计日志(第3轮ChatGPT复核修的真实bug)
// - 未登录访问要401
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeAuthCookie } from "../helpers/testServer.mjs";
import { pool, createCleanupTracker, testTag } from "../helpers/testDb.mjs";
import { withTransaction } from "../../server/db/pool.js";
import { updateInvoiceFields } from "../../server/services/invoiceService.js";

const SUPPLIER_ID = "SUP-001"; // 真实存在的供应商，测试只创建/清理发票行，不改供应商本身

let server;
const cleanup = createCleanupTracker();

test.before(async () => {
  server = await startTestServer();
});

test.after(async () => {
  await cleanup.cleanupAll();
  await server.close();
  await pool.end();
});

function authHeaders() {
  return { Cookie: makeAuthCookie() };
}

async function uploadInvoice(supplierId = SUPPLIER_ID) {
  const form = new FormData();
  form.append("supplier_id", supplierId);
  // 每次调用内容都不同(嵌入随机tag)，避免sha256去重把好几次上传合并成同一个
  // source_file——之前踩过这个坑：固定内容导致多次测试run之间共享同一行，
  // 某次测试中途失败没清理干净，下次run因为sha256"reused"又挂上去，越滚越多。
  form.append("file", new Blob([Buffer.from(`%PDF-1.4 test fixture ${testTag()}`)], { type: "application/pdf" }), "test.pdf");
  const res = await fetch(`${server.baseUrl}/api/invoices/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: form
  });
  const body = await res.json();
  if (res.status === 200) {
    cleanup.track("invoices", "id", body.invoice.id);
    cleanup.track("source_files", "id", body.source_file.id);
  }
  return { status: res.status, body };
}

test("未登录访问 GET /api/invoices 返回401", async () => {
  const res = await fetch(`${server.baseUrl}/api/invoices`);
  assert.equal(res.status, 401);
});

test("POST /upload 缺 supplier_id 返回400", async () => {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("x")], { type: "application/pdf" }), "test.pdf");
  const res = await fetch(`${server.baseUrl}/api/invoices/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: form
  });
  assert.equal(res.status, 400);
});

test("POST /upload 成功创建invoice，status=new，invoice_no=NULL", async () => {
  const { status, body } = await uploadInvoice();
  assert.equal(status, 200);
  assert.equal(body.invoice.status, "new");
  assert.equal(body.invoice.invoice_no, null);
  assert.equal(body.invoice.supplier_id, SUPPLIER_ID);
});

test("同一供应商+发票号重复时，/fields 返回409而不是500，并带上existing_invoice", async () => {
  const invA = await uploadInvoice();
  const invB = await uploadInvoice();
  const invoiceNo = testTag("INV");

  const setA = await fetch(`${server.baseUrl}/api/invoices/${invA.body.invoice.id}/fields`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ invoice_no: invoiceNo })
  });
  assert.equal(setA.status, 200);

  const setB = await fetch(`${server.baseUrl}/api/invoices/${invB.body.invoice.id}/fields`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ invoice_no: invoiceNo })
  });
  assert.equal(setB.status, 409);
  const setBBody = await setB.json();
  assert.equal(setBBody.code, "DUPLICATE_INVOICE_NO");
  assert.equal(setBBody.existing_invoice.id, invA.body.invoice.id);
});

test("PUT /:id/items 对不存在的发票返回404，且不写审计日志", async () => {
  const fakeId = 999999999; // 真实序列不可能到这个值，且不在cleanup tracker里，安全
  const res = await fetch(`${server.baseUrl}/api/invoices/${fakeId}/items`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ items: [{ supplier_item_name: "测试物料", quantity: 1, unit_price: 1, amount: 1 }] })
  });
  assert.equal(res.status, 404);

  const { rows } = await pool.query(
    "SELECT id FROM audit_logs WHERE entity_type = 'invoice_items' AND entity_id = $1",
    [String(fakeId)]
  );
  assert.equal(rows.length, 0, "不存在的发票不应该产生审计日志");
});

test("PUT /:id/items 对存在的发票成功写入，且同一事务里落了审计日志", async () => {
  const inv = await uploadInvoice();
  const res = await fetch(`${server.baseUrl}/api/invoices/${inv.body.invoice.id}/items`, {
    method: "PUT",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      items: [{ supplier_item_name: "测试物料A", quantity: 2, unit_price: 5, amount: 10 }]
    })
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.items.length, 1);
  cleanup.track("invoice_items", "invoice_id", inv.body.invoice.id);

  const { rows } = await pool.query(
    "SELECT id FROM audit_logs WHERE entity_type = 'invoice_items' AND entity_id = $1",
    [String(inv.body.invoice.id)]
  );
  assert.ok(rows.length >= 1, "存在的发票替换明细行应该写审计日志");
});

// 2026-09-19新增：之前完全没有全局错误处理中间件，multer的fileFilter/MulterError
// 会落到Express默认错误页(HTML，不是JSON)，前端fetch().json()会解析失败、看到的
// 是一个跟其他接口完全不一致的报错体验。这两个测试锁定新加的错误处理中间件行为。
test("POST /upload 不支持的文件类型(fileFilter拒绝)返回400 JSON而不是500/HTML", async () => {
  const form = new FormData();
  form.append("supplier_id", SUPPLIER_ID);
  form.append("file", new Blob([Buffer.from("not a real document")], { type: "text/plain" }), "test.txt");
  const res = await fetch(`${server.baseUrl}/api/invoices/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: form
  });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("content-type")?.includes("application/json"), true);
  const body = await res.json();
  assert.match(body.message, /PDF.*JPEG.*PNG.*WEBP/);
});

// 2026-09-19发现：app从未设置trust proxy，生产环境(Render，前面有反向代理)
// 的req.ip读到的一直是Render内部代理地址，不是真实用户IP——用已登录浏览器
// 读生产/api/audit-logs验证过是真实bug(ip字段全是10.x.x.x私有网段)。
// 加了app.set("trust proxy", 1)后，Express应该信任X-Forwarded-For头。
// 这个测试模拟"反向代理转发请求"的场景：手动带上X-Forwarded-For头，
// 断言写入audit_logs的ip字段反映的是这个头的值，不是测试用的127.0.0.1回环地址。
test("trust proxy生效：带X-Forwarded-For头的请求，audit_logs.ip记录的是转发的地址不是回环地址", async () => {
  const inv = await uploadInvoice();
  const fakeClientIp = "203.0.113.42"; // TEST-NET-3，RFC5737保留给文档/测试用，不是真实地址
  const res = await fetch(`${server.baseUrl}/api/invoices/${inv.body.invoice.id}/fields`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json", "X-Forwarded-For": fakeClientIp },
    body: JSON.stringify({ invoice_no: testTag("INV") })
  });
  assert.equal(res.status, 200);

  const { rows } = await pool.query(
    "SELECT ip FROM audit_logs WHERE entity_type = 'invoice' AND entity_id = $1 ORDER BY id DESC LIMIT 1",
    [String(inv.body.invoice.id)]
  );
  assert.equal(rows.length, 1);
  assert.match(rows[0].ip, new RegExp(fakeClientIp.replace(/\./g, "\\.")));
  assert.doesNotMatch(rows[0].ip, /127\.0\.0\.1|::1|::ffff:127/, "不应该是测试请求本身的回环地址");
});

// 2026-09-19新增：migration 0013加了ocr_raw_response(jsonb)字段，只有/parse这条OCR路径
// 会写它(人工录入/fields不接受这个字段，避免任意用户输入伪造"OCR原始响应")。直接测
// service层的updateInvoiceFields，不经过HTTP路由——路由层刻意不从req.body读这个字段。
test("updateInvoiceFields: 传ocr_raw_response会存进jsonb字段并完整往返；不传不会清空已有值", async () => {
  const inv = await uploadInvoice();
  const rawResponse = {
    is_invoice: true,
    header: { invoice_no: testTag("INV"), confidence: 0.9, source_quotes: { invoice_no: "Invoice No: 12345" } },
    items: [{ supplier_item_name: "测试物料", confidence: 0.85, source_quote: "测试物料 x1 $10.00" }],
    notes: null
  };

  await withTransaction((client) => updateInvoiceFields(client, inv.body.invoice.id, { total_amount: 10, ocr_raw_response: rawResponse }, { user: { name: "测试" }, ip: "127.0.0.1" }));

  const { rows: r1 } = await pool.query("SELECT ocr_raw_response FROM invoices WHERE id = $1", [inv.body.invoice.id]);
  assert.deepEqual(r1[0].ocr_raw_response, rawResponse);

  // 再调一次不传ocr_raw_response(模拟人工录入/fields路径)，已存的raw response不应被清空(COALESCE)
  await withTransaction((client) => updateInvoiceFields(client, inv.body.invoice.id, { total_amount: 20 }, { user: { name: "测试" }, ip: "127.0.0.1" }));
  const { rows: r2 } = await pool.query("SELECT ocr_raw_response, total_amount FROM invoices WHERE id = $1", [inv.body.invoice.id]);
  assert.deepEqual(r2[0].ocr_raw_response, rawResponse, "人工录入不传这个字段时，已有的OCR原始响应不应被清空");
  assert.equal(r2[0].total_amount, "20.00");
});

test("POST /upload 超过大小限制(MulterError LIMIT_FILE_SIZE)返回400 JSON而不是崩溃", async () => {
  const oversized = Buffer.alloc(21 * 1024 * 1024, 1); // 路由限制是20MB
  const form = new FormData();
  form.append("supplier_id", SUPPLIER_ID);
  form.append("file", new Blob([oversized], { type: "application/pdf" }), "big.pdf");
  const res = await fetch(`${server.baseUrl}/api/invoices/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: form
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "LIMIT_FILE_SIZE");
});
