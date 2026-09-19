import { useEffect, useMemo, useState } from "react";
import { AuthLoadingScreen, LoginScreen } from "./AuthScreens";
import { useAuth } from "../hooks/useAuth";

interface Statement {
  id: number;
  supplier_id: string;
  statement_date: string | null;
  account_no: string | null;
  total_balance: string | null;
  status: string;
  source_file_id: number | null;
  created_at: string;
}

interface StatementItem {
  id: number;
  transaction_date: string | null;
  reference: string | null;
  transaction_type: string | null;
  amount: string | null;
  running_balance: string | null;
  due_date: string | null;
  matched_invoice_id: number | null;
  matched_credit_id: number | null;
}

interface Supplier {
  id: string;
  name: string;
}

const STATUS_LABEL: Record<string, string> = {
  new: "新建(待核对)",
  reconciled: "已对平",
  discrepancy: "有差异"
};

function statusBadgeClass(status: string) {
  if (status === "reconciled") return "wb-badge wb-badge-ok";
  if (status === "discrepancy") return "wb-badge wb-badge-warn";
  return "wb-badge";
}

function fmtMoney(v: string | number | null) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : String(v);
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: options?.body instanceof FormData ? options.headers : { "Content-Type": "application/json", ...options?.headers }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `请求失败(${res.status})`);
  return data as T;
}

function StatementDetail({ id, supplierName, onBack }: { id: number; supplierName: string; onBack: () => void }) {
  const [statement, setStatement] = useState<Statement | null>(null);
  const [items, setItems] = useState<StatementItem[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    api<{ statement: Statement; items: StatementItem[] }>(`/api/statements/${id}`)
      .then((data) => {
        setStatement(data.statement);
        setItems(data.items);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  if (error) return <p className="wb-error">{error}</p>;
  if (!statement) return <div className="loading">正在读取对账单……</div>;

  return (
    <div className="wb-detail">
      <button className="secondary-button" type="button" onClick={onBack}>← 返回列表</button>

      <section className="card wb-card">
        <div className="wb-detail-head">
          <div>
            <strong>{supplierName}</strong>
            <span className={statusBadgeClass(statement.status)}>{STATUS_LABEL[statement.status] || statement.status}</span>
          </div>
          <div className="wb-amount">{fmtMoney(statement.total_balance)}</div>
        </div>
        <div className="wb-fields">
          <span>对账单日期：{statement.statement_date || "—"}</span>
          <span>账户号：{statement.account_no || "—"}</span>
          {statement.status === "discrepancy" && (
            <span className="wb-confidence">⚠️ 明细合计跟期末总额对不上，需要人工核对原始单据</span>
          )}
        </div>
      </section>

      {error && <p className="wb-error">{error}</p>}

      <section className="card wb-card">
        <h4>对账单明细（{items.length}行）</h4>
        {items.length === 0 ? (
          <p>没有明细行。</p>
        ) : (
          <table className="wb-table">
            <thead>
              <tr><th>日期</th><th>单据号</th><th>类型</th><th>金额</th><th>到期日</th><th>匹配状态</th></tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const matched = it.matched_invoice_id !== null || it.matched_credit_id !== null;
                return (
                  <tr key={it.id}>
                    <td>{it.transaction_date || "—"}</td>
                    <td>{it.reference || "—"}</td>
                    <td>{it.transaction_type || "—"}</td>
                    <td>{fmtMoney(it.amount)}</td>
                    <td>{it.due_date || "—"}</td>
                    <td>
                      <span className={matched ? "wb-badge wb-badge-ok" : "wb-badge"}>
                        {matched ? "已匹配" : "未匹配"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

export function StatementsPage() {
  const { authLoading, user } = useAuth();
  const [statements, setStatements] = useState<Statement[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    Promise.all([
      api<{ statements: Statement[] }>("/api/statements"),
      api<{ suppliers: Supplier[] }>("/api/workbench/suppliers")
    ])
      .then(([st, sup]) => {
        setStatements(st.statements);
        setSuppliers(sup.suppliers);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  const supplierName = useMemo(() => {
    const map = new Map(suppliers.map((s) => [s.id, s.name]));
    return (id: string) => map.get(id) || id;
  }, [suppliers]);

  const filtered = statusFilter ? statements.filter((s) => s.status === statusFilter) : statements;
  const discrepancyCount = statements.filter((s) => s.status === "discrepancy").length;

  if (authLoading) return <AuthLoadingScreen />;
  if (!user) return <LoginScreen />;

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <div className="eyebrow">WORKBENCH · 对账单</div>
          <h1>供应商对账单</h1>
        </div>
        <div className="operator">
          <span>{user.name}</span>
        </div>
      </header>

      <a className="overview-link" href="/" target="_self" rel="noreferrer">
        ← 返回每日收货
      </a>

      {selectedId !== null ? (
        (() => {
          const st = statements.find((s) => s.id === selectedId);
          return (
            <StatementDetail
              id={selectedId}
              supplierName={st ? supplierName(st.supplier_id) : ""}
              onBack={() => setSelectedId(null)}
            />
          );
        })()
      ) : loading ? (
        <div className="loading">正在读取对账单数据……</div>
      ) : error ? (
        <div className="loading">对账单功能还没启用，或读取失败：{error}</div>
      ) : (
        <>
          <section className="summary-card">
            <div>
              <strong>共 {statements.length} 份对账单</strong>
              <span>{discrepancyCount > 0 ? `其中 ${discrepancyCount} 份有差异，需要人工核对` : "全部对账单状态正常"}</span>
            </div>
          </section>

          <section className="wb-filters">
            {["", "discrepancy", "reconciled", "new"].map((s) => (
              <button
                key={s || "all"}
                className={statusFilter === s ? "primary-button" : "secondary-button"}
                type="button"
                onClick={() => setStatusFilter(s)}
              >
                {s ? STATUS_LABEL[s] : "全部"}
              </button>
            ))}
          </section>

          <section className="supplier-list">
            {filtered.length === 0 ? (
              <div className="loading">没有符合条件的对账单。</div>
            ) : (
              filtered.map((st) => (
                <div key={st.id} className="card wb-invoice-row" onClick={() => setSelectedId(st.id)}>
                  <div>
                    <strong>{supplierName(st.supplier_id)}</strong>
                    <span className={statusBadgeClass(st.status)}>{STATUS_LABEL[st.status] || st.status}</span>
                    <span style={{ color: "#888", fontSize: 11 }}>{st.statement_date || "日期待识别"}</span>
                  </div>
                  <div className="wb-amount">{fmtMoney(st.total_balance)}</div>
                </div>
              ))
            )}
          </section>
        </>
      )}
    </main>
  );
}
