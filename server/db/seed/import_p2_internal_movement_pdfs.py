# -*- coding: utf-8 -*-
"""
历史数据清洗：把 库管/盘点/4月~7月 目录下海底捞内部ERP系统导出的月度出入库/领用/报损/调拨
PDF单据导入 internal_movement_import 表(migration 0011)。

背景见 0011_internal_movement_import.sql 顶部注释：这批PDF是纯文本(不是扫描图片)，
用 pymupdf 直接提取文字，不需要OCR/视觉API。

两种源文件格式：
1. "标准出入库/领用"格式(占绝大多数)：表头有 序号/物料编号/物料名称/规格/单位/(反冲数量|实发数量)，
   "反冲数量"=入库方向，"实发数量"=出库/领用方向——direction从这个列名机械推导，不是猜的。
   单据自己的标题行(如"加工领用出库单"/"物料领用单"/"加工领用入库单")在"凭证编号："前一行，
   取作movement_type。多页单据每页重复表头，序号跨页连续，按源文件自己的序号取line_no。
2. "报损明细"/"调拨明细"：独立表格式，字段更少，且这次遇到的两份文件里，部分相邻列的值
   被pymupdf提取成了同一行文本(视觉上窄列紧挨着导致没有独立换行)，用正则从这一行文本里拆出来，
   不是标准逐行提取——本轮只各有1条真实数据，规则针对这两份文件手写，不是通用格式解析器。

不做的事：不判断/改写调拨明细数量的正负号(源文件自带-10.000这种带符号值，原样存)；不把
haidilao_material_code跟P1 SKU做匹配(material_id全部保持NULL，跟stocktake_official_import
的处理方式一致，是独立的清洗工作)。

本轮明确排除的文件(不在这次导入范围内，理由见 P2_设计文档/线A线B整合规划.md 或commit message)：
- 盘点/7月/澳大利亚六店2026年7月盘点表.pdf ——这次打开发现是另一份完全不同结构的盘点快照
  (行号/物料编码/物料名称/库存数量/盘点数量/单位描述/单位编码/部门，逐行单一部门，覆盖范围明显
  比附表2.xlsx更广，包含非食材类库管物资如刀具/手套/酒水)，是"盘点"类数据不是"流水"类数据，
  不该放进internal_movement_import；跟已导入的附表2.xlsx是否有材料范围重叠没有核实，
  留作独立待办，不在这次任务里处理。
- 盘点/7月/附表2：AU6D-20260731 库存盘点表 - 高晨歌.xlsx ——已通过另一个脚本导入
  stocktake_official_import，不重复处理。
- 盘点/炒料原料统计表.xlsx、盘点/AU6D门店底料和国内开货物料日均*.xlsx ——配方/BOM及日均参考数据，
  不是单据，不属于这个脚本范围。

本地only：连接本地Docker Postgres，不是生产库。
"""
import os
import re
import hashlib
import psycopg2
import pymupdf

DATABASE_URL = "postgres://postgres:devpassword@localhost:5432/haidilao"
BASE_DIR = r"C:\Users\18426\Desktop\库管\盘点"

# (相对路径, 文件类别) —— 'standard' 用通用6列解析器，'loss'/'transfer' 用专用解析器
FILES = [
    (r"4月\AU6D 4月员工餐.pdf", "standard"),
    (r"4月\AU6D 4月成品入库.PDF", "standard"),
    (r"4月\AU6D 4月成品原材料出库.PDF", "standard"),
    (r"4月\AU6D 4月成品原材料补单出库.PDF", "standard"),
    (r"4月\AU6D 4月酱料入库.PDF", "standard"),
    (r"4月\AU6D 4月酱料出库.PDF", "standard"),
    (r"5月\AU6D  5月酱料入库.PDF", "standard"),
    (r"5月\AU6D 5月员工餐领用.PDF", "standard"),
    (r"5月\AU6D 5月成品原材料入库.PDF", "standard"),
    (r"5月\AU6D 5月成品原材料出库.PDF", "standard"),
    (r"5月\AU6D 5月酱料出库.PDF", "standard"),
    (r"6月\AU6D 6月 酱料领用出库.PDF", "standard"),
    (r"6月\AU6D 6月员工餐领用.PDF", "standard"),
    (r"6月\AU6D 6月成品入库.PDF", "standard"),
    (r"6月\AU6D 6月成品领用出库.PDF", "standard"),
    (r"6月\AU6D 6月酱料入库.PDF", "standard"),
    (r"7月\AU6D 7月成品原材料出库4925789649-2026.PDF", "standard"),
    (r"7月\AU6D7月员工餐领用4925787898-2026.PDF", "standard"),
    (r"7月\AU6D7月成品原材料出库4925787667-2026.PDF", "standard"),
    (r"7月\AU6D成品入库4925787687-2026.PDF", "standard"),
    (r"7月\澳大利亚六店2026年7月报损明细表.pdf", "loss"),
    (r"7月\2026年7月调拨明细-澳大利亚六店.pdf", "transfer"),
]

QTY_HEADER_DIRECTION = {"反冲数量": "in", "实发数量": "out"}


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1 << 20)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def parse_date(raw):
    # 源文件日期格式见到过 "2026.04.30" 和 "2026/7/30" 两种，统一转 YYYY-MM-DD
    m = re.match(r"(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})", raw.strip())
    if not m:
        return None
    y, mo, d = m.groups()
    return f"{y}-{int(mo):02d}-{int(d):02d}"


def parse_standard(path, rel_path):
    doc = pymupdf.open(path)
    rows = []
    voucher_no = None
    document_date = None
    movement_type = None
    next_line_no = 1  # 文件级全局递增计数器，不用源文件自己的"序号"直接当line_no——
                       # 发现有单个PDF文件内含多个独立凭证、各自从"序号=1"重新起数的情况
                       # (4月员工餐.pdf就是两个凭证4925686957/4925688347拼在一个文件里)，
                       # 如果直接拿源文件序号当去重键，跨凭证的"序号=1"会互相当成重复行丢弃。
                       # 源文件自己的序号仍然用来做"这一组6个token是不是一行真实数据"的对齐校验，
                       # 只是不再拿它的值本身当line_no存进去。

    for page in doc:
        lines = [ln.strip() for ln in page.get_text().split("\n")]
        lines = [ln for ln in lines if ln != ""]

        # 表头字段：每页重新提取一次，不是只取第一次出现——发现过单个PDF文件内
        # 前几页是凭证A、后几页是凭证B拼在一起的情况(见上面line_no计数器的注释)，
        # 如果只在voucher_no is None时才赋值，后面凭证会被错误地贴上前一个凭证的编号。
        for i, ln in enumerate(lines):
            if ln.startswith("领料日期："):
                document_date = parse_date(ln.split("：", 1)[1])
            if ln.startswith("凭证编号："):
                voucher_no = ln.split("：", 1)[1].strip()
                if i > 0:
                    candidate = lines[i - 1]
                    if candidate and "：" not in candidate:
                        movement_type = candidate

        # 定位数据表：找 "单位" 后面紧跟 "反冲数量"/"实发数量" 的表头结束位置
        qty_header_idx = None
        qty_direction = None
        for i, ln in enumerate(lines):
            if ln in QTY_HEADER_DIRECTION:
                qty_header_idx = i
                qty_direction = QTY_HEADER_DIRECTION[ln]
                break
        if qty_header_idx is None:
            continue  # 这一页没有数据表(理论上不该发生，标准格式每页都有)

        # 数据行从 qty_header_idx+1 开始，每6个token一组：序号/物料编号/物料名称/规格/单位/数量
        # 直到遇到 "负责人：" 结束
        j = qty_header_idx + 1
        while j < len(lines) and lines[j] != "负责人：":
            if j + 5 >= len(lines):
                break
            line_no_raw, code, name, spec, unit, qty_raw = lines[j:j + 6]
            try:
                int(line_no_raw)  # 只用来校验这组token确实是"序号+数据"的一行，值本身不采用
                qty = float(qty_raw)
            except ValueError:
                # 格式跟预期不符，跳过这一组，避免把非数据行硬凑成一条记录
                j += 1
                continue
            line_no = next_line_no
            next_line_no += 1
            rows.append({
                "movement_type": movement_type or "未知(未能从单据提取标题)",
                "direction": qty_direction,
                "voucher_no": voucher_no,
                "document_date": document_date,
                "haidilao_material_code": code,
                "material_name": name,
                "spec": spec,
                "unit": unit,
                "quantity": qty,
                "reason": None,
                "transfer_from_store": None,
                "transfer_to_store": None,
                "line_no": line_no,
            })
            j += 6
    return rows


def parse_loss(path, rel_path):
    """报损明细：这次只有1份文件、1条真实数据，按其具体版式手写解析。"""
    doc = pymupdf.open(path)
    lines = [ln.strip() for ln in doc[0].get_text().split("\n") if ln.strip()]
    # 已知版式(见脚本头部注释)：
    # ['澳大利亚区域门店报损明细','月份','门店名称','门店','物料号','名称','数量','单位','报损原因','备注',
    #  '2026.07','澳大利亚六店','AU06 1045672','民福记酸菜包...','4','箱','破损', '库管（采购）：', '店经理：']
    data_start = lines.index("2026.07") if "2026.07" in lines else None
    if data_start is None:
        raise ValueError(f"报损明细解析失败，未找到预期的月份值，源文件格式可能变了：{rel_path}")
    month_raw = lines[data_start]
    store_name = lines[data_start + 1]
    store_and_code = lines[data_start + 2]  # "AU06 1045672" 门店代码+物料号被提取到同一行
    m = re.match(r"(AU\d+)\s+(\S+)", store_and_code)
    if not m:
        raise ValueError(f"报损明细'门店 物料号'合并行格式不符预期：{store_and_code!r}")
    store_code, material_code = m.groups()
    name = lines[data_start + 3]
    qty = float(lines[data_start + 4])
    unit = lines[data_start + 5]
    reason = lines[data_start + 6]

    document_date = f"{month_raw.split('.')[0]}-{month_raw.split('.')[1]}-01"  # 只有月份精度，日期取当月1号占位
    return [{
        "movement_type": "报损",
        "direction": "out",
        "voucher_no": None,
        "document_date": document_date,
        "haidilao_material_code": material_code,
        "material_name": name,
        "spec": None,
        "unit": unit,
        "quantity": qty,
        "reason": reason,
        "transfer_from_store": store_code,
        "transfer_to_store": None,
        "line_no": 1,
    }]


def parse_transfer(path, rel_path):
    """调拨明细：这次只有1份文件、1条真实数据，按其具体版式手写解析。"""
    doc = pymupdf.open(path)
    lines = [ln.strip() for ln in doc[0].get_text().split("\n") if ln.strip()]
    # 已知版式：日期行是 "2026/7/30" 独占一行，紧接 调出门店/调入门店/"物料号 物料描述"合并行/数量/单位
    date_idx = None
    for i, ln in enumerate(lines):
        if re.match(r"\d{4}/\d{1,2}/\d{1,2}$", ln):
            date_idx = i
            break
    if date_idx is None:
        raise ValueError(f"调拨明细解析失败，未找到日期行，源文件格式可能变了：{rel_path}")
    document_date = parse_date(lines[date_idx])
    from_store = lines[date_idx + 1]
    to_store = lines[date_idx + 2]
    code_and_desc = lines[date_idx + 3]  # "4524541 八爪鱼20/40（IQF，500G*20袋/箱）"
    m = re.match(r"(\d+)\s+(.+)", code_and_desc)
    if not m:
        raise ValueError(f"调拨明细'物料号 物料描述'合并行格式不符预期：{code_and_desc!r}")
    material_code, name = m.groups()
    qty = float(lines[date_idx + 4])  # 源文件自带符号(示例是负数)，原样存
    unit = lines[date_idx + 5]

    return [{
        "movement_type": "调拨",
        "direction": "out" if qty < 0 else "in",
        "voucher_no": None,
        "document_date": document_date,
        "haidilao_material_code": material_code,
        "material_name": name,
        "spec": None,
        "unit": unit,
        "quantity": qty,
        "reason": None,
        "transfer_from_store": from_store,
        "transfer_to_store": to_store,
        "line_no": 1,
    }]


PARSERS = {"standard": parse_standard, "loss": parse_loss, "transfer": parse_transfer}


def main():
    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    cur = conn.cursor()

    total_inserted = 0
    total_files = 0
    per_file_counts = []

    for rel_path, kind in FILES:
        full_path = os.path.join(BASE_DIR, rel_path)
        if not os.path.exists(full_path):
            raise FileNotFoundError(f"预期存在的源文件缺失：{full_path}")
        rows = PARSERS[kind](full_path, rel_path)
        if not rows:
            raise ValueError(f"解析出0条记录，判定为解析器跟源文件版式不匹配，需要人工检查：{rel_path}")

        source_file_label = f"盘点\\{rel_path}"
        for row in rows:
            cur.execute(
                """INSERT INTO internal_movement_import
                   (movement_type, direction, voucher_no, document_date, material_id,
                    haidilao_material_code, material_name, spec, unit, quantity,
                    reason, transfer_from_store, transfer_to_store, line_no, source_file)
                   VALUES (%s, %s, %s, %s, NULL, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (source_file, line_no) DO NOTHING""",
                (row["movement_type"], row["direction"], row["voucher_no"], row["document_date"],
                 row["haidilao_material_code"], row["material_name"], row["spec"], row["unit"],
                 row["quantity"], row["reason"], row["transfer_from_store"], row["transfer_to_store"],
                 row["line_no"], source_file_label),
            )
        total_inserted += len(rows)
        total_files += 1
        per_file_counts.append((rel_path, len(rows)))

    conn.commit()

    print(f"处理文件数: {total_files}")
    print(f"解析出的记录总数(含跳过前): {total_inserted}")
    print("逐文件行数:")
    for rel_path, n in per_file_counts:
        print(f"  {rel_path}: {n}")

    cur.execute("SELECT COUNT(*) FROM internal_movement_import")
    print(f"\n校验查询: 表内总行数={cur.fetchone()[0]}")

    cur.execute(
        "SELECT movement_type, direction, COUNT(*), SUM(quantity) "
        "FROM internal_movement_import GROUP BY movement_type, direction ORDER BY movement_type"
    )
    print("按movement_type/direction汇总:")
    for row in cur.fetchall():
        print("  ", row)

    cur.execute(
        "SELECT source_file, haidilao_material_code, material_name, quantity, direction "
        "FROM internal_movement_import ORDER BY id LIMIT 5"
    )
    print("样本行:")
    for row in cur.fetchall():
        print("  ", row)

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
