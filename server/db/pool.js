import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("缺少环境变量：DATABASE_URL");
}

// date 类型默认会被 pg 转成本地时区的 JS Date，容易在日期边界上出错（差一天）。
// 这里让它保持原始的 'YYYY-MM-DD' 字符串，跟 Feishu API/前端约定的格式一致。
pg.types.setTypeParser(1082, (value) => value);

// Render 的外部连接一般需要 SSL，本地 docker 容器不需要；用连接串里有没有 render.com 简单区分。
const useSsl = /render\.com/.test(process.env.DATABASE_URL);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  // node-postgres默认connectionTimeoutMillis=0，意味着如果Postgres真的不可达
  // (网络分区、数据库重启中)，pool.connect()会无限期挂起——请求既不报错也不
  // 超时，用户看到的是转圈圈转到浏览器自己的fetch超时，拿不到任何有意义的
  // 错误信息。加10秒超时后会走到路由自己的try/catch，返回明确的500 JSON。
  // 只加这一项，没有加statement_timeout：会不会误伤某个还没被观察到的、
  // 真实需要较长执行时间的查询没有把握，这次不做这个判断。
  connectionTimeoutMillis: 10_000
});

// node-postgres 官方文档明确要求：池里空闲的连接偶尔会在后台异步抛出错误
// (网络中断、Render Postgres 重启等)，这些错误不属于任何一次请求的 promise 链，
// 不会被路由自己的 try/catch 或 Express 5 的自动 promise 捕获接住。如果不监听
// pool 的 'error' 事件，Node 会把它当成未捕获异常，直接终止整个进程——
// 影响的不只是这批 Postgres 路由，收货/登录/OCR 这些完全不用 pool 的功能也会
// 被一起拖垮，因为它们跑在同一个进程里。2026-09-19发现的express.json()漏挂
// 是同一类"从上线第一天就存在、从未被任何一次正常测试触发过"的系统性缺口。
pool.on("error", (error) => {
  console.error("Postgres 连接池后台错误(不影响当前请求，已被捕获，不会导致进程崩溃)：", error);
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
