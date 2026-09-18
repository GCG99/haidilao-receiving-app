import { useEffect, useState } from "react";
import { AuthLoadingScreen, LoginScreen } from "./AuthScreens";
import { useAuth } from "../hooks/useAuth";

interface Supplier {
  id: string;
  name: string;
}

interface MaterialOption {
  sku: string;
  name: string;
  unit: string | null;
}

interface DueMaterial {
  material_id: string;
  material_name: string;
  material_unit: string | null;
  predicted_quantity: string | null;
  last_stocktake_at: string | null;
  this_week_record_id: number | null;
  this_week_counted_quantity: string | null;
}

interface OrderRequestSummary {
  id: number;
  order_date: string;
  supplier_id: string;
  supplier_name: string;
  note: string | null;
  item_count: string;
}

interface OrderRequestItem {
  id: number;
  material_id: string | null;
  material_name: string | null;
  supplier_material_name: string | null;
  ordered_quantity: string;
  unit: string | null;
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `请求失败(${res.status})`);
  return data as T;
}

function fmtNum(v: string | null) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/* =========================
   物料搜索（叫货明细 / 盘点配置共用）
   ========================= */
function MaterialSearchInput({ onSelect }: { onSelect: (m: MaterialOption) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MaterialOption[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (query.trim().length === 0) {
      setResults([]);
      return;
    }
    const handle = setTimeout(() => {
      api<{ materials: MaterialOption[] }>(`/api/materials/search/by-name?q=${encodeURIComponent(query)}`)
        .then((d) => setResults(d.materials))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(handle);
  }, [query]);

  return (
    <div className="ops-material-search">
      <input
        type="text"
        placeholder="搜索物料名称…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
      />
      {open && results.length > 0 && (
        <div className="ops-search-results">
          {results.map((m) => (
            <div
              key={m.sku}
              className="ops-search-result"
              onClick={() => {
                onSelect(m);
                setQuery("");
                setResults([]);
                setOpen(false);
              }}
            >
              {m.name} <span>（{m.unit || "无单位"}）</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* =========================
   周盘点
   ========================= */
function AddStocktakeMaterialModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const add = async (m: MaterialOption) => {
    setBusy(true);
    setError("");
    try {
      await api("/api/stocktake/config", { method: "POST", body: JSON.stringify({ material_id: m.sku }) });
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="wb-modal-backdrop" onClick={onClose}>
      <div className="wb-modal" onClick={(e) => e.stopPropagation()}>
        <h3>添加盘点物料</h3>
        <MaterialSearchInput onSelect={add} />
        {busy && <p>添加中…</p>}
        {error && <p className="wb-error">{error}</p>}
        <div className="temp-actions">
          <button className="secondary-button" type="button" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function StocktakeTab() {
  const [due, setDue] = useState<DueMaterial[] | null>(null);
  const [error, setError] = useState("");
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>("");
  const [confirmNeeded, setConfirmNeeded] = useState<string | null>(null);
  const [showAddMaterial, setShowAddMaterial] = useState(false);

  const load = () => {
    setError("");
    api<{ due: DueMaterial[] }>("/api/stocktake/due")
      .then((d) => setDue(d.due))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(load, []);

  const submit = async (materialId: string, force = false) => {
    const raw = inputs[materialId];
    const value = Number(raw);
    if (!raw || !Number.isFinite(value) || value < 0) {
      setError("请输入一个不小于0的数字。");
      return;
    }
    const item = due?.find((d) => d.material_id === materialId);
    const predicted =
      item?.predicted_quantity !== null && item?.predicted_quantity !== undefined ? Number(item.predicted_quantity) : null;
    // 差异过大提示：预设值不为0时，跟实际填的差超过40%就先跳出来确认一下，防止手滑。
    // 具体阈值是展示层判断，后端不做这个决定，纯前端拦一下。
    if (!force && predicted !== null && predicted > 0) {
      const diffRatio = Math.abs(value - predicted) / predicted;
      if (diffRatio > 0.4) {
        setConfirmNeeded(materialId);
        return;
      }
    }
    setBusy(materialId);
    setError("");
    try {
      await api("/api/stocktake/records", {
        method: "POST",
        body: JSON.stringify({ material_id: materialId, counted_quantity: value })
      });
      setConfirmNeeded(null);
      setInputs((prev) => ({ ...prev, [materialId]: "" }));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  const removeFromConfig = async (materialId: string) => {
    setBusy(`remove-${materialId}`);
    setError("");
    try {
      await api(`/api/stocktake/config/${materialId}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy("");
    }
  };

  if (due === null) return <div className="loading">正在读取盘点清单……</div>;

  const doneCount = due.filter((d) => d.this_week_record_id !== null).length;

  return (
    <div>
      {error && <p className="wb-error">{error}</p>}
      <section className="card wb-card">
        <div className="ops-section-head">
          <h4>本周盘点（{doneCount}/{due.length}）</h4>
          <button className="secondary-button" type="button" onClick={() => setShowAddMaterial(true)}>
            ＋ 添加盘点物料
          </button>
        </div>
        {due.length === 0 ? (
          <p>还没有配置需要盘点的物料，点右上角"添加盘点物料"开始。</p>
        ) : (
          due.map((d) => {
            const done = d.this_week_record_id !== null;
            return (
              <div key={d.material_id} className={`ops-row${done ? " ops-row-done" : ""}`}>
                <div className="ops-row-main">
                  <strong>{d.material_name}</strong>
                  <span className="ops-meta">
                    单位：{d.material_unit || "—"} · 预设参考：{fmtNum(d.predicted_quantity)}
                    {d.last_stocktake_at ? "" : "（还没盘点过，没有预设值）"}
                  </span>
                </div>
                {done ? (
                  <div className="ops-done-value">✅ 本周已盘：{fmtNum(d.this_week_counted_quantity)}</div>
                ) : (
                  <div className="ops-input-row">
                    <input
                      type="number"
                      placeholder={d.predicted_quantity !== null ? fmtNum(d.predicted_quantity) : "实际数量"}
                      value={inputs[d.material_id] ?? ""}
                      onChange={(e) => setInputs((prev) => ({ ...prev, [d.material_id]: e.target.value }))}
                    />
                    <button
                      className="primary-button"
                      type="button"
                      disabled={busy === d.material_id}
                      onClick={() => submit(d.material_id)}
                    >
                      {busy === d.material_id ? "提交中…" : "提交"}
                    </button>
                  </div>
                )}
                {confirmNeeded === d.material_id && (
                  <div className="ops-confirm-banner">
                    填的数字（{inputs[d.material_id]}）跟预设参考（{fmtNum(d.predicted_quantity)}）差异较大，确认没填错？
                    <div className="temp-actions">
                      <button className="secondary-button" type="button" onClick={() => setConfirmNeeded(null)}>
                        再检查一下
                      </button>
                      <button className="primary-button" type="button" onClick={() => submit(d.material_id, true)}>
                        确认，就是这个数
                      </button>
                    </div>
                  </div>
                )}
                {!done && (
                  <button
                    className="ops-remove-link"
                    type="button"
                    disabled={busy === `remove-${d.material_id}`}
                    onClick={() => removeFromConfig(d.material_id)}
                  >
                    移出盘点清单
                  </button>
                )}
              </div>
            );
          })
        )}
      </section>

      {showAddMaterial && (
        <AddStocktakeMaterialModal
          onClose={() => setShowAddMaterial(false)}
          onAdded={() => {
            setShowAddMaterial(false);
            load();
          }}
        />
      )}
    </div>
  );
}

/* =========================
   叫货记录
   ========================= */
interface DraftItem {
  material?: MaterialOption;
  quantity: string;
  unit: string;
}

function NewOrderRequestModal({
  suppliers,
  onClose,
  onCreated
}: {
  suppliers: Supplier[];
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [supplierId, setSupplierId] = useState("");
  const [orderDate, setOrderDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [items, setItems] = useState<DraftItem[]>([{ quantity: "", unit: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const updateItem = (idx: number, patch: Partial<DraftItem>) => {
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };
  const addRow = () => setItems((prev) => [...prev, { quantity: "", unit: "" }]);
  const removeRow = (idx: number) => setItems((prev) => prev.filter((_, i) => i !== idx));

  const submit = async () => {
    if (!supplierId || !orderDate) {
      setError("请选择供应商和日期。");
      return;
    }
    const validItems = items.filter((it) => it.material && Number(it.quantity) > 0);
    if (validItems.length === 0) {
      setError("至少选一个物料、填数量大于0的明细。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const data = await api<{ order_request: { id: number } }>("/api/order-requests", {
        method: "POST",
        body: JSON.stringify({
          order_date: orderDate,
          supplier_id: supplierId,
          note: note || null,
          items: validItems.map((it) => ({
            material_id: it.material!.sku,
            supplier_material_name: it.material!.name,
            ordered_quantity: Number(it.quantity),
            unit: it.unit || it.material!.unit || null
          }))
        })
      });
      onCreated(data.order_request.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wb-modal-backdrop" onClick={onClose}>
      <div className="wb-modal ops-wide-modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建叫货记录</h3>
        <label>日期</label>
        <input type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
        <label>供应商</label>
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">请选择供应商</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label>叫货明细</label>
        {items.map((it, idx) => (
          <div key={idx} className="ops-item-row">
            {it.material ? (
              <span className="ops-selected-material">
                {it.material.name}
                <button type="button" onClick={() => updateItem(idx, { material: undefined })}>
                  ×
                </button>
              </span>
            ) : (
              <MaterialSearchInput onSelect={(m) => updateItem(idx, { material: m, unit: m.unit || "" })} />
            )}
            <input
              type="number"
              placeholder="数量"
              value={it.quantity}
              onChange={(e) => updateItem(idx, { quantity: e.target.value })}
            />
            <input type="text" placeholder="单位" value={it.unit} onChange={(e) => updateItem(idx, { unit: e.target.value })} />
            {items.length > 1 && (
              <button className="ops-remove-link" type="button" onClick={() => removeRow(idx)}>
                删除
              </button>
            )}
          </div>
        ))}
        <button className="secondary-button" type="button" onClick={addRow}>
          ＋ 加一行
        </button>
        <label>备注</label>
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
        {error && <p className="wb-error">{error}</p>}
        <div className="temp-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary-button" type="button" onClick={submit} disabled={busy}>
            {busy ? "提交中…" : "提交"}
          </button>
        </div>
      </div>
    </div>
  );
}

function OrderRequestDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const [data, setData] = useState<{ order_request: OrderRequestSummary; items: OrderRequestItem[] } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ order_request: OrderRequestSummary; items: OrderRequestItem[] }>(`/api/order-requests/${id}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  return (
    <div className="wb-detail">
      <button className="secondary-button" type="button" onClick={onBack}>
        ← 返回列表
      </button>
      {error && <p className="wb-error">{error}</p>}
      {!data ? (
        <div className="loading">正在读取……</div>
      ) : (
        <>
          <section className="card wb-card">
            <strong>{data.order_request.supplier_name}</strong>
            <div className="ops-meta">{data.order_request.order_date}</div>
            {data.order_request.note && <p>{data.order_request.note}</p>}
          </section>
          <section className="card wb-card">
            <h4>明细（{data.items.length}项）</h4>
            <table className="wb-table">
              <thead>
                <tr>
                  <th>物料</th>
                  <th>数量</th>
                  <th>单位</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <tr key={it.id}>
                    <td>{it.material_name || it.supplier_material_name || "—"}</td>
                    <td>{it.ordered_quantity}</td>
                    <td>{it.unit || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

function OrderRequestsTab({ suppliers }: { suppliers: Supplier[] }) {
  const [list, setList] = useState<OrderRequestSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    setError("");
    api<{ order_requests: OrderRequestSummary[] }>("/api/order-requests")
      .then((d) => setList(d.order_requests))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(load, []);

  if (selectedId !== null) {
    return (
      <OrderRequestDetail
        id={selectedId}
        onBack={() => {
          setSelectedId(null);
          load();
        }}
      />
    );
  }

  if (list === null) return <div className="loading">正在读取叫货记录……</div>;

  return (
    <div>
      {error && <p className="wb-error">{error}</p>}
      <section className="card wb-card">
        <div className="ops-section-head">
          <h4>叫货记录</h4>
          <button className="primary-button" type="button" onClick={() => setShowNew(true)}>
            ＋ 新建叫货记录
          </button>
        </div>
        {list.length === 0 ? (
          <p>还没有叫货记录。</p>
        ) : (
          list.map((r) => (
            <div key={r.id} className="card wb-invoice-row" onClick={() => setSelectedId(r.id)}>
              <div>
                <strong>{r.supplier_name}</strong>
                <span className="wb-badge">{r.item_count}项</span>
              </div>
              <div className="ops-meta">{r.order_date}</div>
            </div>
          ))
        )}
      </section>
      {showNew && (
        <NewOrderRequestModal
          suppliers={suppliers}
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            load();
            setSelectedId(id);
          }}
        />
      )}
    </div>
  );
}

/* =========================
   页面外壳
   ========================= */
export function OpsPage() {
  const { authLoading, user } = useAuth();
  const [tab, setTab] = useState<"stocktake" | "orders">("stocktake");
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  useEffect(() => {
    api<{ suppliers: Supplier[] }>("/api/workbench/suppliers")
      .then((d) => setSuppliers(d.suppliers))
      .catch(() => {
        // 静默失败：跟WorkbenchPage一致，503说明生产环境DATABASE_URL还没配
      });
  }, []);

  if (authLoading) return <AuthLoadingScreen />;
  if (!user) return <LoginScreen />;

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <div className="eyebrow">OPS · 叫货 / 盘点</div>
          <h1>叫货记录 / 周盘点</h1>
        </div>
        <div className="operator">
          <span>{user.name}</span>
        </div>
      </header>

      <a className="overview-link" href="/" target="_self" rel="noreferrer">
        ← 返回每日收货
      </a>

      <section className="wb-filters">
        <button
          className={tab === "stocktake" ? "primary-button" : "secondary-button"}
          type="button"
          onClick={() => setTab("stocktake")}
        >
          周盘点
        </button>
        <button
          className={tab === "orders" ? "primary-button" : "secondary-button"}
          type="button"
          onClick={() => setTab("orders")}
        >
          叫货记录
        </button>
      </section>

      {tab === "stocktake" ? <StocktakeTab /> : <OrderRequestsTab suppliers={suppliers} />}
    </main>
  );
}
