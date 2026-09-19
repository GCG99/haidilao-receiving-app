# 生成"stocktake_official_import物料匹配"决策包——纯只读+导出Excel，不写数据库。
# 背景：stocktake_official_import(海底捞7月官方盘点导入，471条真实数据)的material_id
# 全是NULL，没有跟P1的SKU体系做过匹配，导致stock_estimated_current(库存估算视图)用不了
# 这批数据。海底捞内部物料编码(haidilao_material_code)是完全独立的编码体系，没法直接
# 对应我们的SKU，只能靠物料名称做模糊匹配——而且海底捞内部命名习惯带品牌/规格后缀
# (比如"十三香（王守义，盒装，45G*10盒*10条/件）")，精确匹配(SELECT WHERE name=...)
# 只能覆盖471条里的15条(3%)。
#
# 这是真实的物料身份判断，不能自动写入——"糖桂花"这类名字会因为包含"糖"这个字就被
# 朴素子串匹配误判成同一个物料，这种假阳性只有人工看一眼才能排除。所以这个脚本只产出
# 一份分级建议清单，不直接写material_id，跟项目里P1b专间分类决策包同一个模式
# (build_p1b_decision_packet.py)：分级但不代替人工确认。
#
# 用法：python build_stocktake_material_matching_packet.py

import re
from datetime import datetime
from pathlib import Path

import openpyxl
import psycopg2

KUGUAN_ROOT = Path(__file__).resolve().parents[4]
OUT_DIR = KUGUAN_ROOT / "haidilao-receiving-app" / "库管数据"


def load_env():
    env_path = Path(__file__).resolve().parents[3] / ".env"  # haidilao-receiving-app/.env
    env = {}
    for line in env_path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^([A-Z_]+)=(.*)$", line)
        if m:
            env[m.group(1)] = m.group(2)
    return env


def normalize(name):
    # 去掉中文/英文括号里的品牌/规格信息，比如"十三香（王守义，盒装，45G*10盒*10条/件）"->"十三香"
    return re.sub(r"[（(].*?[）)]", "", name or "").strip()


def main():
    env = load_env()
    conn = psycopg2.connect(env["DATABASE_URL"])
    cur = conn.cursor()

    cur.execute("SELECT id, haidilao_material_code, material_name FROM stocktake_official_import ORDER BY id")
    stocktake = cur.fetchall()

    cur.execute("SELECT sku, name, original_name FROM materials WHERE record_status = '在用' ORDER BY sku")
    materials = cur.fetchall()
    conn.close()

    exact_rows, single_rows, multi_rows, none_rows = [], [], [], []

    for row_id, code, name in stocktake:
        norm = normalize(name)
        if not norm:
            none_rows.append((code, name, "物料名称本身是空的"))
            continue

        exact_matches = [
            (sku, mname) for sku, mname, orig in materials
            if normalize(mname) == norm or (orig and normalize(orig) == norm)
        ]
        if exact_matches:
            # 精确匹配理论上应该唯一，但真出现多条也如实列出，不擅自挑一个
            for sku, mname in exact_matches:
                exact_rows.append((code, name, sku, mname))
            continue

        contain_matches = []
        for sku, mname, orig in materials:
            m_norm = normalize(mname)
            o_norm = normalize(orig) if orig else ""
            if (len(m_norm) >= 2 and (m_norm in norm or norm in m_norm)) or (
                o_norm and len(o_norm) >= 2 and (o_norm in norm or norm in o_norm)
            ):
                contain_matches.append((sku, mname))

        if len(contain_matches) == 1:
            single_rows.append((code, name, contain_matches[0][0], contain_matches[0][1]))
        elif len(contain_matches) > 1:
            candidates = "; ".join(f"{sku}:{mname}" for sku, mname in contain_matches[:8])
            multi_rows.append((code, name, candidates, len(contain_matches)))
        else:
            none_rows.append((code, name, "没有找到任何候选"))

    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    def add_sheet(title, header, rows):
        ws = wb.create_sheet(title)
        ws.append(header)
        for r in rows:
            ws.append(list(r))

    add_sheet(
        "精确匹配建议(去括号后完全相等)",
        ["海底捞物料编码", "海底捞物料名称", "建议SKU", "建议物料名称", "最终确认SKU(留空=不采纳建议)", "人工确认状态"],
        [(c, n, sku, mname, "", "") for c, n, sku, mname in exact_rows],
    )
    add_sheet(
        "唯一候选建议(子串匹配，置信度较低)",
        ["海底捞物料编码", "海底捞物料名称", "建议SKU", "建议物料名称", "最终确认SKU(留空=不采纳建议)", "人工确认状态"],
        [(c, n, sku, mname, "", "") for c, n, sku, mname in single_rows],
    )
    add_sheet(
        "多候选待选(需要人工从候选里挑一个)",
        ["海底捞物料编码", "海底捞物料名称", "候选SKU列表", "候选数量", "最终确认SKU", "人工确认状态"],
        [(c, n, cand, cnt, "", "") for c, n, cand, cnt in multi_rows],
    )
    add_sheet(
        "无候选(需要人工另外找，或者本来就不在P1物料体系里)",
        ["海底捞物料编码", "海底捞物料名称", "说明", "最终确认SKU", "人工确认状态"],
        [(c, n, note, "", "") for c, n, note in none_rows],
    )

    ws = wb.create_sheet("说明", 0)
    ws.append(["stocktake_official_import 物料匹配决策包"])
    ws.append([f"生成时间：{datetime.now().isoformat(timespec='seconds')}"])
    ws.append([f"总记录数：{len(stocktake)}"])
    ws.append([f"精确匹配（去括号后完全相等）：{len(exact_rows)}"])
    ws.append([f"唯一候选（子串匹配，需要人工核实，存在假阳性风险如'糖桂花'匹配到'糖'）：{len(single_rows)}"])
    ws.append([f"多候选待选：{len(multi_rows)}"])
    ws.append([f"无候选：{len(none_rows)}"])
    ws.append([])
    ws.append(["这是纯建议清单，脚本本身没有写任何数据库字段。"])
    ws.append(["每个sheet都有'最终确认SKU'列，人工看过、认为建议对的话，把SKU抄进这一列，"])
    ws.append(["或者认为不对/要选别的候选，直接填正确的SKU——这一列填了什么，将来回填material_id"])
    ws.append(["就以这一列为准，不是以'建议SKU'列为准。"])
    ws.append([])
    ws.append(["已知的假阳性风险类型（子串匹配容易出这类错）：两个物料名字一个是另一个的子串，"])
    ws.append(["但实际是完全不同的东西——比如'糖桂花'(桂花糖，一种调味品)会被子串匹配成'糖'(白糖)，"])
    ws.append(["这类情况建议逐条肉眼过一遍再确认，不要整列直接批量抄。"])

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / f"stocktake物料匹配决策包_{datetime.now().strftime('%Y%m%d_%H%M%S')}.xlsx"
    wb.save(out_path)

    print(f"精确匹配: {len(exact_rows)}")
    print(f"唯一候选: {len(single_rows)}")
    print(f"多候选: {len(multi_rows)}")
    print(f"无候选: {len(none_rows)}")
    print(f"已写入: {out_path}")


if __name__ == "__main__":
    main()
