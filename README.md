# 海底捞每日收货验收 v4.1

## 功能

- 必须使用飞书账号登录。
- 登录后显示当前操作人。
- 未登录不能读取供应商计划或提交收货记录。
- 同一供应商、同一次收货的所有照片写入同一条“收货记录”。
- 每张照片自动重命名：
  `日期_供应商_验收项目_操作人_序号_原文件名`
- 一种项目可以上传很多张照片。
- 收货记录 Base 仍然只需要四列：
  供应商 / 收货日期 / 验收类型 / 验收照片（附件）

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


## v4.1 本次调整

每个供应商最前面统一增加：
1. 今天有没有送货？
2. 今天有送货 → 必须提交“送货单照片”（支持多张）
3. 今天没有送货 → 直接完成该供应商，不再显示后续验收项目

送货单照片自动命名为：
`日期_供应商_送货单_操作人_序号_原文件名`
