# 本地一次性工具脚本：从 P1 正式基线 Excel + 供应商代码表，生成 data/*.json 快照，
# 供 load.js 导入 Postgres。不在 Render 上运行，只在本地重新生成快照时手动执行。
#
# 用法：python export_p1.py
#
# 什么时候要重新跑：P1 正式基线换了新版本（哈希变化），或者收货小程序供应商对齐结果有更新时。

import json
import re
from pathlib import Path

import openpyxl

KUGUAN_ROOT = Path(__file__).resolve().parents[5]  # .../库管
P1_BASELINE = KUGUAN_ROOT / "P1_物料供应商分类_最终版_20260813_011015.xlsx"
SUPPLIER_CODE_FILE = KUGUAN_ROOT / "供应商代码.xls"
OUT_DIR = Path(__file__).resolve().parent / "data"

# 收货小程序（飞书"供应商计划"Base）里实际使用的名字 -> P1 正式供应商名称。
# 2026-09-13 与用户逐项确认过；"Vinarchy"/"A&E"/"Four Seasons" 三个是当天已经把飞书源数据
# 里写错的"洋酒"/"扎啤"/"炒饭"改过来后的正式名字，这里直接按改完之后的名字对应。
RECEIVING_APP_NAME_TO_OFFICIAL = {
    "领鲜": "领鲜",
    "张记": "张记",
    "Cowrock": "Cowrock",
    "Kleaning KING": "Kleanking",
    "Friendship": "Friendship",
    "外租": "外租",
    "BNE": "BNE",
    "JFC": "JFC",
    "HTC": "HTC",
    "Discount solution": "Discount solution",
    "Funglea": "Funglea",
    "北方": "北方",
    "CFC": "CFC",
    "老北方": "老北方",
    "总仓": "总仓",
    "养乐多": "Yakult",
    "明发": "明发",
    "Vinarchy": "Vinarchy",
    "A&E": "A&E",
    "UNESCO": "Unesco",
    "Four Seasons": "Four Seasons",
}

INTERNAL_WAREHOUSE_NAMES = {"外租", "总仓"}

TYPE_LABEL_TO_ENUM = {
    "领鲜": "produce",
    "北方": "northern",
    "Cowrock": "meat",
    "冻货": "frozen",
}


def type_from_label(label):
    return TYPE_LABEL_TO_ENUM.get((label or "").strip(), "other")


def load_supplier_sheet():
    wb = openpyxl.load_workbook(P1_BASELINE, read_only=True, data_only=True)
    ws = wb["供应商"]
    rows = list(ws.iter_rows(values_only=True))
    header = rows[0]
    return [dict(zip(header, r)) for r in rows[1:] if r and r[0]]


def load_supplier_codes():
    import pandas as pd

    df = pd.read_excel(SUPPLIER_CODE_FILE, sheet_name="Sheet1")
    df = df[["名称", "代码"]].dropna(subset=["名称"])
    return {str(r["名称"]).strip(): str(r["代码"]).strip() for _, r in df.iterrows()}


def build_suppliers():
    supplier_rows = load_supplier_sheet()
    by_name = {row["供应商名称"]: row for row in supplier_rows}
    codes = load_supplier_codes()

    # official name -> receiving_app_name（反过来查，一个正式名称理论上只对应一个收货小程序名字）
    official_to_receiving_name = {v: k for k, v in RECEIVING_APP_NAME_TO_OFFICIAL.items()}

    out = []
    for row in supplier_rows:
        sup_id = row["供应商ID"]
        name = row["供应商名称"]
        out.append(
            {
                "id": sup_id,
                "name": name,
                "receiving_app_name": official_to_receiving_name.get(name),
                "internal_code": codes.get(name),
                "is_internal_warehouse": name in INTERNAL_WAREHOUSE_NAMES,
                "status": row["记录状态"] or "在用",
                "merged_into_id": row["合并至供应商ID"],
            }
        )
    return out, by_name


def build_categories():
    wb = openpyxl.load_workbook(P1_BASELINE, read_only=True, data_only=True)
    ws = wb["分类字典"]
    rows = list(ws.iter_rows(values_only=True))
    header = rows[0]
    raw_rows = [dict(zip(header, r)) for r in rows[1:] if r and r[0]]

    # P1 表里"上级分类"这一列存的是分类名称（比如"肉类"），不是分类编码，
    # 这里查一次名称->编码，转成真正的外键值。
    name_to_code = {d["分类名称"]: d["分类编码"] for d in raw_rows}

    out = []
    for d in raw_rows:
        parent_name = d["上级分类"]
        out.append(
            {
                "code": d["分类编码"],
                "name": d["分类名称"],
                "level": d["层级"],
                "parent_code": name_to_code.get(parent_name) if parent_name else None,
                "sort_order": d["排序"],
                "description": d["说明"],
                "material_count_snapshot": d["当前物料数"],
            }
        )
    return out


def build_materials():
    wb = openpyxl.load_workbook(P1_BASELINE, read_only=True, data_only=True)
    ws = wb["物料主数据"]
    rows = list(ws.iter_rows(values_only=True))
    header = rows[0]
    out = []
    for r in rows[1:]:
        if not r or not r[0]:
            continue
        d = dict(zip(header, r))
        raw = {k: (v if not hasattr(v, "isoformat") else v.isoformat()) for k, v in d.items()}
        out.append(
            {
                "sku": d["SKU"],
                "name": d["物料名称"],
                "english_name": d["英文名称"],
                "original_name": d["原始物料名称"],
                "category": d["分类"],
                "subcategory": d["子分类"],
                "unit": d["单位"],
                "spec": d["规格"],
                "default_supplier_name": d["默认供应商"],
                "status": d["采购状态"],
                "enabled_status": d["启用状态"],
                "record_status": d["记录状态"],
                "merged_into_sku": d["合并至SKU"],
                "raw": raw,
            }
        )
    return out


def load_env():
    env_path = Path(__file__).resolve().parents[3] / ".env"  # haidilao-receiving-app/.env
    env = {}
    for line in env_path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^([A-Z_]+)=(.*)$", line)
        if m:
            env[m.group(1)] = m.group(2)
    return env


def fetch_feishu_supplier_plan_records():
    """从飞书'供应商计划'Base 实时拉取——这张表本来就只活在飞书里，P1 baseline 没有这个概念，
    每次重新生成快照都应该拉最新的，不依赖任何本地缓存文件。"""
    import requests

    env = load_env()

    token_res = requests.post(
        "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
        json={"app_id": env["FEISHU_APP_ID"], "app_secret": env["FEISHU_APP_SECRET"]},
    ).json()
    token = token_res["tenant_access_token"]

    records = []
    page_token = None
    while True:
        params = {"page_size": 500}
        if page_token:
            params["page_token"] = page_token
        res = requests.get(
            f"https://open.feishu.cn/open-apis/bitable/v1/apps/{env['FEISHU_SUPPLIER_APP_TOKEN']}"
            f"/tables/{env['FEISHU_SUPPLIER_TABLE_ID']}/records",
            params=params,
            headers={"Authorization": f"Bearer {token}"},
        ).json()
        records.extend(res["data"]["items"])
        if not res["data"].get("has_more"):
            break
        page_token = res["data"]["page_token"]

    return records


def build_schedule(supplier_by_name):
    records = fetch_feishu_supplier_plan_records()

    out = []
    unresolved = set()
    for r in records:
        fields = r["fields"]
        receiving_name = (fields.get("供应商") or "").strip()
        official_name = RECEIVING_APP_NAME_TO_OFFICIAL.get(receiving_name)
        if not official_name or official_name not in supplier_by_name:
            unresolved.add(receiving_name)
            continue
        supplier_id = supplier_by_name[official_name]["供应商ID"]
        out.append(
            {
                "supplier_id": supplier_id,
                "weekday": fields.get("收货星期"),
                "supplier_type": type_from_label(fields.get("验收类型")),
                "feishu_record_id": r["record_id"],
            }
        )

    if unresolved:
        print("警告：以下供应商名字在对齐表里找不到，未写入 schedule：", unresolved)

    return out


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    suppliers, supplier_by_name = build_suppliers()
    categories = build_categories()
    materials = build_materials()
    schedule = build_schedule(supplier_by_name)

    (OUT_DIR / "suppliers.json").write_text(
        json.dumps(suppliers, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    (OUT_DIR / "categories.json").write_text(
        json.dumps(categories, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    (OUT_DIR / "materials.json").write_text(
        json.dumps(materials, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
    (OUT_DIR / "schedule.json").write_text(
        json.dumps(schedule, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )

    print(f"suppliers: {len(suppliers)}")
    print(f"categories: {len(categories)}")
    print(f"materials: {len(materials)}")
    print(f"schedule: {len(schedule)}")


if __name__ == "__main__":
    main()
