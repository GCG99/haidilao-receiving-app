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
  ssl: useSsl ? { rejectUnauthorized: false } : undefined
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
