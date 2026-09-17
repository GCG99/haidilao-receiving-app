# -*- coding: utf-8 -*-
"""
历史数据清洗：把 库管/8月发票校验总表.xlsx 的真实发票记录导入 invoices 表。

按 P2_清洗与匹配规则.md 的强制原则"任何非精确匹配都不直接写正式表"：
- 29个供应商sheet里27个跟suppliers表精确字符串匹配(含'Coworkc'/'Cowrock'这种查表后确认是两个独立
  真实供应商、不是拼写变体的情况)，2个('丰收'/'HAC')无精确匹配，不写invoices，进pending清单。
- 7笔负金额记录(源数据无"退货/信用"标注)不写invoices，进pending清单——跟ChatGPT确认过，不能自行
  判断"这大概率是Credit Note"就转去credits表，这本身是业务判断，留给用户。

GST字段推断(已跟ChatGPT讨论、非拍脑袋)：Invoice Amount=含税总额，GST=其中的税额部分(不是额外加的税)——
依据：抽样B&E一行 Amount=2208.29/GST=68.01，若Amount是税前金额+10%税，GST应约等于220.83，实际远低于
此，符合"澳洲食材类供应商大部分商品免GST、仅部分应税项目"的常见业务模式。subtotal = amount - gst。
此推断已在最终报告里明确标注为假设，不是查表查到的事实。

日期DD/MM/YYYY已用数据本身验证(出现31/8/2026，第二段不可能是月份31，确认第一段是日)。

本地only：连接的是.env里的本地Docker Postgres，不是生产库。
"""
import os
import json
import hashlib
import openpyxl
import psycopg2

PROJECT_ROOT = r"C:\Users\18426\Desktop\库管"
SOURCE_PATH = os.path.join(PROJECT_ROOT, "8月发票校验总表.xlsx")
APP_ROOT = r"C:\Users\18426\Desktop\库管\haidilao-receiving-app"
PENDING_OUT = os.path.join(APP_ROOT, "库管数据", "P2_8月发票_pending清单.json")  # 含真实金额，不进git

DATABASE_URL = "postgres://postgres:devpassword@localhost:5432/haidilao"


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

    conn = psycopg2.connect(DATABASE_URL)
    conn.autocommit = False
    cur = conn.cursor()

    cur.execute("SELECT id, name FROM suppliers")
    sup_by_name = {name.strip(): sid for sid, name in cur.fetchall()}

    clean = []
    pending = []

    for sheet_name_raw in wb.sheetnames:
        ws = wb[sheet_name_raw]
        sheet_name = sheet_name_raw.strip()
        supplier_id = sup_by_name.get(sheet_name)
        for r in range(3, ws.max_row + 1):
            date, invno_raw, amt, gst = [ws.cell(row=r, column=c).value for c in range(1, 5)]
            if date is None and invno_raw is not None and str(invno_raw).strip().lower() in ("total", "totals"):
                continue
            has_data = invno_raw is not None or amt is not None or (gst not in (None, 0))
            if not has_data:
                continue
            invno = str(invno_raw).strip() if invno_raw is not None else None
            rec = dict(sheet=sheet_name, row=r, date=date, invno=invno, amt=amt, gst=gst, supplier_id=supplier_id)
            if not supplier_id:
                rec["reason"] = f"供应商sheet名'{sheet_name}'在suppliers表里没有精确匹配，需人工指定或补充别名"
                pending.append(rec)
                continue
            if not invno:
                rec["reason"] = "缺少发票号，无法确定唯一性"
                pending.append(rec)
                continue
            if isinstance(amt, (int, float)) and amt < 0:
                rec["reason"] = f"金额为负数({amt})且源数据无退货/信用标注，需人工判断是发票金额调整还是应转为Credit Note"
                pending.append(rec)
                continue
            clean.append(rec)

    print(f"可精确写入 invoices 的行数: {len(clean)}")
    print(f"落入 pending 清单的行数: {len(pending)}")

    sha256 = sha256_of(SOURCE_PATH)
    cur.execute(
        """INSERT INTO source_files (file_name, mime_type, storage_provider, storage_path, sha256)
           VALUES (%s, %s, 'local', %s, %s) RETURNING id""",
        ("8月发票校验总表.xlsx",
         "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
         SOURCE_PATH, sha256),
    )
    source_file_id = cur.fetchone()[0]

    inserted = 0
    skipped_dup = 0
    for rec in clean:
        d, m, y = [int(x) for x in rec["date"].split("/")]
        iso_date = f"{y:04d}-{m:02d}-{d:02d}"
        amt = rec["amt"] if isinstance(rec["amt"], (int, float)) else None
        gst = rec["gst"] if isinstance(rec["gst"], (int, float)) else 0
        subtotal = round(amt - gst, 2) if amt is not None else None

        cur.execute("SELECT id FROM invoices WHERE supplier_id=%s AND invoice_no=%s",
                     (rec["supplier_id"], rec["invno"]))
        if cur.fetchone():
            skipped_dup += 1
            continue

        cur.execute(
            """INSERT INTO invoices
               (supplier_id, invoice_no, invoice_date, currency, subtotal, gst, total_amount,
                source, source_file_id, status)
               VALUES (%s,%s,%s,'AUD',%s,%s,%s,%s,%s,'confirmed')""",
            (rec["supplier_id"], rec["invno"], iso_date, subtotal, gst, amt,
             f"历史清洗:8月发票校验总表.xlsx#{rec['sheet']}#row{rec['row']}", source_file_id),
        )
        inserted += 1

    conn.commit()
    print(f"实际插入 invoices: {inserted} 条，跳过重复(supplier_id+invoice_no已存在): {skipped_dup} 条")

    with open(PENDING_OUT, "w", encoding="utf-8") as f:
        json.dump(pending, f, ensure_ascii=False, indent=2, default=str)
    print(f"pending清单已写入 {PENDING_OUT}，共 {len(pending)} 条")

    cur.execute(
        """SELECT s.name, COUNT(*), SUM(i.total_amount)
           FROM invoices i JOIN suppliers s ON s.id=i.supplier_id
           WHERE i.source_file_id=%s GROUP BY s.name ORDER BY s.name""",
        (source_file_id,),
    )
    print("按供应商汇总(校验用):")
    for name, cnt, total in cur.fetchall():
        print(f"  {name}: {cnt}条, 合计{total}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
