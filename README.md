# 海底捞每日收货验收 v4.3

## 功能

- 必须使用飞书账号登录。
- 登录后显示当前操作人。
- 未登录不能读取供应商计划或提交收货记录。
- 同一供应商、同一次收货的所有照片写入同一条"收货记录"。
- 每张照片自动重命名：
  `日期_供应商_验收项目_操作人_序号_原文件名`
- 一种项目可以上传很多张照片。
- 收货记录 Base 仍然只需要四列：
  供应商 / 收货日期 / 验收类型 / 验收照片（附件），另外自动补充状态/操作人/异常说明等字段用于总览看板和已提交照片回显。
- 飞书供应商计划读取失败时直接报错提示，不使用本地假数据兜底。
- 未完成看板：`/overview` 页面可按日期范围查看哪些供应商还没提交。

## 当前两个 Base

供应商计划：
- App Token: `MdTobJKCUa5HArssAQqctz8snCc`
- Table ID: `tblCYpnfRvfqf7Gu`

收货记录：
- App Token: `PpFrbBKHqaAN6LsNVUoccKkPntd`
- Table ID: `tbl7cLHZ4vZwDav0`

## 你必须在飞书应用里增加

需要使用飞书 Web OAuth 登录。

在飞书开放平台的应用安全/重定向地址配置中加入：

本地测试：
`http://localhost:3001/api/auth/callback`

正式部署：
`https://你的Render域名/api/auth/callback`

如果登录授权页面提示缺少用户信息权限，再按飞书开放平台当前页面为应用增加用户基本信息读取权限。

## .env

复制 `.env.example` 为 `.env`：

```env
FEISHU_APP_ID=cli_aa16f8af33f8dd05
FEISHU_APP_SECRET=你的App Secret
FEISHU_REDIRECT_URI=http://localhost:3001/api/auth/callback

FEISHU_SUPPLIER_APP_TOKEN=MdTobJKCUa5HArssAQqctz8snCc
FEISHU_SUPPLIER_TABLE_ID=tblCYpnfRvfqf7Gu

FEISHU_RECEIVING_APP_TOKEN=PpFrbBKHqaAN6LsNVUoccKkPntd
FEISHU_RECEIVING_TABLE_ID=tbl7cLHZ4vZwDav0

SESSION_SECRET=你自己生成的长随机字符串
PORT=3001
```

`.env` 不上传 GitHub。

## 运行

```bash
npm install
npm run dev
```

本地访问：
`http://localhost:5173`

## 正式上线

Render 环境变量中设置同样的变量，并把：

`FEISHU_REDIRECT_URI`

改成 Render 的 HTTPS 公网地址：

`https://你的服务.onrender.com/api/auth/callback`

然后必须回到飞书开放平台，把这个公网回调地址加入应用允许的重定向地址。

## 安全设计

App Secret 只存在 Node.js 服务端。
浏览器只拿 HttpOnly + 签名登录 Cookie。
每次读取供应商和提交收货记录都要求已登录。


## v4.1 调整（登录 / 送货单前置判断）

每个供应商最前面统一增加：
1. 今天有没有送货？
2. 今天有送货 → 必须提交"送货单照片"（支持多张，上传后飞书 OCR 自动识别品项并预勾选，员工可手动核对/修改）
3. 今天没有送货 → 直接完成该供应商，不再显示后续验收项目

送货单照片自动命名为：
`日期_供应商_送货单_操作人_序号_原文件名`

## v4.2 调整（三选一流程 / 领鲜简化）

"冻货"和"普通供应商"两类，把原来的两步提问合并成一次三选一：
没有送货 / 有送货·没有冻货 / 有送货·有冻货。选到"有冻货"只需要提交一张测温照片。

领鲜（蔬菜/水果/土豆）不再逐类勾选"今天有没有这个品类"，改成固定四块照片
（货物状态 / 称重 / 甜度测试 / 土豆验收），全部选填，按当天实际到货情况上传。

## v4.3（合并版）

把 v4.1 和 v4.2 各自独立开发出的功能合到了一起：登录、总览看板、送货单必传
+ OCR 识别（来自 v4.1）与三选一送货流程、领鲜四块选填照片（来自 v4.2）现在
是同一个版本。

## Phase 0：独立数据库（2026-09-13）

数据库现在是唯一权威源，飞书两个 Base 退化为同步副本（写数据库成功才算提交成功；
飞书同步实时做，但失败不影响提交结果，只标 `sync_status` 留着以后补）。
详细背景和后续阶段见 `P2_设计文档/全系统合并架构与路线图.md`。

**本地开发**：

```bash
docker run -d --name haidilao-pg -e POSTGRES_PASSWORD=devpassword -e POSTGRES_DB=haidilao -p 5432:5432 postgres:16-alpine
npm run db:migrate   # 建表（server/db/schema.sql）
```

物料/供应商字典需要从 P1 正式基线重新生成一次快照再导入（快照文件含真实业务数据，
不进 git，见 `.gitignore`）：

```bash
python server/db/seed/export_p1.py   # 生成 server/db/seed/data/*.json
npm run db:seed                      # 导入 Postgres，可重复运行（按主键 upsert）
```

**部署到 Render**：Apply 这个仓库的 Blueprint 会连数据库一起建好（`render.yaml`
里的 `databases:`），`DATABASE_URL` 自动注入不用手填。但 `npm run db:seed` 需要
本地的 `data/*.json`，Render 构建环境里没有这些文件——首次上线需要在本地把
`DATABASE_URL` 临时指向 Render 数据库的外部连接串，跑一次 `npm run db:seed`，
之后代码里对数据库的读写走的是同一张表，不用每次部署都重新种一次。

Phase 0 目前只建了收货小程序用得上的表（`suppliers` / `supplier_delivery_schedule`
/ `categories` / `materials` 字典 + `receiving_records` / `receiving_photos`）。
采购单/到货验收/入库单/发票/库存流水这几张 P2 表还没建，等后续 Phase 真正需要时再加。
照片文件本体暂时还是存在飞书 Drive，数据库只存 `file_token` 引用。
