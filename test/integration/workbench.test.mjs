// 2026-09-19新增：GET /api/workbench/suppliers之前只返回id/name，前端(WorkbenchPage
// 上传发票弹窗、OpsPage新建叫货记录弹窗)选供应商用的下拉框里，已合并的旧供应商
// (比如SKYJ已经merged_into_id指向领鲜)会跟目标供应商同时出现两个选项，容易选错。
// 加了merged_into_id字段后前端负责过滤，这里锁定后端确实带上了这个字段、且SKYJ这条
// 真实数据能验证到值是对的。
import test from "node:test";
import assert from "node:assert/strict";
import { startTestServer, makeAuthCookie } from "../helpers/testServer.mjs";

let server;

test.before(async () => {
  server = await startTestServer();
});

test.after(async () => {
  await server.close();
});

test("未登录访问 GET /api/workbench/suppliers 返回401", async () => {
  const res = await fetch(`${server.baseUrl}/api/workbench/suppliers`);
  assert.equal(res.status, 401);
});

test("GET /api/workbench/suppliers 带上merged_into_id字段，SKYJ(SUP-023)指向领鲜(SUP-047)", async () => {
  const res = await fetch(`${server.baseUrl}/api/workbench/suppliers`, {
    headers: { Cookie: makeAuthCookie() }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const skyj = body.suppliers.find((s) => s.id === "SUP-023");
  assert.ok(skyj, "SUP-023(SKYJ)应该仍在列表里(展示/历史查找用途不过滤)");
  assert.equal(skyj.merged_into_id, "SUP-047");

  const target = body.suppliers.find((s) => s.id === "SUP-047");
  assert.equal(target.merged_into_id, null, "合并目标本身不应该有merged_into_id");
});
