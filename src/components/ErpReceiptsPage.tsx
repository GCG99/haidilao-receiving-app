import { useEffect, useState } from "react";
import { AuthLoadingScreen, LoginScreen } from "./AuthScreens";
import { useAuth } from "../hooks/useAuth";

interface Supplier {
  id: string;
  name: string;
  merged_into_id?: string | null;
}

interface MaterialOption {
  sku: string;
  name: string;
  unit: string | null;
}

interface ErpReceiptSummary {
  id: number;
  supplier_id: string;
  erp_document_no: string;
  purchase_order_no: string | null;
  erp_receiving_date: string | null;
  total_amount: string | null;
  currency: string;
  status: string;
  created_at: string;
}

interface ErpReceiptItem {
  id: number;
  line_no: number | null;
  material_id: string | null;
  erp_material_code: string | null;
  erp_material_description: string | null;
  unit: string | null;
  order_quantity: string | null;
  received_quantity: string | null;
  unit_price: string | null;
  amount: string | null;
  production_date: string | null;
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

function supplierName(suppliers: Supplier[], id: string) {
  return suppliers.find((s) => s.id === id)?.name || id;
}

/* =========================
   物料搜索（跟WorkbenchPage/OpsPage同款交互，各自维护一份，避免跨页面共享状态）
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
        placeholder="关联本地物料(可选)…"
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
   新建ERP入库单
   ========================= */
interface DraftLine {
  material?: MaterialOption;
  erp_material_code: string;
  erp_material_description: string;
  unit: string;
  order_quantity: string;
  received_quantity: string;
  unit_price: string;
  amount: string;
}

const emptyLine = (): DraftLine => ({
  material: undefined,
  erp_material_code: "",
  erp_material_description: "",
  unit: "",
  order_quantity: "",
  received_quantity: "",
  unit_price: "",
  amount: ""
});

function NewErpReceiptModal({
  suppliers,
  onClose,
  onCreated
}: {
  suppliers: Supplier[];
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [supplierId, setSupplierId] = useState("");
  const [erpDocumentNo, setErpDocumentNo] = useState("");
  const [purchaseOrderNo, setPurchaseOrderNo] = useState("");
  const [erpReceivingDate, setErpReceivingDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [inventoryLocation, setInventoryLocation] = useState("");
  const [totalAmount, setTotalAmount] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<{ existing_receipt_id?: number } | null>(null);

  const updateLine = (idx: number, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };
  const addLine = () => setLines((prev) => [...prev, emptyLine()]);
  const removeLine = (idx: number) => setLines((prev) => prev.filter((_, i) => i !== idx));

  const submit = async () => {
    if (!supplierId || !erpDocumentNo.trim()) {
      setError("请选择供应商，并填写ERP入库单号——海底捞内部系统操作完成后才会有这个单号，是这张单据的唯一标识。");
      return;
    }
    const validLines = lines.filter(
      (l) => l.erp_material_code.trim() || l.erp_material_description.trim() || l.material
    );
    setBusy(true);
    setError("");
    setConflict(null);
    try {
      const data = await api<{ erp_receipt: { id: number } }>("/api/erp-receipts", {
        method: "POST",
        body: JSON.stringify({
          header: {
            supplier_id: supplierId,
            erp_document_no: erpDocumentNo.trim(),
            purchase_order_no: purchaseOrderNo.trim() || null,
            erp_receiving_date: erpReceivingDate || null,
            inventory_location: inventoryLocation.trim() || null,
            total_amount: totalAmount ? Number(totalAmount) : null
          },
          lines: validLines.map((l, i) => ({
            line_no: i + 1,
            material_id: l.material?.sku || null,
            erp_material_code: l.erp_material_code.trim() || null,
            erp_material_description: l.erp_material_description.trim() || null,
            unit: l.unit.trim() || l.material?.unit || null,
            order_quantity: l.order_quantity ? Number(l.order_quantity) : null,
            received_quantity: l.received_quantity ? Number(l.received_quantity) : null,
            unit_price: l.unit_price ? Number(l.unit_price) : null,
            amount: l.amount ? Number(l.amount) : null
          }))
        })
      });
      onCreated(data.erp_receipt.id);
    } catch (err) {
      if (err instanceof Error && err.message.includes("已经存在")) {
        setConflict({});
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wb-modal-backdrop" onClick={onClose}>
      <div className="wb-modal ops-wide-modal erp-modal" onClick={(e) => e.stopPropagation()}>
        <h3>新建 ERP 入库单</h3>
        <p className="ops-meta">从海底捞内部系统操作完成后的入库单截图/记录里誊抄，单号是唯一标识。</p>

        <label>供应商</label>
        <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          <option value="">请选择供应商</option>
          {suppliers.filter((s) => !s.merged_into_id).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>

        <label>ERP 入库单号</label>
        <input type="text" value={erpDocumentNo} onChange={(e) => setErpDocumentNo(e.target.value)} placeholder="海底捞系统里的单据号" />

        <label>采购单号(PO，可选)</label>
        <input type="text" value={purchaseOrderNo} onChange={(e) => setPurchaseOrderNo(e.target.value)} />

        <label>入库日期</label>
        <input type="date" value={erpReceivingDate} onChange={(e) => setErpReceivingDate(e.target.value)} />

        <label>库位(可选)</label>
        <input type="text" value={inventoryLocation} onChange={(e) => setInventoryLocation(e.target.value)} />

        <label>单据总金额(可选，核对用)</label>
        <input type="number" value={totalAmount} onChange={(e) => setTotalAmount(e.target.value)} />

        <label>明细行</label>
        {lines.map((l, idx) => (
          <div key={idx} className="erp-line-row">
            {l.material ? (
              <span className="ops-selected-material">
                {l.material.name}
                <button type="button" onClick={() => updateLine(idx, { material: undefined })}>×</button>
              </span>
            ) : (
              <MaterialSearchInput onSelect={(m) => updateLine(idx, { material: m, unit: m.unit || l.unit })} />
            )}
            <input
              type="text"
              placeholder="ERP物料编码"
              value={l.erp_material_code}
              onChange={(e) => updateLine(idx, { erp_material_code: e.target.value })}
            />
            <input
              type="text"
              placeholder="ERP物料描述"
              value={l.erp_material_description}
              onChange={(e) => updateLine(idx, { erp_material_description: e.target.value })}
            />
            <input
              type="number"
              placeholder="订购数量"
              value={l.order_quantity}
              onChange={(e) => updateLine(idx, { order_quantity: e.target.value })}
            />
            <input
              type="number"
              placeholder="实收数量"
              value={l.received_quantity}
              onChange={(e) => updateLine(idx, { received_quantity: e.target.value })}
            />
            <input type="text" placeholder="单位" value={l.unit} onChange={(e) => updateLine(idx, { unit: e.target.value })} />
            <input
              type="number"
              placeholder="单价"
              value={l.unit_price}
              onChange={(e) => updateLine(idx, { unit_price: e.target.value })}
            />
            <input type="number" placeholder="金额" value={l.amount} onChange={(e) => updateLine(idx, { amount: e.target.value })} />
            {lines.length > 1 && (
              <button className="ops-remove-link" type="button" onClick={() => removeLine(idx)}>删除</button>
            )}
          </div>
        ))}
        <button className="secondary-button" type="button" onClick={addLine}>＋ 加一行</button>

        {error && (
          <p className="wb-error">
            {error}
            {conflict && "（可以去列表里找找是不是已经录过这张单）"}
          </p>
        )}
        <div className="temp-actions">
          <button className="secondary-button" type="button" onClick={onClose} disabled={busy}>取消</button>
          <button className="primary-button" type="button" onClick={submit} disabled={busy}>
            {busy ? "提交中…" : "提交"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* =========================
   详情
   ========================= */
function ErpReceiptDetail({ id, suppliers, onBack }: { id: number; suppliers: Supplier[]; onBack: () => void }) {
  const [data, setData] = useState<{ erp_receipt: ErpReceiptSummary; items: ErpReceiptItem[] } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ erp_receipt: ErpReceiptSummary; items: ErpReceiptItem[] }>(`/api/erp-receipts/${id}`)
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  return (
    <div className="wb-detail">
      <button className="secondary-button" type="button" onClick={onBack}>← 返回列表</button>
      {error && <p className="wb-error">{error}</p>}
      {!data ? (
        <div className="loading">正在读取……</div>
      ) : (
        <>
          <section className="card wb-card">
            <strong>{supplierName(suppliers, data.erp_receipt.supplier_id)}</strong>
            <span className="wb-badge">{data.erp_receipt.status}</span>
            <div className="ops-meta">
              单号 {data.erp_receipt.erp_document_no}
              {data.erp_receipt.purchase_order_no ? ` · PO ${data.erp_receipt.purchase_order_no}` : ""}
              {data.erp_receipt.erp_receiving_date ? ` · ${data.erp_receipt.erp_receiving_date}` : ""}
            </div>
            {data.erp_receipt.total_amount && (
              <div className="ops-meta">单据总金额：{data.erp_receipt.total_amount} {data.erp_receipt.currency}</div>
            )}
          </section>
          <section className="card wb-card">
            <h4>明细（{data.items.length}项）</h4>
            <table className="wb-table">
              <thead>
                <tr>
                  <th>物料</th>
                  <th>ERP编码/描述</th>
                  <th>订购/实收</th>
                  <th>单价</th>
                  <th>金额</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((it) => (
                  <tr key={it.id}>
                    <td>{it.material_id || "—"}</td>
                    <td>{it.erp_material_code || ""} {it.erp_material_description || ""}</td>
                    <td>{it.order_quantity ?? "—"} / {it.received_quantity ?? "—"} {it.unit || ""}</td>
                    <td>{it.unit_price ?? "—"}</td>
                    <td>{it.amount ?? "—"}</td>
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

/* =========================
   列表 + 页面外壳
   ========================= */
export function ErpReceiptsPage() {
  const { authLoading, user } = useAuth();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [list, setList] = useState<ErpReceiptSummary[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState("");

  const load = () => {
    setError("");
    api<{ erp_receipts: ErpReceiptSummary[] }>("/api/erp-receipts")
      .then((d) => setList(d.erp_receipts))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    api<{ suppliers: Supplier[] }>("/api/workbench/suppliers")
      .then((d) => setSuppliers(d.suppliers))
      .catch(() => {});
    load();
  }, []);

  if (authLoading) return <AuthLoadingScreen />;
  if (!user) return <LoginScreen />;

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <div className="eyebrow">WORKBENCH · ERP入库单</div>
          <h1>ERP 入库单</h1>
        </div>
        <div className="operator">
          <span>{user.name}</span>
        </div>
      </header>

      <a className="overview-link" href="/workbench" target="_self" rel="noreferrer">
        ← 返回发票录单工作台
      </a>

      {selectedId !== null ? (
        <ErpReceiptDetail
          id={selectedId}
          suppliers={suppliers}
          onBack={() => {
            setSelectedId(null);
            load();
          }}
        />
      ) : (
        <>
          {error && <p className="wb-error">{error}</p>}
          <section className="card wb-card">
            <div className="ops-section-head">
              <h4>入库单列表</h4>
              <button className="primary-button" type="button" onClick={() => setShowNew(true)}>
                ＋ 新建 ERP 入库单
              </button>
            </div>
            {list === null ? (
              <div className="loading">正在读取……</div>
            ) : list.length === 0 ? (
              <p>还没有录入过 ERP 入库单，点右上角"新建"开始，从海底捞内部系统操作完成后的单据誊抄。</p>
            ) : (
              list.map((r) => (
                <div key={r.id} className="card wb-invoice-row" onClick={() => setSelectedId(r.id)}>
                  <div>
                    <strong>{supplierName(suppliers, r.supplier_id)}</strong>
                    <span className="wb-badge">{r.status}</span>
                  </div>
                  <div className="ops-meta">
                    单号 {r.erp_document_no}
                    {r.purchase_order_no ? ` · PO ${r.purchase_order_no}` : ""}
                    {r.erp_receiving_date ? ` · ${r.erp_receiving_date}` : ""}
                    {r.total_amount ? ` · ${r.total_amount} ${r.currency}` : ""}
                  </div>
                </div>
              ))
            )}
          </section>
        </>
      )}

      {showNew && (
        <NewErpReceiptModal
          suppliers={suppliers}
          onClose={() => setShowNew(false)}
          onCreated={(id) => {
            setShowNew(false);
            load();
            setSelectedId(id);
          }}
        />
      )}
    </main>
  );
}
