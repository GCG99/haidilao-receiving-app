// credits.js跟invoices.js是同一套设计模式(共享同一批bug修复历史)，覆盖同样形状的场景：
// - 未登录401
// - upload缺supplier_id 400
// - upload成功，status=new
// - 同供应商+credit_note_no重复时/confirm返回409而不是500
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeAuthCookie } from "../helpers/testServer.mjs";
import { pool, createCleanupTracker, testTag } from "../helpers/testDb.mjs";

const SUPPLIER_ID = "SUP-001";

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

async function uploadCredit(supplierId = SUPPLIER_ID) {
  const form = new FormData();
  form.append("supplier_id", supplierId);
  form.append("file", new Blob([Buffer.from(`%PDF-1.4 test credit ${testTag()}`)], { type: "application/pdf" }), "test.pdf");
  const res = await fetch(`${server.baseUrl}/api/credits/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: form
  });
  const body = await res.json();
  if (res.status === 200) {
    cleanup.track("credits", "id", body.credit.id);
    cleanup.track("source_files", "id", body.source_file.id);
  }
  return { status: res.status, body };
}

test("未登录访问 GET /api/credits 返回401", async () => {
  const res = await fetch(`${server.baseUrl}/api/credits`);
  assert.equal(res.status, 401);
});

test("POST /upload 缺 supplier_id 返回400", async () => {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("x")], { type: "application/pdf" }), "test.pdf");
  const res = await fetch(`${server.baseUrl}/api/credits/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: form
  });
  assert.equal(res.status, 400);
});

test("POST /upload 成功创建credit，status=new", async () => {
  const { status, body } = await uploadCredit();
  assert.equal(status, 200);
  assert.equal(body.credit.status, "new");
  assert.equal(body.credit.supplier_id, SUPPLIER_ID);
});

test("同一供应商+credit_note_no重复时，/confirm 返回409而不是500", async () => {
  const credA = await uploadCredit();
  const credB = await uploadCredit();
  const creditNo = testTag("CN");

  const confirmA = await fetch(`${server.baseUrl}/api/credits/${credA.body.credit.id}/confirm`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ credit_note_no: creditNo })
  });
  assert.equal(confirmA.status, 200);

  const confirmB = await fetch(`${server.baseUrl}/api/credits/${credB.body.credit.id}/confirm`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ credit_note_no: creditNo })
  });
  assert.equal(confirmB.status, 409);
  const confirmBBody = await confirmB.json();
  assert.equal(confirmBBody.code, "DUPLICATE_CREDIT_NO");
});

test("/confirm 对不存在的credit返回404", async () => {
  const res = await fetch(`${server.baseUrl}/api/credits/999999999/confirm`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ credit_note_no: testTag("CN") })
  });
  assert.equal(res.status, 404);
});
