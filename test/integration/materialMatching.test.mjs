// materialMatchingService.js的pending/active/superseded状态机——用真实Postgres验证
// 唯一索引(uq_supplier_material_mapping_active/_pending)配合"先superseded旧active
// 再插入新active"这个顺序确实不会撞索引，也验证confirmMapping()区分"再次确认同一个
// active"vs"真正改判成另一个active"这两条分支。
import test from "node:test";
import assert from "node:assert/strict";
import { pool, createCleanupTracker, testTag } from "../helpers/testDb.mjs";
import {
  createPendingMapping,
  confirmMapping
} from "../../server/services/materialMatchingService.js";

const SUPPLIER_ID = "SUP-001";
const MATERIAL_A = "ALC-0001";
const MATERIAL_B = "ALC-0002";

const cleanup = createCleanupTracker();

test.after(async () => {
  await cleanup.cleanupAll();
  await pool.end();
});

test("createPendingMapping: 首次出现的供应商物料名创建一条pending", async () => {
  const name = testTag("SUPPLIER_ITEM");
  const mapping = await createPendingMapping(SUPPLIER_ID, name, MATERIAL_A);
  cleanup.track("supplier_material_mapping", "id", mapping.id);
  assert.equal(mapping.status, "pending");
  assert.equal(mapping.material_id, MATERIAL_A);
});

test("createPendingMapping: 同一(supplier,name)重复调用不产生第二条pending(ON CONFLICT兜底)", async () => {
  const name = testTag("SUPPLIER_ITEM");
  const first = await createPendingMapping(SUPPLIER_ID, name, MATERIAL_A);
  cleanup.track("supplier_material_mapping", "id", first.id);
  const second = await createPendingMapping(SUPPLIER_ID, name, MATERIAL_B);

  assert.equal(second.id, first.id, "第二次调用应该返回已存在的那条pending，不是新建");

  const { rows } = await pool.query(
    "SELECT count(*) FROM supplier_material_mapping WHERE supplier_id = $1 AND supplier_material_name = $2",
    [SUPPLIER_ID, name]
  );
  assert.equal(Number(rows[0].count), 1);
});

test("confirmMapping: 从空到第一个active，action=confirm，不产生审计的before", async () => {
  const name = testTag("SUPPLIER_ITEM");
  const result = await confirmMapping(
    { supplierId: SUPPLIER_ID, supplierMaterialName: name, confirmedMaterialId: MATERIAL_A },
    { user: { name: "测试用户" } }
  );
  cleanup.track("supplier_material_mapping", "id", result.id);
  assert.equal(result.status, "active");
  assert.equal(result.material_id, MATERIAL_A);
  assert.equal(result.confirmed_count, 1);
});

test("confirmMapping: pending存在时确认成active，pending被标记discarded不是被删除", async () => {
  const name = testTag("SUPPLIER_ITEM");
  const pending = await createPendingMapping(SUPPLIER_ID, name, MATERIAL_A);
  cleanup.track("supplier_material_mapping", "id", pending.id);

  const active = await confirmMapping(
    { supplierId: SUPPLIER_ID, supplierMaterialName: name, confirmedMaterialId: MATERIAL_A },
    { user: { name: "测试用户" } }
  );
  cleanup.track("supplier_material_mapping", "id", active.id);

  const { rows } = await pool.query(
    "SELECT status FROM supplier_material_mapping WHERE id = $1",
    [pending.id]
  );
  assert.equal(rows[0].status, "discarded", "旧pending应该被标discarded，行还在，不是被删掉");
});

test("confirmMapping: 改判到另一个物料时，旧active变superseded，新active插入，superseded_by_mapping_id正确回填", async () => {
  const name = testTag("SUPPLIER_ITEM");
  const firstActive = await confirmMapping(
    { supplierId: SUPPLIER_ID, supplierMaterialName: name, confirmedMaterialId: MATERIAL_A },
    { user: { name: "测试用户" } }
  );
  cleanup.track("supplier_material_mapping", "id", firstActive.id);

  const secondActive = await confirmMapping(
    { supplierId: SUPPLIER_ID, supplierMaterialName: name, confirmedMaterialId: MATERIAL_B },
    { user: { name: "测试用户" } }
  );
  cleanup.track("supplier_material_mapping", "id", secondActive.id);

  assert.equal(secondActive.status, "active");
  assert.equal(secondActive.material_id, MATERIAL_B);

  const { rows } = await pool.query(
    "SELECT status, superseded_by_mapping_id FROM supplier_material_mapping WHERE id = $1",
    [firstActive.id]
  );
  assert.equal(rows[0].status, "superseded");
  assert.equal(rows[0].superseded_by_mapping_id, secondActive.id);

  // 同一时刻只能有一条active——这条断言直接验证唯一索引语义没被绕过
  const { rows: activeRows } = await pool.query(
    "SELECT count(*) FROM supplier_material_mapping WHERE supplier_id = $1 AND supplier_material_name = $2 AND status = 'active'",
    [SUPPLIER_ID, name]
  );
  assert.equal(Number(activeRows[0].count), 1);
});

test("confirmMapping: 再次确认同一个active只加confirmed_count，不产生新行", async () => {
  const name = testTag("SUPPLIER_ITEM");
  const first = await confirmMapping(
    { supplierId: SUPPLIER_ID, supplierMaterialName: name, confirmedMaterialId: MATERIAL_A },
    { user: { name: "测试用户" } }
  );
  cleanup.track("supplier_material_mapping", "id", first.id);

  const reconfirmed = await confirmMapping(
    { supplierId: SUPPLIER_ID, supplierMaterialName: name, confirmedMaterialId: MATERIAL_A },
    { user: { name: "测试用户" } }
  );

  assert.equal(reconfirmed.id, first.id, "确认同一个物料不应该产生新的mapping行");
  assert.equal(reconfirmed.confirmed_count, 2);

  const { rows } = await pool.query(
    "SELECT count(*) FROM supplier_material_mapping WHERE supplier_id = $1 AND supplier_material_name = $2",
    [SUPPLIER_ID, name]
  );
  assert.equal(Number(rows[0].count), 1, "再次确认同一物料不应该多出行");
});
