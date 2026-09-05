import "dotenv/config";
import express from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";

const app = express();
const port = Number(process.env.PORT || 3001);
const FEISHU = "https://open.feishu.cn";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 100,
    fileSize: 15 * 1024 * 1024,
    fieldSize: 1024 * 1024
  }
});

const requiredEnv = [
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_SUPPLIER_APP_TOKEN",
  "FEISHU_SUPPLIER_TABLE_ID",
  "FEISHU_RECEIVING_APP_TOKEN",
  "FEISHU_RECEIVING_TABLE_ID"
];

const weekdayNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const typeLabels = {
  produce: "领鲜",
  frozen: "冻货",
  meat: "Cowrock",
  northern: "北方",
  other: "普通"
};

function checkEnv() {
  const missing = requiredEnv.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`缺少环境变量：${missing.join(", ")}`);
  }
}

let cachedToken = "";
let cachedTokenExpireAt = 0;

async function getTenantAccessToken() {
  checkEnv();

  if (cachedToken && Date.now() < cachedTokenExpireAt - 60_000) {
    return cachedToken;
  }

  const response = await fetch(
    `${FEISHU}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
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

  cachedToken = data.tenant_access_token;
  cachedTokenExpireAt = Date.now() + Number(data.expire || 7200) * 1000;

  return cachedToken;
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
    let hint = "";
    if (data.code === 1254043 || data.code === 1254005) {
      hint = "；请确认这个 Base 已给“库房收货验收系统”应用授权/可访问";
    }
    throw new Error(`飞书 API ${data.code}: ${data.msg || "unknown"}${hint}`);
  }

  return data;
}

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

function sanitizeFileName(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .slice(0, 140);
}

function friendlyPhotoName(kind, originalName) {
  const labels = {
    truck_temperature: "北方_车厢测温",
    northern_beef_weight: "北方_牛肉_称重",
    northern_beef_temperature: "北方_牛肉_测温",
    northern_lamb_weight: "北方_羊肉_称重",
    northern_lamb_temperature: "北方_羊肉_测温",
    northern_pork_weight: "北方_猪肉_称重",
    northern_pork_temperature: "北方_猪肉_测温",
    northern_fresh_weight: "北方_鲜切肉_称重",
    northern_fresh_temperature: "北方_鲜切肉_测温",
    frozen_temperature: "冻货_测温",
    frozen_quality: "冻货_产品状态",
    fresh_weight: "鲜切肉_称重",
    fresh_temperature: "鲜切肉_测温",
    frozen_meat_weight: "冻肉_称重",
    frozen_meat_temperature: "冻肉_测温",
    vegetable_arrival: "领鲜_蔬菜到货",
    weighted_products: "领鲜_按重量产品称重",
    fruit_sweetness: "领鲜_水果甜度",
    potato_inspection: "领鲜_土豆拆袋验货"
  };

  const prefix = labels[kind] || `收货_${kind}`;
  return sanitizeFileName(`${prefix}_${originalName}`);
}

async function listAllRecords(appToken, tableId) {
  const records = [];
  let pageToken = "";

  while (true) {
    const params = new URLSearchParams({ page_size: "500" });
    if (pageToken) params.set("page_token", pageToken);

    const data = await feishuRequest(
      `${FEISHU}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?${params.toString()}`
    );

    records.push(...(data.data?.items || []));

    if (!data.data?.has_more) break;

    pageToken = data.data?.page_token || "";
    if (!pageToken) break;
  }

  return records;
}

app.get("/api/health", async (_req, res) => {
  try {
    checkEnv();

    await getTenantAccessToken();
    await listAllRecords(
      process.env.FEISHU_SUPPLIER_APP_TOKEN,
      process.env.FEISHU_SUPPLIER_TABLE_ID
    );
    await listAllRecords(
      process.env.FEISHU_RECEIVING_APP_TOKEN,
      process.env.FEISHU_RECEIVING_TABLE_ID
    );

    res.json({
      ok: true,
      supplierBase: true,
      receivingBase: true
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

app.get("/api/suppliers", async (req, res) => {
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
      suppliers
    });
  } catch (error) {
    res.status(500).json({
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

async function uploadPhotoToBitable(file, kind) {
  const token = await getTenantAccessToken();

  const isImage = /^image\//i.test(file.mimetype || "");
  const parentType = isImage ? "bitable_image" : "bitable_file";
  const body = new FormData();

  body.append("file_name", friendlyPhotoName(kind, file.originalname));
  body.append("parent_type", parentType);
  body.append("parent_node", process.env.FEISHU_RECEIVING_APP_TOKEN);
  body.append("size", String(file.size));
  body.append(
    "file",
    new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" }),
    friendlyPhotoName(kind, file.originalname)
  );

  const response = await fetch(`${FEISHU}/open-apis/drive/v1/medias/upload_all`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    },
    body
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
    throw new Error(`上传照片失败 ${data.code}: ${data.msg || "unknown"}`);
  }

  const fileToken = data.data?.file_token || data.data?.media_token;
  if (!fileToken) {
    throw new Error("上传照片成功响应中没有 file_token。");
  }

  return fileToken;
}

app.post("/api/receiving", upload.array("photos", 100), async (req, res) => {
  try {
    checkEnv();

    const meta = JSON.parse(String(req.body.meta || "{}"));
    const files = Array.isArray(req.files) ? req.files : [];

    const photoMetaRaw = Array.isArray(req.body.photoMeta)
      ? req.body.photoMeta
      : req.body.photoMeta
        ? [req.body.photoMeta]
        : [];

    const uploadedTokens = [];

    for (let i = 0; i < files.length; i++) {
      const currentMeta = photoMetaRaw[i]
        ? JSON.parse(photoMetaRaw[i])
        : { kind: "other", name: files[i].originalname };

      const token = await uploadPhotoToBitable(
        files[i],
        currentMeta.kind || "other"
      );

      uploadedTokens.push({
        file_token: token
      });
    }

    const fields = {
      "供应商": meta.supplier || "",
      "收货日期": meta.date || "",
      "验收类型": typeLabels[meta.supplierType] || meta.supplierType || ""
    };

    if (uploadedTokens.length > 0) {
      fields["验收照片"] = uploadedTokens;
    }

    const data = await feishuRequest(
      `${FEISHU}/open-apis/bitable/v1/apps/${process.env.FEISHU_RECEIVING_APP_TOKEN}/tables/${process.env.FEISHU_RECEIVING_TABLE_ID}/records`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({ fields })
      }
    );

    res.json({
      ok: true,
      status: meta.status === "no_goods" ? "no_goods" : "completed",
      record_id: data.data?.record?.record_id || null,
      photo_count: uploadedTokens.length
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

const distPath = path.join(process.cwd(), "dist");

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.use((req, res, next) => {
    if (req.method === "GET" && !req.path.startsWith("/api/")) {
      return res.sendFile(path.join(distPath, "index.html"));
    }
    next();
  });
}

app.listen(port, () => {
  console.log(`收货系统后端：http://localhost:${port}`);
});
