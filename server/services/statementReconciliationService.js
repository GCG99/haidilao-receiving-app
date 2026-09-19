// 供应商对账单(Statement) discrepancy核对逻辑——从 import_p2_statements_ocr.mjs 抽出成
// 纯函数，方便单元测试锁定行为，避免2026-09-19发现的那个真实bug再犯：原公式只比较
// sum(逐行明细金额) vs closing_balance，完全没算上账户的期初余额(opening_balance)，
// 导致任何有跨期结转余额的正常贸易账户都被误判成discrepancy(见migration 0012)。
//
// 正确关系：opening_balance + sum(逐行明细金额) ≈ closing_balance。
export function computeStatementReconciliation({ closingBalance, openingBalance, items }) {
  const opening = typeof openingBalance === "number" ? openingBalance : 0;
  const sumOfAmounts = (items || []).reduce(
    (s, it) => s + (typeof it.amount === "number" ? it.amount : 0),
    0
  );
  const closing = closingBalance;
  const hasBothTotals = typeof closing === "number" && (items || []).length > 0;
  const discrepancy = hasBothTotals ? Number((closing - opening - sumOfAmounts).toFixed(2)) : null;
  // 千分之一或1澳元(取较大者)以内的差异算浮点/取整噪音，不算真实不平——门槛本身不是
  // 精确计算出来的，只是一个防止把正常四舍五入噪音当成异常来标记的粗筛门槛。
  const tolerance = Math.max(1, Math.abs(closing || 0) * 0.001);
  const status = discrepancy === null ? "new" : Math.abs(discrepancy) <= tolerance ? "reconciled" : "discrepancy";
  return { opening, sumOfAmounts, discrepancy, tolerance, status };
}
