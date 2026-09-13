import "dotenv/config";
import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

const app = express();
const port = Number(process.env.PORT || 3001);
const FEISHU = "https://open.feishu.cn";
const AUTHORIZE_URL = "https://accounts.feishu.cn/open-apis/authen/v1/authorize";

const requiredEnv = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_REDIRECT_URI",
  "FEISHU_SUPPLIER_APP_TOKEN",
  "FEISHU_SUPPLIER_TABLE_ID",
  "FEISHU_RECEIVING_APP_TOKEN",
  "FEISHU_RECEIVING_TABLE_ID",
  "SESSION_SECRET"
];

const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const typeLabels = {
  produce: "领鲜",
  frozen: "冻货",
  meat: "Cowrock",
  northern: "北方",
  other: "普通"
};

const labelToType = Object.fromEntries(
  Object.entries(typeLabels).map(([type, label]) => [label, type])
);

// OCR 识别送货单文字后，用关键词猜测这次送货可能涉及哪些验收项目。
// 只用来预勾选，员工可以随时手动改回去。
const ocrKeywordRules = [
  { keyword: "牛", selection: "beef" },
  { keyword: "羊", selection: "lamb" },
  { keyword: "猪", selection: "pork" },
  { keyword: "冻", selection: "northernFrozen" },
  { keyword: "冻", selection: "frozenGoods" },
  { keyword: "冻", selection: "frozenMeat" },
  { keyword: "鲜切", selection: "freshMeat" },
  { keyword: "鲜切", selection: "northernFresh" },
  { keyword: "菜", selection: "vegetables" },
  { keyword: "蔬", selection: "vegetables" },
  { keyword: "果", selection: "fruits" },
  { keyword: "土豆", selection: "potato" },
  { keyword: "马铃薯", selection: "potato" }
];

function guessSelectionsFromText(text) {
  const suggestions = {};
  for (const rule of ocrKeywordRules) {
    if (text.includes(rule.keyword)) {
      suggestions[rule.selection] = true;
    }
  }
  return suggestions;
}

const photoLabels = {
  delivery_note: "送货单",
  truck_temperature: "车厢测温",
  northern_beef_weight: "牛肉_称重",
  northern_beef_temperature: "牛肉_测温",
  northern_lamb_weight: "羊肉_称重",
  northern_lamb_temperature: "羊肉_测温",
  northern_pork_weight: "猪肉_称重",
  northern_pork_temperature: "猪肉_测温",
  northern_fresh_weight: "鲜切肉_称重",
  northern_fresh_temperature: "鲜切肉_测温",
  frozen_temperature: "冻货_测温",
  frozen_quality: "冻货_状态",
  fresh_weight: "鲜切肉_称重",
  fresh_temperature: "鲜切肉_测温",
  frozen_meat_weight: "冻肉_称重",
  frozen_meat_temperature: "冻肉_测温",
  vegetable_arrival: "蔬菜_到货",
  weighted_products: "按重量产品_称重",
  fruit_sweetness: "水果_甜度",
  potato_inspection: "土豆_拆袋验货"
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 100,
    fileSize: 15 * 1024 * 1024,
    fieldSize: 1024 * 1024
  }
});

function checkEnv() {
  const missing = requiredEnv.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`缺少环境变量：${missing.join(", ")}`);
  }
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signValue(value) {
  return crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update(value)
    .digest("base64url");
}

function createSignedCookie(payload) {
  const body = encodeBase64Url(JSON.stringify(payload));
  return `${body}.${signValue(body)}`;
}

function readSignedCookie(raw) {
  if (!raw) return null;

  const firstDot = raw.indexOf(".");
  if (firstDot <= 0) return null;

  const body = raw.slice(0, firstDot);
  const signature = raw.slice(firstDot + 1);
  const expected = signValue(body);

  if (
    !signature ||
    !crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    )
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(decodeBase64Url(body));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header = "") {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const equals = part.indexOf("=");
      if (equals < 0) return acc;
      const key = part.slice(0, equals);
      const value = decodeURIComponent(part.slice(equals + 1));
      acc[key] = value;
      return acc;
    }, {});
}

function setCookie(res, name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path || "/"}`,
    `HttpOnly`,
    `SameSite=${options.sameSite || "Lax"}`
  ];
  if (options.maxAge != null) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  if (process.env.NODE_ENV === "production") parts.push("Secure");

  res.append("Set-Cookie", parts.join("; "));
}

function clearCookie(res, name) {
  setCookie(res, name, "", { maxAge: 0 });
}

function getCurrentUser(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  return readSignedCookie(cookies["receiving_auth"]);
}

function requireLogin(req, res, next) {
  const user = getCurrentUser(req);

  if (!user) {
    return res.status(401).json({
      code: "AUTH_REQUIRED",
      message: "请先使用飞书登录。"
    });
  }

  req.user = user;
  next();
}

let tenantToken = "";
let tenantTokenExpireAt = 0;

async function getTenantAccessToken() {
  checkEnv();

  if (tenantToken && Date.now() < tenantTokenExpireAt - 60_000) {
    return tenantToken;
  }

  const response = await fetch(
    `${FEISHU}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({
        app_id: process.env.FEISHU_APP_ID,
        app_secret: process.env.FEISHU_APP_SECRET
      })
    }
  );

  const data = await response.json();

  if (!response.ok || data.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败：${data.msg || response.status}`);
  }

  tenantToken = data.tenant_access_token;
  tenantTokenExpireAt =
    Date.now() + Number(data.expire || 7200) * 1000;

  return tenantToken;
}

async function feishuRequest(url, options = {}) {
  const token = await getTenantAccessToken();

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = {
      code: response.status,
      msg: text
    };
  }

  if (!response.ok || data.code !== 0) {
    throw new Error(
      `飞书 API ${data.code}: ${data.msg || "unknown"}`
    );
  }

  return data;
}

/* =========================
   收货记录表字段管理
   ========================= */

const RECEIVING_EXTRA_FIELDS = ["供应商ID", "状态", "验收选项", "异常说明", "操作人", "照片信息"];

let receivingFieldsReady = null;

async function ensureReceivingFields() {
  if (receivingFieldsReady) return receivingFieldsReady;

  receivingFieldsReady = (async () => {
    const appToken = process.env.FEISHU_RECEIVING_APP_TOKEN;
    const tableId = process.env.FEISHU_RECEIVING_TABLE_ID;

    const data = await feishuRequest(
      `${FEISHU}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=100`
    );

    const existingNames = new Set(
      (data.data?.items || []).map((item) => item.field_name)
    );

    for (const fieldName of RECEIVING_EXTRA_FIELDS) {
      if (existingNames.has(fieldName)) continue;

      try {
        await feishuRequest(
          `${FEISHU}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ field_name: fieldName, type: 1 })
          }
        );
      } catch (error) {
        console.error(`创建字段 ${fieldName} 失败：`, error);
      }
    }
  })().catch((error) => {
    receivingFieldsReady = null;
    throw error;
  });

  return receivingFieldsReady;
}

/* =========================
   飞书 OAuth 登录
   ========================= */

app.get("/api/auth/login", (_req, res) => {
  try {
    checkEnv();

    const statePayload = {
      nonce: crypto.randomBytes(24).toString("hex"),
      exp: Date.now() + 10 * 60 * 1000
    };

    const state = createSignedCookie(statePayload);

    setCookie(
      res,
      "receiving_oauth_state",
      state,
      { maxAge: 10 * 60 * 1000 }
    );

    const params = new URLSearchParams({
      client_id: process.env.FEISHU_APP_ID,
      response_type: "code",
      redirect_uri: process.env.FEISHU_REDIRECT_URI,
      state
    });

    res.redirect(`${AUTHORIZE_URL}?${params.toString()}`);
  } catch (error) {
    res.status(500).send(
      `登录配置错误：${error instanceof Error ? error.message : String(error)}`
    );
  }
});

app.get("/api/auth/callback", async (req, res) => {
  try {
    checkEnv();

    const code = String(req.query.code || "");
    const returnedState = String(req.query.state || "");

    if (!code || !returnedState) {
      return res.status(400).send("飞书登录回调缺少 code/state。");
    }

    const cookies = parseCookies(req.headers.cookie || "");
    const storedState = cookies["receiving_oauth_state"];

    if (!storedState || storedState !== returnedState) {
      return res.status(403).send("登录状态校验失败，请重新登录。");
    }

    const tokenResponse = await fetch(
      `${FEISHU}/open-apis/authen/v2/oauth/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: process.env.FEISHU_APP_ID,
          client_secret: process.env.FEISHU_APP_SECRET,
          code,
          redirect_uri: process.env.FEISHU_REDIRECT_URI
        })
      }
    );

    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || tokenData.code !== 0) {
      throw new Error(
        `获取用户 access_token 失败：${tokenData.msg || tokenResponse.status}`
      );
    }

    const userAccessToken =
      tokenData.access_token ||
      tokenData.data?.access_token;

    if (!userAccessToken) {
      throw new Error("飞书没有返回 user_access_token。");
    }

    const userResponse = await fetch(
      `${FEISHU}/open-apis/authen/v1/user_info`,
      {
        headers: {
          Authorization: `Bearer ${userAccessToken}`
        }
      }
    );

    const userData = await userResponse.json();

    if (!userResponse.ok || userData.code !== 0) {
      throw new Error(
        `获取飞书用户信息失败：${userData.msg || userResponse.status}`
      );
    }

    const user = userData.data || {};

    const session = {
      open_id: user.open_id || user.user_id || "",
      name: user.name || "飞书用户",
      avatar_url: user.avatar_url || "",
      exp: Date.now() + 12 * 60 * 60 * 1000
    };

    setCookie(
      res,
      "receiving_auth",
      createSignedCookie(session),
      { maxAge: 12 * 60 * 60 * 1000 }
    );

    clearCookie(res, "receiving_oauth_state");

    res.redirect(process.env.FRONTEND_URL || "/");
  } catch (error) {
    console.error(error);
    res.status(500).send(
      `飞书登录失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
});

app.get("/api/auth/me", (req, res) => {
  const user = getCurrentUser(req);

  if (!user) {
    return res.status(401).json({
      code: "AUTH_REQUIRED"
    });
  }

  res.json({
    authenticated: true,
    user: {
      open_id: user.open_id,
      name: user.name,
      avatar_url: user.avatar_url
    }
  });
});

app.post("/api/auth/logout", (req, res) => {
  clearCookie(res, "receiving_auth");
  res.json({ ok: true });
});

/* =========================
   多维表格
   ========================= */

function unwrap(value) {
  if (value == null) return "";

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(unwrap).filter(Boolean).join(", ");
  }

  if (typeof value === "object") {
    if ("text" in value) return String(value.text);
    if ("name" in value) return String(value.name);
    if ("value" in value) return unwrap(value.value);
  }

  return "";
}

function parseType(value) {
  const text = unwrap(value).trim();

  if (text === "领鲜") return "produce";
  if (text === "北方") return "northern";
  if (text === "Cowrock") return "meat";
  if (text === "冻货") return "frozen";

  return "other";
}

async function listAllRecords(appToken, tableId) {
  const records = [];
  let pageToken = "";

  while (true) {
    const params = new URLSearchParams({
      page_size: "500"
    });

    if (pageToken) {
      params.set("page_token", pageToken);
    }

    const data = await feishuRequest(
      `${FEISHU}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?${params}`
    );

    records.push(...(data.data?.items || []));

    if (!data.data?.has_more) break;

    pageToken = data.data?.page_token || "";
    if (!pageToken) break;
  }

  return records;
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function fetchSupplierPlanRecords() {
  return listAllRecords(
    process.env.FEISHU_SUPPLIER_APP_TOKEN,
    process.env.FEISHU_SUPPLIER_TABLE_ID
  );
}

function computeSuppliersForWeekday(planRecords, weekday) {
  return planRecords
    .map((record) => {
      const fields = record.fields || {};

      return {
        id: record.record_id,
        name: unwrap(fields["供应商"]).trim(),
        day: unwrap(fields["收货星期"]).trim(),
        type: parseType(fields["验收类型"])
      };
    })
    .filter((item) => item.name && item.day === weekday)
    .map(({ id, name, type }) => ({
      id,
      name,
      type,
      temporary: false
    }));
}

async function getSuppliersForDate(dateValue) {
  const date = new Date(`${dateValue}T00:00:00`);
  const weekday = weekdayNames[date.getDay()];

  const planRecords = await fetchSupplierPlanRecords();
  const suppliers = computeSuppliersForWeekday(planRecords, weekday);

  return { weekday, suppliers };
}

app.get("/api/suppliers", requireLogin, async (req, res) => {
  try {
    const dateValue = String(req.query.date || "");

    if (!isValidDate(dateValue)) {
      return res.status(400).json({
        message: "日期格式错误，应为 YYYY-MM-DD。"
      });
    }

    const { weekday, suppliers } = await getSuppliersForDate(dateValue);

    res.json({
      date: dateValue,
      weekday,
      suppliers,
      operator: req.user.name
    });
  } catch (error) {
    res.status(500).json({
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/* =========================
   已提交收货记录（用于回显 + 看板）
   ========================= */

function normalizeReceivingRecord(record) {
  const fields = record.fields || {};

  let selections = {};
  try {
    selections = JSON.parse(unwrap(fields["验收选项"]) || "{}");
  } catch {
    selections = {};
  }

  let photoMeta = [];
  try {
    photoMeta = JSON.parse(unwrap(fields["照片信息"]) || "[]");
  } catch {
    photoMeta = [];
  }

  const attachments = Array.isArray(fields["验收照片"]) ? fields["验收照片"] : [];

  const photos = attachments.map((attachment, index) => ({
    kind: photoMeta[index]?.kind || "other",
    file_token: attachment.file_token,
    file_name: attachment.name || photoMeta[index]?.file_name || ""
  }));

  const statusRaw = unwrap(fields["状态"]).trim();

  return {
    record_id: record.record_id,
    supplier_id: unwrap(fields["供应商ID"]).trim(),
    supplier_name: unwrap(fields["供应商"]).trim(),
    supplier_type: labelToType[unwrap(fields["验收类型"]).trim()] || "other",
    date: unwrap(fields["收货日期"]).trim(),
    status: statusRaw === "no_goods" ? "no_goods" : "completed",
    selections,
    exceptionNote: unwrap(fields["异常说明"]).trim(),
    operator: unwrap(fields["操作人"]).trim(),
    photos
  };
}

async function getReceivingRecordsForDate(dateValue) {
  const records = await listAllRecords(
    process.env.FEISHU_RECEIVING_APP_TOKEN,
    process.env.FEISHU_RECEIVING_TABLE_ID
  );

  return records
    .map(normalizeReceivingRecord)
    .filter((item) => item.date === dateValue);
}

app.get("/api/receiving", requireLogin, async (req, res) => {
  try {
    const dateValue = String(req.query.date || "");

    if (!isValidDate(dateValue)) {
      return res.status(400).json({
        message: "日期格式错误，应为 YYYY-MM-DD。"
      });
    }

    const records = await getReceivingRecordsForDate(dateValue);

    res.json({ date: dateValue, records });
  } catch (error) {
    res.status(500).json({
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/photo/:file_token", requireLogin, async (req, res) => {
  try {
    const token = await getTenantAccessToken();

    const response = await fetch(
      `${FEISHU}/open-apis/drive/v1/medias/${req.params.file_token}/download`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    if (!response.ok || !response.body) {
      return res.status(response.status).send("照片读取失败。");
    }

    res.setHeader(
      "Content-Type",
      response.headers.get("content-type") || "application/octet-stream"
    );
    res.setHeader("Cache-Control", "private, max-age=3600");

    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (error) {
    res.status(500).send(
      `照片读取失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
});

function addDays(dateValue, delta) {
  const date = new Date(`${dateValue}T00:00:00`);
  date.setDate(date.getDate() + delta);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const OVERVIEW_MAX_DAYS = 60;

app.get("/api/overview", requireLogin, async (req, res) => {
  try {
    const today = new Date();
    const todayValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    const toValue = isValidDate(String(req.query.to || "")) ? String(req.query.to) : todayValue;
    const fromValue = isValidDate(String(req.query.from || ""))
      ? String(req.query.from)
      : addDays(toValue, -6);

    if (fromValue > toValue) {
      return res.status(400).json({ message: "起始日期不能晚于结束日期。" });
    }

    const dateValues = [];
    for (let cursor = fromValue; cursor <= toValue; cursor = addDays(cursor, 1)) {
      dateValues.push(cursor);
      if (dateValues.length > OVERVIEW_MAX_DAYS) {
        return res.status(400).json({
          message: `日期范围太长，最多支持 ${OVERVIEW_MAX_DAYS} 天，请缩小范围。`
        });
      }
    }

    // 供应商计划和收货记录各只拉一次，按天在内存里匹配，避免每天都重新请求飞书。
    const [planRecords, allReceiving] = await Promise.all([
      fetchSupplierPlanRecords(),
      listAllRecords(process.env.FEISHU_RECEIVING_APP_TOKEN, process.env.FEISHU_RECEIVING_TABLE_ID)
    ]);
    const normalized = allReceiving.map(normalizeReceivingRecord);

    const result = dateValues.map((dateValue) => {
      const date = new Date(`${dateValue}T00:00:00`);
      const weekday = weekdayNames[date.getDay()];
      const suppliers = computeSuppliersForWeekday(planRecords, weekday);
      const dayRecords = normalized.filter((item) => item.date === dateValue);

      const submittedIds = new Set(dayRecords.map((item) => item.supplier_id).filter(Boolean));
      const submittedNames = new Set(dayRecords.map((item) => item.supplier_name));

      const missing = suppliers.filter(
        (supplier) => !submittedIds.has(supplier.id) && !submittedNames.has(supplier.name)
      );

      const extraTemporary = dayRecords.filter(
        (item) =>
          !suppliers.some((supplier) => supplier.id === item.supplier_id) &&
          !suppliers.some((supplier) => supplier.name === item.supplier_name)
      );

      return {
        date: dateValue,
        weekday,
        expected: suppliers.length,
        submitted: suppliers.length - missing.length,
        missing: missing.map((item) => ({ name: item.name, type: item.type })),
        temporaryCount: extraTemporary.length
      };
    });

    res.json({ days: result });
  } catch (error) {
    res.status(500).json({
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

/* =========================
   OCR 送货单识别
   ========================= */

app.post(
  "/api/ocr/delivery-note",
  requireLogin,
  upload.single("image"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ message: "没有收到图片。" });
      }

      const token = await getTenantAccessToken();
      const base64 = req.file.buffer.toString("base64");

      const response = await fetch(
        `${FEISHU}/open-apis/optical_char_recognition/v1/image/basic_recognize`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8"
          },
          body: JSON.stringify({ image: base64 })
        }
      );

      const data = await response.json();

      if (!response.ok || data.code !== 0) {
        throw new Error(`飞书 OCR ${data.code}: ${data.msg || "unknown"}`);
      }

      const textList = data.data?.text_list || [];
      const text = textList.join("\n");
      const suggestions = guessSelectionsFromText(text);

      res.json({ text, suggestions });
    } catch (error) {
      res.status(500).json({
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
);

/* =========================
   照片上传
   ========================= */

function sanitizeName(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

function getPhotoLabel(kind) {
  return photoLabels[kind] || kind || "其他";
}

async function uploadPhotoToBitable(file, kind, meta) {
  const token = await getTenantAccessToken();

  const label = getPhotoLabel(kind);
  const operator = sanitizeName(meta.operator || "收货人");
  const supplier = sanitizeName(meta.supplier || "供应商");
  const date = sanitizeName(meta.date || "日期");
  const sequence = String(meta.sequence || "01").padStart(2, "0");

  const fileName = sanitizeName(
    `${date}_${supplier}_${label}_${operator}_${sequence}_${file.originalname}`
  );

  const body = new FormData();

  body.append("file_name", fileName);
  body.append("parent_type", "bitable_file");
  body.append("parent_node", process.env.FEISHU_RECEIVING_APP_TOKEN);
  body.append("size", String(file.size));

  body.append(
    "file",
    new Blob(
      [file.buffer],
      { type: file.mimetype || "application/octet-stream" }
    ),
    fileName
  );

  const response = await fetch(
    `${FEISHU}/open-apis/drive/v1/medias/upload_all`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body
    }
  );

  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = {
      code: response.status,
      msg: text
    };
  }

  if (!response.ok || data.code !== 0) {
    throw new Error(
      `上传照片失败 ${data.code}: ${data.msg || "unknown"}`
    );
  }

  const fileToken =
    data.data?.file_token ||
    data.data?.media_token;

  if (!fileToken) {
    throw new Error("飞书上传成功，但没有返回 file_token。");
  }

  return {
    file_token: fileToken,
    file_name: fileName,
    kind
  };
}

/* =========================
   提交收货记录
   ========================= */

app.post(
  "/api/receiving",
  requireLogin,
  upload.array("photos", 100),
  async (req, res) => {
    try {
      checkEnv();
      await ensureReceivingFields();

      const meta = JSON.parse(String(req.body.meta || "{}"));
      const files = Array.isArray(req.files) ? req.files : [];

      const photoMetaRaw = Array.isArray(req.body.photoMeta)
        ? req.body.photoMeta
        : req.body.photoMeta
          ? [req.body.photoMeta]
          : [];

      const uploaded = [];

      for (let i = 0; i < files.length; i++) {
        const currentMeta = photoMetaRaw[i]
          ? JSON.parse(photoMetaRaw[i])
          : { kind: "other" };

        const uploadedPhoto = await uploadPhotoToBitable(
          files[i],
          currentMeta.kind,
          {
            date: meta.date,
            supplier: meta.supplier,
            operator: req.user.name,
            sequence: i + 1
          }
        );

        uploaded.push(uploadedPhoto);
      }

      const status = meta.status === "no_goods" ? "no_goods" : "completed";

      const fields = {
        "供应商": meta.supplier || "",
        "收货日期": meta.date || "",
        "验收类型": typeLabels[meta.supplierType] || meta.supplierType || "",
        "供应商ID": meta.supplierId || "",
        "状态": status,
        "验收选项": JSON.stringify(meta.selections || {}),
        "异常说明": meta.exceptionNote || "",
        "操作人": req.user.name || ""
      };

      if (uploaded.length > 0) {
        fields["验收照片"] = uploaded.map((item) => ({
          file_token: item.file_token
        }));
        fields["照片信息"] = JSON.stringify(
          uploaded.map((item) => ({ kind: item.kind, file_name: item.file_name }))
        );
      }

      const responseData = await feishuRequest(
        `${FEISHU}/open-apis/bitable/v1/apps/${process.env.FEISHU_RECEIVING_APP_TOKEN}/tables/${process.env.FEISHU_RECEIVING_TABLE_ID}/records`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json; charset=utf-8"
          },
          body: JSON.stringify({
            fields
          })
        }
      );

      res.json({
        ok: true,
        status,
        record_id: responseData.data?.record?.record_id || null,
        photo_count: uploaded.length,
        operator: req.user.name
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
);

const distPath = path.join(process.cwd(), "dist");

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.use((req, res, next) => {
    if (
      req.method === "GET" &&
      !req.path.startsWith("/api/")
    ) {
      return res.sendFile(path.join(distPath, "index.html"));
    }

    next();
  });
}

app.listen(port, () => {
  console.log(`收货系统后端：http://localhost:${port}`);

  ensureReceivingFields().catch((error) => {
    console.error("初始化收货记录表字段失败（不影响其他功能）：", error);
  });
});
