// 锁定2026-09-19修复的真实bug：discrepancy核对公式漏算opening_balance，
// 导致任何有跨期结转余额的正常贸易账户被误判成discrepancy(migration 0012)。
import test from "node:test";
import assert from "node:assert/strict";
import { computeStatementReconciliation } from "../../server/services/statementReconciliationService.js";

test("回归：账户有期初余额时不应该误判discrepancy(2026-09-19真实bug)", () => {
  // 真实案例：Kleanking 7月账单，期初4528.08 + 本期明细406.98 = 期末4935.06
  const result = computeStatementReconciliation({
    closingBalance: 4935.06,
    openingBalance: 4528.08,
    items: [
      { amount: 294.25 }, { amount: 418.35 }, { amount: 460.24 }, { amount: 322.0 },
      { amount: 811.84 }, { amount: -77.0 }, { amount: 301.2 }, { amount: 381.98 },
      { amount: 533.55 }, { amount: -4528.08 }, { amount: 482.51 }, { amount: 378.18 },
      { amount: 244.64 }, { amount: 383.32 }
    ]
  });
  assert.equal(result.status, "reconciled");
  assert.equal(result.discrepancy, 0);
});

test("修复前的bug会复现：不传opening_balance时，同样的账户会被误判discrepancy", () => {
  // 这条测试故意验证"旧行为"，证明新公式确实是靠加上opening才修好的，不是巧合。
  const result = computeStatementReconciliation({
    closingBalance: 4935.06,
    openingBalance: undefined, // 模拟旧代码完全没有这个字段的情况
    items: [
      { amount: 294.25 }, { amount: 418.35 }, { amount: 460.24 }, { amount: 322.0 },
      { amount: 811.84 }, { amount: -77.0 }, { amount: 301.2 }, { amount: 381.98 },
      { amount: 533.55 }, { amount: -4528.08 }, { amount: 482.51 }, { amount: 378.18 },
      { amount: 244.64 }, { amount: 383.32 }
    ]
  });
  assert.equal(result.status, "discrepancy");
  assert.equal(result.discrepancy, 4528.08);
});

test("没有明细行时状态是new，不是discrepancy", () => {
  const result = computeStatementReconciliation({ closingBalance: 100, openingBalance: 0, items: [] });
  assert.equal(result.status, "new");
  assert.equal(result.discrepancy, null);
});

test("没有closing_balance时状态是new", () => {
  const result = computeStatementReconciliation({
    closingBalance: null,
    openingBalance: 0,
    items: [{ amount: 10 }]
  });
  assert.equal(result.status, "new");
});

test("千分之一/1澳元的取整噪音不算真实discrepancy", () => {
  const result = computeStatementReconciliation({
    closingBalance: 1000.0,
    openingBalance: 0,
    items: [{ amount: 999.5 }] // 差0.5，容差max(1, 1000*0.001=1)=1，在容差内
  });
  assert.equal(result.status, "reconciled");
});

test("真实的不平账应该被标成discrepancy，不能因为加了opening_balance就全部消音", () => {
  const result = computeStatementReconciliation({
    closingBalance: 5368.55,
    openingBalance: 0,
    items: [{ amount: 100 }] // 明显对不上，真实差异
  });
  assert.equal(result.status, "discrepancy");
  assert.equal(result.discrepancy, 5268.55);
});

test("非number的amount(比如OCR漏填的null)按0处理，不让脚本炸掉", () => {
  const result = computeStatementReconciliation({
    closingBalance: 36.3,
    openingBalance: 71.54,
    items: [{ amount: null }, { amount: 36.3 }, { amount: -71.54 }]
  });
  assert.equal(result.status, "reconciled");
});
