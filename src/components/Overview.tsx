import { useEffect, useMemo, useState } from "react";
import { typeLabels } from "../suppliers";
import type { OverviewDay } from "../types";

interface Props {
  onSelectDate: (date: string) => void;
}

function todayValue() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function defaultFromValue() {
  const date = new Date();
  const septFirst = `${date.getFullYear()}-09-01`;
  return septFirst <= todayValue() ? septFirst : todayValue();
}

export function Overview({ onSelectDate }: Props) {
  const [fromDate, setFromDate] = useState(defaultFromValue());
  const [days, setDays] = useState<OverviewDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    fetch(`/api/overview?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(todayValue())}`)
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || "读取看板失败");
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setDays(data.days || []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fromDate]);

  const missingList = useMemo(
    () =>
      days.flatMap((day) =>
        day.missing.map((item) => ({
          date: day.date,
          weekday: day.weekday,
          name: item.name,
          type: item.type
        }))
      ),
    [days]
  );

  return (
    <section>
      <div className="overview-range">
        <span>从</span>
        <input
          type="date"
          value={fromDate}
          onChange={(event) => setFromDate(event.target.value)}
        />
        <span>到今天</span>
      </div>

      {loading ? (
        <div className="loading">正在读取看板……</div>
      ) : error ? (
        <div className="loading">⚠️ {error}</div>
      ) : (
        <>
          <h3 className="overview-section-title">📅 收货未完成看板</h3>
          <div className="overview-list">
            {days.map((day) => (
              <article
                key={day.date}
                className={day.missing.length ? "overview-card has-missing" : "overview-card all-done"}
              >
                <div className="overview-head">
                  <div>
                    <strong>{day.date}</strong>
                    <span>{day.weekday}</span>
                  </div>
                  <button type="button" onClick={() => onSelectDate(day.date)}>
                    查看这天
                  </button>
                </div>

                <div className="overview-count">
                  已提交 {day.submitted}/{day.expected}
                  {day.temporaryCount > 0 && <em> · 另有 {day.temporaryCount} 家临时叫货已提交</em>}
                </div>

                {day.missing.length > 0 ? (
                  <div className="missing-chips">
                    {day.missing.map((item) => (
                      <span key={item.name} className="chip">{item.name}</span>
                    ))}
                  </div>
                ) : (
                  <div className="all-done-note">✅ 全部完成</div>
                )}
              </article>
            ))}
          </div>

          <h3 className="overview-section-title">📋 未提交单子清单</h3>
          {missingList.length === 0 ? (
            <div className="loading">🎉 这段时间没有未提交的单子。</div>
          ) : (
            <div className="missing-list">
              {missingList.map((item, index) => (
                <div className="missing-row" key={`${item.date}-${item.name}-${index}`}>
                  <div className="missing-row-info">
                    <strong>{item.name}</strong>
                    <span>{typeLabels[item.type] || item.type}</span>
                    <span>{item.date} · {item.weekday}</span>
                  </div>
                  <button type="button" onClick={() => onSelectDate(item.date)}>
                    去补交
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
