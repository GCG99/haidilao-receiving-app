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

KUGUAN_ROOT = Path(__file__).resolve().parents[4]  # .../库管
# 2026-09-19发现的真实bug：这两个路径从写出来就没跟上2026-09-18的项目重组——
# (1) parents[5]算错了一层，实际会算到Desktop而不是库管，两个文件从来没被
#     正确找到过（脚本压根跑不起来，不是"跑了但用旧数据"这么温和）；
# (2) P1基线硬编码成了2026-08-13的第一版，从来没跟着后续批次B~L的全部修正
#     更新过——哪怕(1)修好了，脚本导出的也一直是清洗前的旧版本。这意味着
#     Postgres的materials/categories/suppliers表(本地开发库和生产库都一样)
#     从2026-09-14做种子导入以来，从未真正跟P1 Excel管道的最终清洗结果同步过。
#     具体例子：MEAT-0075(瘦羊腿)早在批次B(2026-09-17)就该合并停用，但Postgres
#     里至今还显示"在用"。
# (3) 供应商代码表的文件名也从.xls改成了.xlsx（2026-09-18那次文件整理时一并
#     发生的），旧扩展名同样会导致FileNotFoundError。
# 三处都已用当前实际文件系统状态核实过存在性，不是猜测性修复。
P1_BASELINE = KUGUAN_ROOT / "haidilao-receiving-app" / "库管数据" / "P1_物料供应商分类_最终版_20260917_232357.xlsx"
SUPPLIER_CODE_FILE = KUGUAN_ROOT / "供应商代码.xlsx"
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

    # 2026-09-20发现的真实冲突：P1 Excel基线自己的"供应商"表里的供应商合并记录，
    # 跟haidilao-receiving-app项目2026-09-18那次"翻发票号交叉核对"发现并确认的
    # 供应商身份结论不一致——P1基线里B&E(SUP-003)的合并方向是"并入BNE(SUP-004)"，
    # 而且完全没有记录"北方→Beifang"和"Coworkc→Cowrock"这两组合并。用户2026-09-20
    # 明确确认："B&E是保留方，BNE并入B&E"——跟P1基线的方向正好相反。
    # 这4组是haidilao-receiving-app这条线单独确认的、P1基线还没跟上的最新结论，
    # 不去动P1基线本身(那是另一套有自己版本化流程的正式产物，不在这个脚本的职责
    # 范围内)，只在导出这一步做覆盖修正，让Postgres拿到的是最新确认的身份关系。
    SUPPLIER_MERGE_OVERRIDES = {
        "SUP-023": "SUP-047",  # SKYJ -> 领鲜（P1基线本身就有这条，覆盖是保险，不是修正）
        "SUP-034": "SUP-005",  # 北方 -> Beifang（P1基线缺失，2026-09-18确认）
        "SUP-004": "SUP-003",  # BNE -> B&E（P1基线方向反了，2026-09-20用户重新确认）
        "SUP-010": "SUP-011",  # Coworkc -> Cowrock（P1基线缺失，2026-09-18确认）
    }
    CLEAR_MERGE = {"SUP-003"}  # B&E本身不能再指向BNE，P1基线里这条是错的，清空

    for row in out:
        if row["id"] in SUPPLIER_MERGE_OVERRIDES:
            row["merged_into_id"] = SUPPLIER_MERGE_OVERRIDES[row["id"]]
        elif row["id"] in CLEAR_MERGE:
            row["merged_into_id"] = None

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
