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

export function SupplierCard({
  supplier,
  index,
  result,
  submitting,
  onChange,
  onSubmit
}: Props) {
  const [exceptionNote, setExceptionNote] = useState("");

  const hasPhoto = (id: string) => (result.evidence[id]?.files.length ?? 0) > 0;

  const setSelection = (key: string, value: boolean) => {
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
    onChange({
      ...result,
      status: "pending",
      evidence: {
        ...result.evidence,
        [id]: { files }
      }
    });
  };

  const photo = (id: string, title: string, description: string) => (
    <PhotoUpload
      key={id}
      title={title}
      description={description}
      submitted={result.status === "completed" || result.status === "no_goods"}
      onChange={(files) => setPhoto(id, files)}
    />
  );

  const requiredIds = useMemo(() => {
    const ids: string[] = [];

    if (supplier.type === "frozen") {
      if (result.hasGoods === true) {
        ids.push("frozen_temperature", "frozen_quality");
      }
    }

    if (supplier.type === "other") {
      if (result.selections.frozenGoods === true) {
        ids.push("frozen_temperature", "frozen_quality");
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

    if (supplier.type === "produce") {
      if (result.selections.vegetables === true) {
        ids.push("vegetable_arrival", "weighted_products");
      }
      if (result.selections.fruits === true) {
        ids.push("fruit_sweetness");
      }
      if (result.selections.potato === true) {
        ids.push("potato_inspection");
      }
    }

    return [...new Set(ids)];
  }, [result, supplier.type]);

  const requiredComplete = requiredIds.every(hasPhoto);
  const photoDoneCount = requiredIds.filter(hasPhoto).length;

  const markNoGoods = () => {
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
      supplier.type === "other" &&
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
        {supplier.type === "other" && (
          <>
            <div className="section-title">今天是否有冻货？</div>
            <Choice
              value={result.selections.frozenGoods ?? null}
              yes="有冻货"
              no="今天没有冻货"
              onChange={(value) => {
                if (value) {
                  setSelection("frozenGoods", true);
                } else {
                  onChange({
                    ...result,
                    hasGoods: true,
                    status: "pending",
                    selections: { ...result.selections, frozenGoods: false }
                  });
                }
              }}
            />

            {result.selections.frozenGoods === true && (
              <>
                <Rule title="🧊 冻货收货标准" critical>
                  产品温度必须在 <b>-2℃以下</b>。发现温度异常、解冻、软化或包装异常，及时反馈管理组。
                </Rule>
                {photo("frozen_temperature", "冻货产品测温照片", "水印相机温度结果必须清楚可见。")}
                {photo("frozen_quality", "冻货产品状态照片", "拍清楚产品状态；异常情况必须留档。")}
              </>
            )}

            {result.selections.frozenGoods === false && (
              <div className="normal-note">今天没有冻货，本供应商无需上传照片。</div>
            )}
          </>
        )}

        {supplier.type === "frozen" && (
          <>
            <div className="section-title">今天是否有冻货？</div>
            <Choice
              value={result.hasGoods}
              yes="有冻货"
              no="今天没有冻货"
              onChange={(value) => value ? onChange({ ...result, hasGoods: true, status: "pending" }) : markNoGoods()}
            />
            {result.hasGoods === true && (
              <>
                <Rule title="🧊 冻货收货标准" critical>
                  产品温度必须在 <b>-2℃以下</b>。温度异常、解冻、软化或包装异常，及时反馈管理组。
                </Rule>
                {photo("frozen_temperature", "冻货产品测温照片", "水印相机温度结果必须清楚可见。")}
                {photo("frozen_quality", "冻货产品状态照片", "拍清楚产品状态；异常情况必须留档。")}
              </>
            )}
          </>
        )}

        {supplier.type === "meat" && (
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

        {supplier.type === "northern" && (
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

        {supplier.type === "produce" && (
          <>
            <div className="section-title">🥬 蔬菜</div>
            <Choice
              value={result.selections.vegetables ?? null}
              onChange={(value) => setSelection("vegetables", value)}
            />
            {result.selections.vegetables === true && (
              <>
                <Rule title="蔬菜收货要求">
                  每一款蔬菜到货时均需拍照留档。以下产品按重量叫货，收货时必须实际称重。
                </Rule>
                <div className="fixed-list">
                  <strong>按重量叫货产品</strong>
                  {weightedFreshProducts.map((item) => <span key={item}>{item}</span>)}
                </div>
                {photo("vegetable_arrival", "蔬菜到货照片", "每一款蔬菜均需上传水印相机照片，可以多张。")}
                {photo("weighted_products", "按重量叫货产品称重照片", "以上按重量产品收货时必须称重并拍水印相机照片，可以多张。")}
              </>
            )}

            <div className="section-title">🍉 水果</div>
            <Choice
              value={result.selections.fruits ?? null}
              onChange={(value) => setSelection("fruits", value)}
            />
            {result.selections.fruits === true && (
              <>
                <Rule title="⏱ 水果甜度测试" critical>
                  必须在水果到货后 <b>2小时内</b>完成甜度测试。
                  <br />
                  测试完成后上传水印相机拍摄的甜度照片。
                </Rule>
                {photo("fruit_sweetness", "水果甜度测试照片", "这里上传甜度测试照片，可上传多张。")}
              </>
            )}

            <div className="section-title">🥔 土豆</div>
            <Choice
              value={result.selections.potato ?? null}
              onChange={(value) => setSelection("potato", value)}
            />
            {result.selections.potato === true && (
              <>
                <Rule title="🥔 土豆必须拆袋验货" critical>
                  不得只检查外包装，必须拆袋查看实际产品状态，拆袋后使用水印相机拍照留档。
                </Rule>
                {photo("potato_inspection", "土豆拆袋验货照片", "请上传拆袋后的实际产品状态照片，可以多张。")}
              </>
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
