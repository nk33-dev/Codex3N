import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createVisibleRefresh } from "./manager-lifecycle.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("隐藏时没有轮询，显示后补刷且按请求完成时间安排兜底", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const refresh = createVisibleRefresh({ refresh: async () => { calls++; }, intervalMs: 30_000, onError: (error) => assert.fail(String(error)) });
  t.after(() => refresh.dispose());
  refresh.request();
  t.mock.timers.tick(90_000);
  assert.equal(calls, 0);
  refresh.setVisible(true);
  await setImmediate();
  assert.equal(calls, 1);
  t.mock.timers.tick(29_999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(calls, 2);
  refresh.setVisible(false);
  t.mock.timers.tick(90_000);
  assert.equal(calls, 2);
  refresh.setVisible(true);
  await setImmediate();
  assert.equal(calls, 3);
});

test("慢请求期间的事件合并为一次后续刷新，不发起重叠请求", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred();
  let calls = 0;
  const refresh = createVisibleRefresh({
    refresh: async () => { if (++calls === 1) await first.promise; },
    intervalMs: 2_000, onError: (error) => assert.fail(String(error)),
  });
  t.after(() => refresh.dispose());
  refresh.setVisible(true);
  for (let index = 0; index < 20; index++) refresh.request();
  t.mock.timers.tick(20_000);
  assert.equal(calls, 1);
  first.resolve();
  await setImmediate();
  assert.equal(calls, 2);
  t.mock.timers.tick(2_000);
  await setImmediate();
  assert.equal(calls, 3);
});

test("隐藏再恢复时旧响应失效，完成后补刷新状态", async (t) => {
  const first = deferred();
  const applied: number[] = [];
  let calls = 0;
  const refresh = createVisibleRefresh({
    refresh: async (isCurrent) => {
      const call = ++calls;
      if (call === 1) await first.promise;
      if (isCurrent()) applied.push(call);
    },
    intervalMs: 30_000, onError: (error) => assert.fail(String(error)),
  });
  t.after(() => refresh.dispose());
  refresh.setVisible(true);
  refresh.setVisible(false);
  refresh.setVisible(true);
  assert.equal(calls, 1);
  first.resolve();
  await setImmediate();
  assert.deepEqual(applied, [2]);
});

test("销毁会取消定时器、排队刷新和未完成响应", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred();
  let calls = 0;
  let applied = false;
  const refresh = createVisibleRefresh({
    refresh: async (isCurrent) => { calls++; await first.promise; applied = isCurrent(); },
    intervalMs: 2_000, onError: (error) => assert.fail(String(error)),
  });
  refresh.setVisible(true);
  refresh.request();
  refresh.dispose();
  first.resolve();
  await setImmediate();
  refresh.request();
  refresh.setVisible(true);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 1);
  assert.equal(applied, false);
});

test("请求失败后仍能通过低频兜底恢复", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const errors: unknown[] = [];
  let calls = 0;
  const refresh = createVisibleRefresh({
    refresh: async () => { if (++calls === 1) throw new Error("offline"); },
    intervalMs: 30_000, onError: (error) => errors.push(error),
  });
  t.after(() => refresh.dispose());
  refresh.setVisible(true);
  await setImmediate();
  assert.equal(errors.length, 1);
  t.mock.timers.tick(30_000);
  await setImmediate();
  assert.equal(calls, 2);
});
