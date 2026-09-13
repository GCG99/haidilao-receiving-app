import { useMemo, useState } from "react";
import { PhotoUpload } from "./PhotoUpload";
import { weightedFreshProducts } from "../suppliers";
import type { Supplier, SupplierResult } from "../types";

interface Props {
  supplier: Supplier;
  date: string;
  index: number;
  result: SupplierResult;
  submitting: boolean;
  onChange: (result: SupplierResult) => void;
  onSubmit: (supplier: Supplier, result: SupplierResult) => Promise<void>;
}

function Choice({
  value,
  yes = "有",
  no = "今天没有",
  onChange
}: {
  value: boolean | null;
  yes?: string;
  no?: string;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="choice-row">
      <button className={value === true ? "choice active" : "choice"} type="button" onClick={() => onChange(true)}>
        {yes}
      </button>
      <button className={value === false ? "choice active" : "choice"} type="button" onClick={() => onChange(false)}>
        {no}
      </button>
    </div>
  );
}

function Rule({
  title,
  children,
  critical = false
}: {
  title: string;
  children: React.ReactNode;
  critical?: boolean;
}) {
  return (
    <div className={critical ? "rule critical" : "rule"}>
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}

const selectionLabels: Record<string, string> = {
  beef: "牛肉",
  lamb: "羊肉",
  pork: "猪肉",
  northernFrozen: "冻肉",
  northernFresh: "鲜切肉",
  frozenGoods: "冻货",
  freshMeat: "鲜切肉",
  frozenMeat: "冻肉",
  vegetables: "蔬菜",
  fruits: "水果",
  potato: "土豆"
};

export function SupplierCard({
  supplier,
  index,
  result,
  submitting,
  onChange,
  onSubmit
}: Props) {
  const [exceptionNote, setExceptionNote] = useState(result.exceptionNote ?? "");
  const [ocrNote, setOcrNote] = useState("");
  const [ocrLoading, setOcrLoading] = useState(false);

  const locked = result.status !== "pending";

  // 领鲜、北方、Cowrock 之外的供应商都用「没有送货 / 有送货·没有冻货 / 有送货·有冻货」三选一。
  const useThreeChoice = supplier.type === "other" || supplier.type === "frozen";

  const hasPhoto = (id: string) =>
    (result.evidence[id]?.files.length ?? 0) > 0 ||
    (result.evidence[id]?.uploaded?.length ?? 0) > 0;

  const setSelection = (key: string, value: boolean) => {
    if (locked) return;
    onChange({
      ...result,
      hasGoods: true,
      status: "pending",
      selections: {
        ...result.selections,
        [key]: value
      }
    });
  };

  const setPhoto = (id: string, files: File[]) => {
    if (locked) return;
    onChange({
      ...result,
      status: "pending",
      evidence: {
        ...result.evidence,
        [id]: { files }
      }
    });

    if (id === "delivery_note" && files.length > 0) {
      runOcr(files[0]);
    }
  };

  const runOcr = async (file: File) => {
    setOcrLoading(true);
    setOcrNote("");

    try {
      const form = new FormData();
      form.append("image", file);

      const response = await fetch("/api/ocr/delivery-note", {
        method: "POST",
        body: form
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "识别失败");

      const suggestions = (data.suggestions || {}) as Record<string, boolean>;
      const matchedLabels = [
        ...new Set(
          Object.keys(suggestions)
            .filter((key) => suggestions[key])
            .map((key) => selectionLabels[key] || key)
        )
      ];

      setOcrNote(
        matchedLabels.length
          ? `🔍 送货单识别到：${matchedLabels.join("、")}（请人工核对）`
          : "🔍 未从送货单识别到明显品项，请人工确认。"
      );

      onChange({
        ...result,
        hasGoods: true,
        status: "pending",
        selections: {
          ...Object.fromEntries(
            Object.entries(suggestions)
              .filter(([, value]) => value)
              .map(([key]) => [key, result.selections[key] ?? true])
          ),
          ...result.selections
        }
      });
    } catch (error) {
      setOcrNote(
        `⚠️ 送货单识别失败：${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setOcrLoading(false);
    }
  };

  const photo = (
    id: string,
    title: string,
    description: string,
    required = true
  ) => (
    <PhotoUpload
      key={id}
      title={title}
      description={description}
      submitted={result.status === "completed" || result.status === "no_goods"}
      uploaded={result.evidence[id]?.uploaded}
      required={required}
      onChange={(files) => setPhoto(id, files)}
    />
  );

  const requiredIds = useMemo(() => {
    const ids: string[] = [];

    // 每家供应商送货后都必须先提交送货单照片。
    if (result.hasGoods === true) {
      ids.push("delivery_note");
    }

    if (useThreeChoice) {
      if (result.selections.frozenGoods === true) {
        ids.push("frozen_temperature");
      }
    }

    if (supplier.type === "meat") {
      if (result.selections.freshMeat === true) {
        ids.push("fresh_weight", "fresh_temperature");
      }
      if (result.selections.frozenMeat === true) {
        ids.push("frozen_meat_weight", "frozen_meat_temperature");
      }
    }

    if (supplier.type === "northern") {
      if (result.hasGoods === true) {
        ids.push("truck_temperature");
      }
      if (result.selections.northernFrozen === true) {
        (["beef", "lamb", "pork"] as const).forEach((key) => {
          if (result.selections[key] === true) {
            ids.push(`northern_${key}_weight`, `northern_${key}_temperature`);
          }
        });
      }
      if (result.selections.northernFresh === true) {
        ids.push("northern_fresh_weight", "northern_fresh_temperature");
      }
    }

    // 领鲜：货物状态 / 称重 / 甜度测试 / 土豆验收 四块照片均为选填，不进必传校验。

    return [...new Set(ids)];
  }, [result, supplier.type, useThreeChoice]);

  const requiredComplete = requiredIds.every(hasPhoto);
  const photoDoneCount = requiredIds.filter(hasPhoto).length;

  const markNoGoods = () => {
    if (locked) return;
    onChange({
      ...result,
      hasGoods: false,
      status: "no_goods",
      selections: result.selections,
      evidence: result.evidence
    });
  };

  const finish = async () => {
    if (result.status === "completed" || result.status === "no_goods") return;

    if (
      useThreeChoice &&
      result.selections.frozenGoods === false
    ) {
      await onSubmit(supplier, {
        ...result,
        hasGoods: true,
        status: "completed",
        selections: {
          ...result.selections,
          frozenGoods: false
        }
      });
      return;
    }

    if (result.hasGoods !== true) {
      alert("请先确认今天是否有货。");
      return;
    }

    if (!requiredComplete) {
      alert(`还有 ${requiredIds.filter((id) => !hasPhoto(id)).length} 个必传照片项目未上传。`);
      return;
    }

    await onSubmit(supplier, {
      ...result,
      status: "completed",
      selections: result.selections,
      exceptionNote
    } as SupplierResult);
  };

  return (
    <article className={`supplier-card ${result.status}`}>
      <div className="supplier-head">
        <div className="supplier-name">
          <span className="number">{index}</span>
          <h2>{supplier.name}</h2>
          {supplier.temporary && <span className="temporary">临时叫货</span>}
        </div>
        <span className="status-label">
          {result.status === "completed" ? "✅ 已提交" :
            result.status === "no_goods" ? "⭕ 今日无货" : "待验收"}
        </span>
      </div>

      <div className="supplier-body">
        {useThreeChoice ? (
          <>
            <div className="section-title">今天的送货情况？</div>
            <div className="choice-row choice-row-3">
              <button
                className={result.hasGoods === false ? "choice active" : "choice"}
                type="button"
                onClick={() => {
                  if (locked) return;
                  onChange({
                    ...result,
                    hasGoods: false,
                    status: "no_goods",
                    selections: { ...result.selections, frozenGoods: null }
                  });
                }}
              >
                没有送货
              </button>
              <button
                className={
                  result.hasGoods === true && result.selections.frozenGoods === false
                    ? "choice active"
                    : "choice"
                }
                type="button"
                onClick={() => {
                  if (locked) return;
                  onChange({
                    ...result,
                    hasGoods: true,
                    status: "pending",
                    selections: { ...result.selections, frozenGoods: false }
                  });
                }}
              >
                有送货·没有冻货
              </button>
              <button
                className={
                  result.hasGoods === true && result.selections.frozenGoods === true
                    ? "choice active"
                    : "choice"
                }
                type="button"
                onClick={() => {
                  if (locked) return;
                  onChange({
                    ...result,
                    hasGoods: true,
                    status: "pending",
                    selections: { ...result.selections, frozenGoods: true }
                  });
                }}
              >
                有送货·有冻货
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="section-title">今天有没有送货？</div>
            <Choice
              value={result.hasGoods}
              yes="今天有送货"
              no="今天没有送货"
              onChange={(value) => {
                if (locked) return;
                onChange({
                  ...result,
                  hasGoods: value,
                  status: value ? "pending" : "no_goods"
                });
              }}
            />
          </>
        )}

        {result.hasGoods === true && (
          <div className="delivery-note-wrap">
            <Rule title="📄 送货单照片" critical>
              今天有送货，必须提交本次送货单照片。
              <br />
              可以上传多张，确保整张送货单内容清楚可见。
            </Rule>
            {ocrLoading && <div className="ocr-note">🔍 正在识别送货单内容……</div>}
            {!ocrLoading && ocrNote && <div className="ocr-note">{ocrNote}</div>}
            {photo(
              "delivery_note",
              "送货单照片",
              "请上传本次送货对应的送货单/单子照片，可上传多张。"
            )}
          </div>
        )}

        {result.hasGoods === false && (
          <div className="normal-note">今天没有送货，本供应商无需继续填写验收项目。</div>
        )}

        {result.hasGoods === true &&
          useThreeChoice &&
          result.selections.frozenGoods === true && (
            <>
              <Rule title="🧊 冻货收货标准" critical>
                产品温度必须在 <b>-2℃以下</b>。发现温度异常、解冻、软化或包装异常，及时反馈管理组。
              </Rule>
              {photo("frozen_temperature", "冻货产品测温照片", "水印相机温度结果必须清楚可见。")}
            </>
          )}

        {result.hasGoods === true &&
          useThreeChoice &&
          result.selections.frozenGoods === false && (
            <div className="normal-note">有送货但今天没有冻货，本供应商无需上传照片，可直接提交。</div>
          )}

        {result.hasGoods === true && supplier.type === "meat" && (
          <>
            <div className="section-title">鲜切肉</div>
            <Choice
              value={result.selections.freshMeat ?? null}
              onChange={(value) => setSelection("freshMeat", value)}
            />
            {result.selections.freshMeat === true && (
              <>
                <Rule title="🥩 鲜切肉要求">
                  鲜切肉温度要求 <b>2–5℃</b>，必须留存称重照片和测温照片。
                </Rule>
                {photo("fresh_weight", "鲜切肉称重照片", "请使用水印相机拍摄，可上传多张。")}
                {photo("fresh_temperature", "鲜切肉测温照片", "温度结果必须清楚可见。")}
              </>
            )}

            <div className="section-title">冻肉</div>
            <Choice
              value={result.selections.frozenMeat ?? null}
              onChange={(value) => setSelection("frozenMeat", value)}
            />
            {result.selections.frozenMeat === true && (
              <>
                <Rule title="🧊 冻肉要求" critical>
                  产品温度必须在 <b>-2℃以下</b>，必须留存称重照片和测温照片。
                </Rule>
                {photo("frozen_meat_weight", "冻肉称重照片", "请使用水印相机拍摄，可上传多张。")}
                {photo("frozen_meat_temperature", "冻肉测温照片", "温度结果必须清楚可见。")}
              </>
            )}
          </>
        )}

        {result.hasGoods === true && supplier.type === "northern" && (
          <>
            <Rule title="🚚 北方收货重点" critical>
              车厢温度必须在 <b>-5℃以下</b>。
              <br />
              到货后第一步先测车厢并上传水印相机测温照片。
            </Rule>
            {photo("truck_temperature", "运输车厢测温照片", "照片需清楚显示车厢环境和水印相机温度结果。")}

            <div className="section-title">🧊 冻肉</div>
            <Choice
              value={result.selections.northernFrozen ?? null}
              yes="有冻肉"
              no="今天没有冻肉"
              onChange={(value) => setSelection("northernFrozen", value)}
            />

            {result.selections.northernFrozen === true && (
              <div className="subgroup">
                <Rule title="冻肉按顺序验收：牛肉 → 羊肉 → 猪肉" critical>
                  产品温度必须在 <b>-2℃以下</b>。
                </Rule>

                {([
                  ["beef", "牛肉"],
                  ["lamb", "羊肉"],
                  ["pork", "猪肉"]
                ] as const).map(([key, label]) => (
                  <div className="nested" key={key}>
                    <div className="section-title small">{label}</div>
                    <Choice
                      value={result.selections[key] ?? null}
                      onChange={(value) => setSelection(key, value)}
                    />
                    {result.selections[key] === true && (
                      <>
                        {photo(`northern_${key}_weight`, `${label}称重照片`, "请使用水印相机拍摄，可上传多张。")}
                        {photo(`northern_${key}_temperature`, `${label}测温照片`, "温度结果必须清楚可见。")}
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="section-title">🥩 鲜切肉</div>
            <Choice
              value={result.selections.northernFresh ?? null}
              onChange={(value) => setSelection("northernFresh", value)}
            />
            {result.selections.northernFresh === true && (
              <>
                <Rule title="🥩 鲜切肉要求">
                  鲜切肉温度要求 <b>2–5℃</b>，必须留存称重照片和测温照片。
                </Rule>
                {photo("northern_fresh_weight", "鲜切肉称重照片", "请使用水印相机拍摄，可上传多张。")}
                {photo("northern_fresh_temperature", "鲜切肉测温照片", "温度结果必须清楚可见。")}
              </>
            )}
          </>
        )}

        {result.hasGoods === true && supplier.type === "produce" && (
          <>
            <Rule title="🥬 领鲜收货照片">
              以下四类照片均为选填，按当天实际到货情况上传，可上传多张。
              <br />
              甜度测试需在水果到货后 <b>2小时内</b>完成；土豆须拆袋查看实际产品状态后再拍。
            </Rule>
            {photo(
              "produce_status",
              "货物状态照片",
              "选填：拍清楚各款货物到货状态，可上传多张。",
              false
            )}
            <div className="fixed-list">
              <strong>按重量叫货产品（收货须实际称重）</strong>
              {weightedFreshProducts.map((item) => <span key={item}>{item}</span>)}
            </div>
            {photo(
              "produce_weight",
              "称重照片",
              "选填：按重量叫货产品收货时称重并拍水印相机照片，可上传多张。",
              false
            )}
            {photo(
              "fruit_sweetness",
              "甜度测试照片",
              "选填：水果甜度测试完成后上传水印相机照片，可上传多张。",
              false
            )}
            {photo(
              "potato_inspection",
              "土豆验收照片",
              "选填：土豆拆袋后拍实际产品状态照片，可上传多张。",
              false
            )}
          </>
        )}

        {result.hasGoods === true && (
          <>
            <div className="exception-box">
              <strong>发现异常？</strong>
              <textarea
                value={exceptionNote}
                onChange={(e) => setExceptionNote(e.target.value)}
                placeholder="可填写异常说明（暂存在本次提交记录中）"
                disabled={locked}
              />
            </div>
          </>
        )}

        {requiredIds.length > 0 && (
          <div className="progress-line">
            <b>流程照片：{photoDoneCount}/{requiredIds.length}</b>
            <span>{requiredComplete ? "✅ 已齐" : "⚠️ 还有照片未上传"}</span>
          </div>
        )}

        <div className="card-actions">
          <button className="secondary-button" type="button" disabled={submitting || result.status !== "pending"} onClick={finish}>
            {submitting ? "正在提交..." : result.status === "completed" ? "已提交" : "完成验收并提交"}
          </button>
        </div>
      </div>
    </article>
  );
}
