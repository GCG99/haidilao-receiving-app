# -*- coding: utf-8 -*-
"""
历史数据清洗：把 库管/盘点/7月/附表2：AU6D-20260731 库存盘点表 - 高晨歌.xlsx
"盘点数据填写"sheet的757行真实数据导入 stocktake_official_import 表(migration 0010)。

物料匹配：haidilao_material_code是海底捞内部系统自己的编码，不是P1 SKU体系，这批历史数据完全没有
跟P1物料库做过匹配(0010设计时就说明了这点，material_id允许NULL)。本轮同样不做匹配——匹配需要
P1物料名称与这批物料名称的映射规则，属于独立的一块清洗工作，不在本次"发票+盘点数据入库"范围内，
material_id全部保持NULL，haidilao_material_code/material_name原样保留供以后匹配用。

department_breakdown：源表表头结构是2行合并表头(行2+行3)，同一批"部门/库位"标签在列10-20和列21-31
两处重复出现(一处是原始文本+一处是"XX数量"后缀)，且列9/10本身还是这条记录自己的"部门/库位"归属字段，
语义结构没有完全理清楚(不影响核心字段的正确导入)。为了不在语义不确定的情况下勉强拍板每个字段该叫
什么名字，department_breakdown按"列号+当时表头文本+值"原样存成list，不做归纳猜测——保留原始结构，
以后真正需要按部门细分查询时再回头精确解析，不因为这次图省事就丢信息或编错字段名。

已验证：消耗量(列33) = 库存数量(列5) - 总盘点数量(列32)，757行完整数据100%成立，0例外(P2_设计文档/
线A线B整合规划.md已记录)。本脚本原样导入consumption_quantity，不重新计算，忠于原始导出值。

本地only：连接.env里的本地Docker Postgres，不是生产库。
"""
import os
import json
import hashlib
import openpyxl
import psycopg2

SOURCE_PATH = r"C:\Users\18426\Desktop\库管\盘点\7月\附表2：AU6D-20260731 库存盘点表 - 高晨歌.xlsx"
SHEET_NAME = "盘点数据填写"
PERIOD_END_DATE = "2026-07-31"  # 文件名里的日期，本次盘点周期结束日
DATABASE_URL = "postgres://postgres:devpassword@localhost:5432/haidilao"

# 列9-31是"部门/库位"相关的原始区块(语义未完全理清，原样打包进department_breakdown，不猜字段名)
BREAKDOWN_COL_RANGE = range(9, 32)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def main():
    wb = openpyxl.load_workbook(SOURCE_PATH, data_only=True)
    ws = wb[SHEET_NAME]

    # 表头在行2/行3(合并表头)，行3有更细的子标签，优先用行3、没有则退回行2
    header2 = {c: ws.cell(row=2, column=c).value for c in range(1, ws.max_column + 1)}
    header3 = {c: ws.cell(row=3, column=c).value for c in range(1, ws.max_column + 1)}
    col_label = {c: (header3.get(c) or header2.get(c)) for c in range(1, ws.max_column + 1)}

    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    cur = conn.cursor()

    total_rows = 0
    inserted = 0
    skipped_incomplete = 0
    consumption_mismatch = 0

    for r in range(4, ws.max_row + 1):
        code = ws.cell(row=r, column=3).value
        # 2026-09-19发现的真实bug：源表格从第475行起是"公式链接但无实际物料"的模板占位行——
        # 物料编码/名称/全部数量列的公式返回数字0而不是空值None，原来的"code is None"判断
        # 拦不住这种情况，导致287行(占757行总数的38%)垃圾数据被当成真实盘点记录插入。
        # 真实物料编码不可能是字面值0，用这条兜底。
        if code is None or code == 0:
            continue
        total_rows += 1
        name = ws.cell(row=r, column=4).value
        opening = ws.cell(row=r, column=5).value
        counted_total = ws.cell(row=r, column=32).value
        consumption = ws.cell(row=r, column=33).value
        anomaly_note = ws.cell(row=r, column=34).value

        if opening is None or counted_total is None:
            skipped_incomplete += 1
            continue

        if consumption is not None and isinstance(opening, (int, float)) and isinstance(counted_total, (int, float)):
            expected = round(opening - counted_total, 3)
            if round(float(consumption), 3) != expected:
                consumption_mismatch += 1

        breakdown = []
        for c in BREAKDOWN_COL_RANGE:
            v = ws.cell(row=r, column=c).value
            if v is not None:
                breakdown.append({"col": c, "label": col_label.get(c), "value": v})

        cur.execute(
            """INSERT INTO stocktake_official_import
               (material_id, haidilao_material_code, material_name, period_end_date,
                opening_quantity, counted_quantity, consumption_quantity, anomaly_note,
                department_breakdown, source_file)
               VALUES (NULL, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (str(code), name, PERIOD_END_DATE,
             opening if isinstance(opening, (int, float)) else None,
             counted_total if isinstance(counted_total, (int, float)) else None,
             consumption if isinstance(consumption, (int, float)) else None,
             anomaly_note,
             json.dumps(breakdown, ensure_ascii=False),
             "盘点/7月/附表2：AU6D-20260731 库存盘点表 - 高晨歌.xlsx#盘点数据填写"),
        )
        inserted += 1

    conn.commit()
    print(f"源数据总行数(物料编码非空): {total_rows}")
    print(f"实际插入 stocktake_official_import: {inserted} 条")
    print(f"因缺库存数量/总盘点数量跳过: {skipped_incomplete} 条")
    print(f"消耗量与(库存数量-总盘点数量)不一致的行数: {consumption_mismatch}")

    cur.execute("SELECT COUNT(*), SUM(consumption_quantity) FROM stocktake_official_import")
    cnt, total_consumption = cur.fetchone()
    print(f"校验查询: 表内总行数={cnt}, 消耗量合计={total_consumption}")

    cur.execute(
        "SELECT haidilao_material_code, material_name, opening_quantity, counted_quantity, consumption_quantity "
        "FROM stocktake_official_import ORDER BY id LIMIT 3"
    )
    print("样本行:")
    for row in cur.fetchall():
        print("  ", row)

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
