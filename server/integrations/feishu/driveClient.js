// 独立的飞书 Drive 上传客户端，只给新的 Invoice/Credit/Statement 文件存储用。
// 故意不引用/不修改 server/index.js 里那份已经在生产稳定运行的 getTenantAccessToken/uploadPhotoToBitable——
// 两边各自维护自己的 token 缓存，避免这次新功能的改动牵扯到收货 App 现有的上传路径。
const FEISHU = "https://open.feishu.cn";

let tenantToken = "";
let tenantTokenExpireAt = 0;

async function getTenantAccessToken() {
  if (!process.env.FEISHU_APP_ID || !process.env.FEISHU_APP_SECRET) {
    throw new Error("缺少环境变量：FEISHU_APP_ID / FEISHU_APP_SECRET");
  }

  if (tenantToken && Date.now() < tenantTokenExpireAt - 60_000) {
    return tenantToken;
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

  tenantToken = data.tenant_access_token;
  tenantTokenExpireAt = Date.now() + Number(data.expire || 7200) * 1000;

  return tenantToken;
}

// parentNode：复用收货记录 Base 的 app_token 作为挂载点，和现有照片共用同一个飞书空间，
// 不需要为新功能单独申请新的 Base/Drive 权限。
export async function uploadFileToFeishuDrive(buffer, fileName, mimeType) {
  const parentNode = process.env.FEISHU_RECEIVING_APP_TOKEN;
  if (!parentNode) {
    throw new Error("缺少环境变量：FEISHU_RECEIVING_APP_TOKEN");
  }

  const token = await getTenantAccessToken();

  const body = new FormData();
  body.append("file_name", fileName);
  body.append("parent_type", "bitable_file");
  body.append("parent_node", parentNode);
  body.append("size", String(buffer.length));
  body.append("file", new Blob([buffer], { type: mimeType || "application/octet-stream" }), fileName);

  const response = await fetch(`${FEISHU}/open-apis/drive/v1/medias/upload_all`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { code: response.status, msg: text };
  }

  if (!response.ok || data.code !== 0) {
    throw new Error(`上传到飞书 Drive 失败 ${data.code}: ${data.msg || "unknown"}`);
  }

  const fileToken = data.data?.file_token || data.data?.media_token;
  if (!fileToken) {
    throw new Error("飞书上传成功，但没有返回 file_token。");
  }

  return { storagePath: fileToken };
}
