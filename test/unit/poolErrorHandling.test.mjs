// 2026-09-19发现：pool.js里的pg.Pool从创建以来就没有挂error监听器。node-postgres
// 官方文档明确说明：池里空闲连接在后台异步抛出的错误(网络中断/数据库重启等)如果没有
// 监听者，会被Node当成未捕获异常直接终止整个进程——不只是Postgres相关路由，收货/
// 登录/OCR这些完全不用pool的功能也会被同一个进程崩溃拖垮。这跟express.json()漏挂
// 是同一类"从上线第一天就存在、从未被任何一次正常测试触发过"的系统性缺口，
// 只是触发方式不同(这个是EventEmitter后台事件，不是某次请求的promise链)。
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../../server/db/pool.js";

test("pool 挂了 error 监听器：模拟后台连接错误不会抛出/崩溃进程", () => {
  assert.ok(pool.listenerCount("error") > 0, "pool 必须至少有一个 error 监听器，否则后台错误会变成未捕获异常");

  // EventEmitter对'error'事件的特殊规则：如果完全没有监听器，emit会同步抛出这个错误。
  // 这里直接断言emit不抛，等价于验证了"即使真的发生一次后台连接错误，进程也不会崩溃"。
  assert.doesNotThrow(() => {
    pool.emit("error", new Error("模拟的后台连接错误，仅测试用，不代表真实故障"));
  });
});

// node-postgres默认connectionTimeoutMillis=0(无限等待)。如果Postgres真的不可达，
// 没这个配置的话pool.connect()会挂起到进程重启，请求既不报错也不超时。
test("pool 设置了 connectionTimeoutMillis，不是默认的0(无限等待)", () => {
  assert.equal(pool.options.connectionTimeoutMillis, 10_000);
});
