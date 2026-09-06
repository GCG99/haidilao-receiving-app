import { useEffect, useMemo, useState } from "react";
import { SupplierCard } from "./components/SupplierCard";
import { fallbackSuppliers, weekdayNames } from "./suppliers";
import type { FormState, Supplier, SupplierResult } from "./types";

function inputDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function emptyResult(): SupplierResult {
  return {
    status: "pending",
    hasGoods: null,
    selections: {},
    evidence: {}
  };
}

interface User {
  open_id?: string;
  name: string;
  avatar_url?: string;
}

export default function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);

  const [selectedDate, setSelectedDate] = useState(inputDate(new Date()));
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [records, setRecords] = useState<FormState>({});
  const [temporary, setTemporary] = useState<Supplier[]>([]);
  const [showTemp, setShowTemp] = useState(false);
  const [tempName, setTempName] = useState("");
  const [tempType, setTempType] = useState<Supplier["type"]>("frozen");
  const [loading, setLoading] = useState(false);
  const [usingFallback, setUsingFallback] = useState(false);
  const [message, setMessage] = useState("");
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then(async (response) => {
        if (!response.ok) return null;
        const data = await response.json();
        return data.user as User;
      })
      .then((currentUser) => setUser(currentUser))
      .catch(() => setUser(null))
      .finally(() => setAuthLoading(false));
  }, []);

  const date = useMemo(() => parseDate(selectedDate), [selectedDate]);
  const weekday = weekdayNames[date.getDay()];
  const allSuppliers = useMemo(() => [...suppliers, ...temporary], [suppliers, temporary]);

  useEffect(() => {
    if (!user) return;

    let cancelled = false;
    setLoading(true);
    setMessage("");
    setTemporary([]);
    setRecords({});

    fetch(`/api/suppliers?date=${encodeURIComponent(selectedDate)}`)
      .then(async (response) => {
        const data = await response.json();

        if (response.status === 401) {
          setUser(null);
          throw new Error("AUTH_REQUIRED");
        }

        if (!response.ok) {
          throw new Error(data.message || "读取飞书供应商计划失败");
        }

        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setSuppliers(data.suppliers);
        setUsingFallback(false);
      })
      .catch((error) => {
        if (cancelled) return;

        if (error instanceof Error && error.message === "AUTH_REQUIRED") {
          return;
        }

        // 登录后原则上不应静默使用备用计划。
        setSuppliers([]);
        setUsingFallback(true);
        setMessage(`⚠️ 无法读取飞书供应商计划：${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedDate, user]);

  const completed = allSuppliers.filter((supplier) => {
    const status = records[supplier.id]?.status;
    return status === "completed" || status === "no_goods";
  }).length;

  const updateSupplier = (supplier: Supplier, result: SupplierResult) => {
    setRecords((previous) => ({
      ...previous,
      [supplier.id]: result
    }));
  };

  const submitSupplier = async (supplier: Supplier, result: SupplierResult) => {
    setSubmittingId(supplier.id);

    try {
      const form = new FormData();

      form.append(
        "meta",
        JSON.stringify({
          date: selectedDate,
          weekday,
          supplier: supplier.name,
          supplierType: supplier.type,
          temporary: supplier.temporary ?? false,
          status: result.status,
          selections: result.selections
        })
      );

      Object.entries(result.evidence).forEach(([kind, evidence]) => {
        evidence.files.forEach((file) => {
          form.append("photos", file, file.name);
          form.append(
            "photoMeta",
            JSON.stringify({
              kind,
              name: file.name
            })
          );
        });
      });

      const response = await fetch("/api/receiving", {
        method: "POST",
        body: form
      });

      const data = await response.json();

      if (response.status === 401) {
        setUser(null);
        throw new Error("登录已失效，请重新登录。");
      }

      if (!response.ok) {
        throw new Error(data.message || "提交飞书失败");
      }

      setRecords((previous) => ({
        ...previous,
        [supplier.id]: {
          ...result,
          status: data.status
        }
      }));

      setMessage(
        `✅ ${supplier.name} 已保存到飞书；${data.photo_count ?? 0} 张照片已归档。提交人：${data.operator || user?.name || ""}`
      );
    } catch (error) {
      alert(
        `提交失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setSubmittingId(null);
    }
  };

  const addTemporary = () => {
    const name = tempName.trim();

    if (!name) {
      alert("请输入临时供应商名称。");
      return;
    }

    if (allSuppliers.some((supplier) => supplier.name === name)) {
      alert("今天已经有这个供应商。");
      return;
    }

    setTemporary((previous) => [
      ...previous,
      {
        id: `temp-${Date.now()}`,
        name,
        type: tempType,
        temporary: true
      }
    ]);

    setTempName("");
    setTempType("frozen");
    setShowTemp(false);
  };

  const logout = async () => {
    await fetch("/api/auth/logout", {
      method: "POST"
    });
    setUser(null);
    setSuppliers([]);
    setTemporary([]);
    setRecords({});
  };

  if (authLoading) {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <div className="auth-logo">📋</div>
          <h1>每日收货验收</h1>
          <p>正在检查登录状态……</p>
        </div>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <div className="auth-logo">📋</div>
          <h1>每日收货验收</h1>
          <p>这是门店收货验收系统，请使用门店飞书账号登录。</p>
          <button
            className="login-button"
            type="button"
            onClick={() => {
              window.location.href = "/api/auth/login";
            }}
          >
            使用飞书登录
          </button>
          <div className="auth-note">
            登录后才能查看当天供应商、上传验收照片和提交收货记录。
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <div className="eyebrow">WAREHOUSE · RECEIVING</div>
          <h1>每日收货验收</h1>
          <p>
            {date.getFullYear()}年{date.getMonth() + 1}月{date.getDate()}日 · {weekday}
          </p>
        </div>

        <div className="operator">
          <div className="operator-name">
            {user.avatar_url ? (
              <img src={user.avatar_url} alt="" />
            ) : (
              <span className="operator-avatar">👤</span>
            )}
            <span>{user.name}</span>
          </div>
          <button type="button" onClick={logout}>退出</button>
        </div>

        <div className="counter">
          <strong>{completed}/{allSuppliers.length}</strong>
          <span>已完成</span>
        </div>
      </header>

      <section className="date-card">
        <div>
          <strong>收货日期</strong>
          <span>默认今天，可修改日期。</span>
        </div>
        <input
          type="date"
          value={selectedDate}
          onChange={(event) => setSelectedDate(event.target.value)}
        />
      </section>

      <section className={usingFallback ? "connection-card offline" : "connection-card"}>
        <span className="connection-dot" />
        {usingFallback ? "飞书供应商计划读取失败" : "已连接飞书供应商计划"}
        {message && <em>{message}</em>}
      </section>

      <section className="tip-card">
        <strong>📷 收货照片规则</strong>
        <p>
          现场请先使用水印相机完成测温、称重、甜度测试等拍照留档，再上传到本系统。
          本系统不手填测量数字。
        </p>
      </section>

      <section className="archive-card">
        <strong>🔐 当前身份</strong>
        <span>{user.name}</span>
        <small>本次提交的照片会自动带上供应商、验收项目和操作人信息。</small>
      </section>

      <section className="summary-card">
        <div>
          <strong>今日应收 {allSuppliers.length} 家</strong>
          <span>{weekday} · 已完成 {completed} 家</span>
        </div>
        <button
          className="add-button"
          type="button"
          onClick={() => setShowTemp((value) => !value)}
        >
          ＋ 临时叫货
        </button>
      </section>

      {showTemp && (
        <section className="temp-panel">
          <h3>添加临时叫货</h3>
          <label>供应商名称</label>
          <input
            value={tempName}
            onChange={(event) => setTempName(event.target.value)}
            placeholder="请输入临时供应商名称"
          />
          <label>验收类型</label>
          <select
            value={tempType}
            onChange={(event) => setTempType(event.target.value as Supplier["type"])}
          >
            <option value="frozen">冻货</option>
            <option value="meat">鲜切肉 / 冻肉</option>
            <option value="northern">北方肉卷</option>
            <option value="produce">领鲜</option>
            <option value="other">普通供应商（可能有冻货）</option>
          </select>
          <div className="temp-actions">
            <button className="secondary-button" type="button" onClick={() => setShowTemp(false)}>
              取消
            </button>
            <button className="primary-button" type="button" onClick={addTemporary}>
              添加
            </button>
          </div>
        </section>
      )}

      {loading ? (
        <div className="loading">正在读取飞书供应商计划……</div>
      ) : (
        <section className="supplier-list">
          {allSuppliers.length === 0 ? (
            <div className="loading">
              没有读取到今天的供应商。
            </div>
          ) : (
            allSuppliers.map((supplier, index) => (
              <SupplierCard
                key={`${selectedDate}-${supplier.id}`}
                supplier={supplier}
                date={selectedDate}
                index={index + 1}
                result={records[supplier.id] ?? emptyResult()}
                submitting={submittingId === supplier.id}
                onChange={(result) => updateSupplier(supplier, result)}
                onSubmit={submitSupplier}
              />
            ))
          )}
        </section>
      )}
    </main>
  );
}
