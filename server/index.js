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

const photoLabels = {
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
  fresh_weight: "鲜切肉_称重",
  fresh_temperature: "鲜切肉_测温",
  frozen_meat_weight: "冻肉_称重",
  frozen_meat_temperature: "冻肉_测温",
  produce_status: "领鲜_货物状态",
  produce_weight: "领鲜_称重",
  fruit_sweetness: "领鲜_甜度测试",
  potato_inspection: "领鲜_土豆验收"
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

    res.redirect("/");
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

app.get("/api/suppliers", requireLogin, async (req, res) => {
  try {
    const dateValue = String(req.query.date || "");

    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
      return res.status(400).json({
        message: "日期格式错误，应为 YYYY-MM-DD。"
      });
    }

    const date = new Date(`${dateValue}T00:00:00`);
    const weekday = weekdayNames[date.getDay()];

    const records = await listAllRecords(
      process.env.FEISHU_SUPPLIER_APP_TOKEN,
      process.env.FEISHU_SUPPLIER_TABLE_ID
    );

    const suppliers = records
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

      const fields = {
        "供应商": meta.supplier || "",
        "收货日期": meta.date || "",
        "验收类型": typeLabels[meta.supplierType] || meta.supplierType || ""
      };

      if (uploaded.length > 0) {
        fields["验收照片"] = uploaded.map((item) => ({
          file_token: item.file_token
        }));
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
        status: meta.status === "no_goods" ? "no_goods" : "completed",
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
});
