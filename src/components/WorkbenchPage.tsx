import { useEffect, useState } from "react";
import { AuthLoadingScreen, LoginScreen } from "./AuthScreens";
import { useAuth } from "../hooks/useAuth";

interface Invoice {
  id: number;
  supplier_id: number;
  invoice_no: string | null;
  invoice_date: string | null;
  total_amount: string | null;
  status: string;
  ocr_confidence: number | null;
  source: string | null;
}

interface InvoiceItem {
  id: number;
  line_no: number | null;
  supplier_item_name: string | null;
  quantity: string | null;
  unit: string | null;
  unit_price: string | null;
  amount: string | null;
  ocr_line_confidence: number | null;
}

interface Supplier {
  id: number;
  name: string;
  merged_into_id?: string | null;
}

interface WorkbenchSummary {
  pending_entry: { id: number; receiving_date: string; supplier_name: string; delivery_docket_no: string | null }[];
  pending_invoice_match: Invoice[];
  pending_credit_entry: { id: number; credit_note_no: string | null; total_amount: string | null; status: string }[];
  exceptions: Invoice[];
}

interface MatchCandidate {
  type: "receiving_record" | "erp_receipt";
  id: number;
  score: number;
  reasons: string[];
  record?: { id: number; date: string; supplier_name: string; delivery_docket_no: string | null };
  receipt?: { id: number; receipt_date: string; erp_document_no: string; total_amount: string };
}

const STATUS_LABEL: Record<string, string> = {
  new: "新建(待识别)",
  parsed: "已识别(待匹配)",
  parse_failed: "识别失败",
  pending_match: "待匹配",
  matched: "已匹配",
  discrepancy: "有差异",
  confirmed: "已确认"
};

function statusBadgeClass(status: string) {
  if (status === "confirmed" || status === "matched") return "wb-badge wb-badge-ok";
  if (status === "discrepancy" || status === "parse_failed") return "wb-badge wb-badge-warn";
  return "wb-badge";
}

function fmtMoney(v: string | number | null) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : String(v);
}

function fmtConfidence(v: number | null) {
  if (v === null || v === undefined) return null;
  return `${Math.round(v * 100)}%`;
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

function UploadModal({ suppliers, onClose, onUploaded }: { suppliers: Supplier[]; onClose: () => void; onUploaded: (id: number) => void }) {
  const [supplierId, setSupplierId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (!supplierId || !file) {
      setError("请选择供应商和文件。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("supplier_id", supplierId);
      form.append("file", file);
      const data = await api<{ invoice: { id: number } }>("/api/invoices/upload", { method: "POST", body: form });
      onUploaded(data.invoice.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wb-modal-backdrop" onClick={onClose}>
      <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
        <h3>上传发票</h3>
        <label>供应商</label>
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">请选择供应商</option>
          {/* 已合并的旧供应商(比如SKYJ已并入领鲜)不该再被选来关联新发票 */}
          {suppliers.filter((s) => !s.merged_into_id).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
        <label>文件(PDF/图片)</label>
        <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {error && <p className="wb-error">{error}</p>}
        <div className="temp-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>取消</button>
          <button className="primary-button" type="button" onClick={submit} disabled={busy}>
            {busy ? "上传中…" : "上传"}
          </button>
        </div>
      </div>
    </div>
  );
}

function InvoiceDetail({ id, onBack, onChanged }: { id: number; onBack: () => void; onChanged: () => void }) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [items, setItems] = useState<InvoiceItem[]>([]);
  const [candidates, setCandidates] = useState<{ receiving_record_candidates: MatchCandidate[]; erp_receipt_candidates: MatchCandidate[] } | null>(null);
  const [busy, setBusy] = useState<string>("");
  const [error, setError] = useState("");

  const load = () => {
    setError("");
    api<{ invoice: Invoice; items: InvoiceItem[] }>(`/api/invoices/${id}`)
      .then((data) => {
        setInvoice(data.invoice);
        setItems(data.items);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(load, [id]);

  const runParse = async () => {
    setBusy("parse");
    setError("");
    try {
      await api(`/api/invoices/${id}/parse`, { method: "POST" });
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const findMatches = async () => {
    setBusy("match");
    setError("");
    try {
      const data = await api<{ receiving_record_candidates: MatchCandidate[]; erp_receipt_candidates: MatchCandidate[] }>(
        `/api/invoices/${id}/match`,
        { method: "POST" }
      );
      setCandidates(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const confirmMatch = async (candidate: MatchCandidate) => {
    setBusy(`confirm-${candidate.type}-${candidate.id}`);
    setError("");
    try {
      await api(`/api/invoices/${id}/confirm-match`, {
        method: "POST",
        body: JSON.stringify(
          candidate.type === "receiving_record" ? { receiving_record_id: candidate.id } : { erp_receipt_id: candidate.id }
        )
      });
      setCandidates(null);
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const confirmDone = async () => {
    setBusy("confirm-done");
    setError("");
    try {
      await api(`/api/invoices/${id}/confirm`, { method: "POST" });
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  if (!invoice) return <div className="loading">正在读取发票……</div>;

  return (
    <div className="wb-detail">
      <button className="secondary-button" type="button" onClick={onBack}>← 返回列表</button>

      <section className="card wb-card">
        <div className="wb-detail-head">
          <div>
            <strong>{invoice.invoice_no || "(发票号待识别)"}</strong>
            <span className={statusBadgeClass(invoice.status)}>{STATUS_LABEL[invoice.status] || invoice.status}</span>
          </div>
          <div className="wb-amount">{fmtMoney(invoice.total_amount)}</div>
        </div>
        <div className="wb-fields">
          <span>发票日期：{invoice.invoice_date || "—"}</span>
          {invoice.ocr_confidence !== null && (
            <span className="wb-confidence">OCR识别置信度：{fmtConfidence(invoice.ocr_confidence)}（AI识别结果，非人工核实，供参考）</span>
          )}
        </div>
      </section>

      {error && <p className="wb-error">{error}</p>}

      <section className="card wb-card">
        <h4>操作</h4>
        <div className="wb-actions">
          {invoice.status === "new" && (
            <button className="primary-button" type="button" disabled={!!busy} onClick={runParse}>
              {busy === "parse" ? "识别中…" : "🔍 AI识别(OCR)"}
            </button>
          )}
          {(invoice.status === "parsed" || invoice.status === "pending_match" || invoice.status === "discrepancy") && (
            <button className="primary-button" type="button" disabled={!!busy} onClick={findMatches}>
              {busy === "match" ? "查找中…" : "🔗 查找匹配的收货/入库单"}
            </button>
          )}
          {invoice.status === "matched" && (
            <button className="primary-button" type="button" disabled={!!busy} onClick={confirmDone}>
              {busy === "confirm-done" ? "确认中…" : "✅ 确认完成"}
            </button>
          )}
        </div>
      </section>

      {candidates && (
        <section className="card wb-card">
          <h4>匹配候选（分数越高越可能对，人工点击确认，不会自动生效）</h4>
          {candidates.receiving_record_candidates.length === 0 && candidates.erp_receipt_candidates.length === 0 && (
            <p>没有找到可能的匹配，可能需要先检查发票明细里的送货单号/PO号是否识别正确。</p>
          )}
          {candidates.receiving_record_candidates.map((c) => (
            <div key={`r-${c.id}`} className="wb-candidate">
              <div>
                <strong>收货记录 #{c.id}</strong>
                <span>{c.record?.date} · {c.record?.supplier_name} · 送货单号:{c.record?.delivery_docket_no || "—"}</span>
                <em>匹配依据：{c.reasons.join("、")}（分数 {c.score}）</em>
              </div>
              <button className="secondary-button" type="button" disabled={!!busy} onClick={() => confirmMatch(c)}>
                {busy === `confirm-receiving_record-${c.id}` ? "确认中…" : "确认这个"}
              </button>
            </div>
          ))}
          {candidates.erp_receipt_candidates.map((c) => (
            <div key={`e-${c.id}`} className="wb-candidate">
              <div>
                <strong>ERP入库单 #{c.id}</strong>
                <span>{c.receipt?.receipt_date} · 单号:{c.receipt?.erp_document_no} · {fmtMoney(c.receipt?.total_amount ?? null)}</span>
                <em>匹配依据：{c.reasons.join("、")}（分数 {c.score}）</em>
              </div>
              <button className="secondary-button" type="button" disabled={!!busy} onClick={() => confirmMatch(c)}>
                {busy === `confirm-erp_receipt-${c.id}` ? "确认中…" : "确认这个"}
              </button>
            </div>
          ))}
        </section>
      )}

      <section className="card wb-card">
        <h4>发票明细（{items.length}行）</h4>
        {items.length === 0 ? (
          <p>还没有明细行——先做"AI识别"或手动录入。</p>
        ) : (
          <table className="wb-table">
            <thead>
              <tr><th>品名</th><th>数量</th><th>单位</th><th>单价</th><th>金额</th></tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>{it.supplier_item_name || "—"}</td>
                  <td>{it.quantity ?? "—"}</td>
                  <td>{it.unit || "—"}</td>
                  <td>{fmtMoney(it.unit_price)}</td>
                  <td>{fmtMoney(it.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

export function WorkbenchPage() {
  const { authLoading, user } = useAuth();
  const [summary, setSummary] = useState<WorkbenchSummary | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = () => {
    setLoading(true);
    Promise.all([
      api<WorkbenchSummary>("/api/workbench"),
      api<{ invoices: Invoice[] }>(`/api/invoices${statusFilter ? `?status=${statusFilter}` : ""}`),
      api<{ suppliers: Supplier[] }>("/api/workbench/suppliers")
    ])
      .then(([s, i, sup]) => {
        setSummary(s);
        setInvoices(i.invoices);
        setSuppliers(sup.suppliers);
      })
      .catch(() => {
        // 静默失败：503说明生产环境DATABASE_URL还没配，界面显示"功能未启用"而不是报错弹窗打断使用
      })
      .finally(() => setLoading(false));
  };

  useEffect(reload, [statusFilter]);

  if (authLoading) return <AuthLoadingScreen />;
  if (!user) return <LoginScreen />;

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <div className="eyebrow">WORKBENCH · 录单</div>
          <h1>发票 / 入库单录单工作台</h1>
        </div>
        <div className="operator">
          <span>{user.name}</span>
        </div>
      </header>

      <a className="overview-link" href="/" target="_self" rel="noreferrer">
        ← 返回每日收货
      </a>
      <a className="overview-link" href="/erp" target="_self" rel="noreferrer">
        ERP 入库单 →
      </a>

      {selectedId !== null ? (
        <InvoiceDetail id={selectedId} onBack={() => { setSelectedId(null); reload(); }} onChanged={reload} />
      ) : loading ? (
        <div className="loading">正在读取录单数据……</div>
      ) : !summary ? (
        <div className="loading">录单功能还没启用（生产环境数据库尚未配置），请稍后再试。</div>
      ) : (
        <>
          <section className="summary-card">
            <div>
              <strong>待录单 {summary.pending_entry.length}</strong>
              <span>已收货但还没关联发票的记录</span>
            </div>
            <button className="add-button" type="button" onClick={() => setShowUpload(true)}>＋ 上传发票</button>
          </section>

          <section className="wb-filters">
            {["", "new", "parsed", "pending_match", "matched", "discrepancy", "confirmed"].map((s) => (
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
            {invoices.length === 0 ? (
              <div className="loading">没有符合条件的发票。</div>
            ) : (
              invoices.map((inv) => (
                <div key={inv.id} className="card wb-invoice-row" onClick={() => setSelectedId(inv.id)}>
                  <div>
                    <strong>{inv.invoice_no || "(待识别)"}</strong>
                    <span className={statusBadgeClass(inv.status)}>{STATUS_LABEL[inv.status] || inv.status}</span>
                  </div>
                  <div className="wb-amount">{fmtMoney(inv.total_amount)}</div>
                </div>
              ))
            )}
          </section>
        </>
      )}

      {showUpload && (
        <UploadModal
          suppliers={suppliers}
          onClose={() => setShowUpload(false)}
          onUploaded={(id) => { setShowUpload(false); reload(); setSelectedId(id); }}
        />
      )}
    </main>
  );
}
