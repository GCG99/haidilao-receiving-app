// 测试用DB访问——直接用 server/db/pool.js 的同一个pool(同一个本地haidilao-pg容器)，
// 不引入mock。隔离策略：显式按id清理(不是外层事务+rollback)，原因见下面 cleanupAll()
// 的注释——跟ChatGPT讨论过transaction-per-test方案后确认的取舍。
import { pool } from "../../server/db/pool.js";

export { pool };

// 每个测试用例把自己创建的行登记进这里，收尾统一按(表名,id)精确删除。
// 之所以不用"外层BEGIN...ROLLBACK包住整个测试"的方案：这个代码库的withTransaction()
// 是每次调用自己从pool里单独checkout一个connection做BEGIN/COMMIT，如果测试也想在
// 外层开一个"只rollback不commit"的事务，被测的路由处理器用的是另一个connection，
// 两边事务互不相干，外层rollback根本卷不到路由已经真实commit掉的数据——所以显式清理
// 是这里唯一可靠的隔离方式，不是偷懒。
// 按FK依赖关系人工排的删除优先级，数字小的先删——不能简单靠"插入顺序倒序"，
// 因为测试里track()的调用顺序不一定跟FK依赖方向一致(试过反过来删会撞
// invoices_source_file_id_fkey，真实踩过这个坑)。新增表如果测试要用到，
// 顺手加一行，缺省(不在表里的)按最后删处理，比较安全。
const TABLE_DELETE_PRIORITY = {
  invoice_items: 0,
  credit_items: 0,
  supplier_statement_items: 0,
  audit_logs: 0,
  invoices: 1,
  credits: 1,
  supplier_statements: 1,
  supplier_material_mapping: 1,
  source_files: 2
};

export function createCleanupTracker() {
  const created = []; // { table, column, value }
  return {
    track(table, column, value) {
      created.push({ table, column, value });
    },
    async cleanupAll() {
      const ordered = [...created].sort(
        (a, b) => (TABLE_DELETE_PRIORITY[a.table] ?? 1) - (TABLE_DELETE_PRIORITY[b.table] ?? 1)
      );
      for (const { table, column, value } of ordered) {
        await pool.query(`DELETE FROM ${table} WHERE ${column} = $1`, [value]);
      }
      created.length = 0;
    }
  };
}

// 生成一个不会跟真实业务数据撞车的测试专用supplier_id/字符串前缀，方便肉眼分辨
// 和万一遗留时批量清理。
export function testTag(prefix = "TEST") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
