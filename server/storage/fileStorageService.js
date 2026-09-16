import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pool } from "../db/pool.js";
import { uploadFileToFeishuDrive, downloadFileFromFeishuDrive } from "../integrations/feishu/driveClient.js";

// 生产环境必须用 feishu（Render 磁盘非持久化，重启/重新部署会丢文件——原始单据不能存在那上面）。
// local 只给本地开发/测试用，默认值特意保守。
const PROVIDER = process.env.FILE_STORAGE_PROVIDER || "local";
const LOCAL_DIR = path.join(process.cwd(), "server", "storage", "local-uploads");

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function saveLocal(buffer, fileName) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  const safeName = `${Date.now()}_${fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")}`;
  const fullPath = path.join(LOCAL_DIR, safeName);
  fs.writeFileSync(fullPath, buffer);
  return { storagePath: fullPath };
}

// 存一个文件，返回 source_files 的行。同一个 sha256 已经存过，直接复用旧记录，
// 不重新上传、不产生新行。
// 第10轮ChatGPT复核结论：先查后插不在事务里，并发上传同一份文件会产生重复行，
// 所以复用检测不能只靠这次查询——sha256 上有数据库唯一约束(uq_source_files_sha256)兜底，
// 真撞上并发时 INSERT 会因为 ON CONFLICT 走复用分支，而不是报错或插入重复行。
export async function storeFile(buffer, { fileName, mimeType, uploadedBy = null }) {
  const hash = sha256(buffer);

  const existing = await pool.query(
    "SELECT * FROM source_files WHERE sha256 = $1 ORDER BY id LIMIT 1",
    [hash]
  );
  if (existing.rows.length > 0) {
    return { file: existing.rows[0], reused: true };
  }

  let storageResult;
  if (PROVIDER === "feishu") {
    storageResult = await uploadFileToFeishuDrive(buffer, fileName, mimeType);
  } else {
    storageResult = await saveLocal(buffer, fileName);
  }

  const { rows } = await pool.query(
    `INSERT INTO source_files (file_name, mime_type, storage_provider, storage_path, uploaded_by, sha256)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (sha256) DO NOTHING
     RETURNING *`,
    [fileName, mimeType || null, PROVIDER, storageResult.storagePath, uploadedBy, hash]
  );

  if (rows.length > 0) {
    return { file: rows[0], reused: false };
  }

  // 撞上了并发窗口：另一个请求抢先插入了同一个 sha256。这次上传的文件字节
  // 已经白白传去了 feishu/本地磁盘（没有办法，读文件内容前不知道 hash 会撞），
  // 但数据库层面正确地只保留一行——重新查一次，把已存在的记录返回给这次调用方。
  const { rows: winner } = await pool.query(
    "SELECT * FROM source_files WHERE sha256 = $1",
    [hash]
  );
  return { file: winner[0], reused: true };
}

export async function getFileById(id) {
  const { rows } = await pool.query("SELECT * FROM source_files WHERE id = $1", [id]);
  return rows[0] || null;
}

// OCR解析需要读回文件原始字节。跟 storeFile() 一样按 storage_provider 分支，
// 路由层不需要关心底层是本地磁盘还是飞书Drive。
export async function getFileBuffer(sourceFile) {
  if (sourceFile.storage_provider === "feishu") {
    return downloadFileFromFeishuDrive(sourceFile.storage_path);
  }
  return fs.readFileSync(sourceFile.storage_path);
}
