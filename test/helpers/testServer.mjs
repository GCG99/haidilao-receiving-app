// 测试用：把 server/index.js 导出的 app 挂到临时http server(端口0=系统随机分配)上，
// 不走 `node server/index.js` 子进程，同一进程内直接测，启动快、能复用同一个DATABASE_URL。
import http from "node:http";
import crypto from "node:crypto";

export async function startTestServer() {
  const { app } = await import("../../server/index.js");
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

// 复刻 server/index.js 里 createSignedCookie() 的算法(HMAC-SHA256, base64url)，
// 给测试请求签一个有效的 receiving_auth cookie，绕开真实飞书OAuth——测试专用，
// 不改动、不导出任何生产代码路径，跟生产的登录入口完全独立。
export function makeAuthCookie({ open_id = "test-open-id", name = "测试用户" } = {}) {
  const payload = { open_id, name, avatar_url: "", exp: Date.now() + 60 * 60 * 1000 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", process.env.SESSION_SECRET)
    .update(body)
    .digest("base64url");
  return `receiving_auth=${encodeURIComponent(`${body}.${signature}`)}`;
}
