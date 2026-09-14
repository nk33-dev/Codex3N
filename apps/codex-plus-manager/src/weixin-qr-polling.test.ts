import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { startWeixinQrPolling } from "./weixin-qr-polling.ts";

type Result = { status: string; qrStatus: string };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("慢请求不重叠，等待和已扫码状态继续按完成时间轮询", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred<Result>();
  let calls = 0;
  const applied: string[] = [];
  const stop = startWeixinQrPolling({
    read: () => ++calls === 1 ? first.promise : Promise.resolve({ status: "ok", qrStatus: "scaned" }),
    onResult: (result) => applied.push(result.qrStatus),
    onConfirmed: async () => assert.fail("等待时不应确认"),
    onError: (error) => assert.fail(String(error)),
  });
  t.after(stop);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 1);
  first.resolve({ status: "ok", qrStatus: "wait" });
  await setImmediate();
  t.mock.timers.tick(999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await setImmediate();
  assert.deepEqual(applied, ["wait", "scaned"]);
  stop();
  t.mock.timers.tick(10_000);
  assert.equal(calls, 2);
});

for (const rejects of [false, true]) {
  test(`销毁后旧请求${rejects ? "失败" : "成功"}均不再提交或提示`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = deferred<Result>();
    let calls = 0;
    const stop = startWeixinQrPolling({
      read: () => { calls++; return pending.promise; },
      onResult: () => assert.fail("旧结果被提交"),
      onConfirmed: async () => assert.fail("旧确认被执行"),
      onError: () => assert.fail("旧错误被提示"),
    });
    stop();
    if (rejects) pending.reject(new Error("断开"));
    else pending.resolve({ status: "ok", qrStatus: "confirmed" });
    await setImmediate();
    t.mock.timers.tick(10_000);
    assert.equal(calls, 1);
  });
}

for (const result of [
  { status: "ok", qrStatus: "confirmed" },
  { status: "ok", qrStatus: "expired" },
  { status: "failed", qrStatus: "wait" },
  { status: "ok", qrStatus: "unknown" },
]) {
  test(`终态 ${result.status}/${result.qrStatus} 只处理一次且停止轮询`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const order: string[] = [];
    let calls = 0;
    const stop = startWeixinQrPolling({
      read: async () => { calls++; return result; },
      onConfirmed: async (isCurrent) => {
        await setImmediate();
        assert.equal(isCurrent(), true);
        order.push("settings", "status");
      },
      onResult: () => order.push("result"),
      onError: (error) => assert.fail(String(error)),
    });
    t.after(stop);
    await setImmediate();
    await setImmediate();
    assert.deepEqual(order, result.qrStatus === "confirmed" ? ["settings", "status", "result"] : ["result"]);
    t.mock.timers.tick(10_000);
    assert.equal(calls, 1);
  });
}

test("请求抛错只提示一次，不自动重试；重新发起登录可以恢复", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const errors: unknown[] = [];
  const stop = startWeixinQrPolling({
    read: async () => { calls++; throw new Error("offline"); },
    onConfirmed: async () => {}, onResult: () => assert.fail("失败不提交"),
    onError: (error) => errors.push(error),
  });
  t.after(stop);
  await setImmediate();
  t.mock.timers.tick(20_000);
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  const received: string[] = [];
  const stopNew = startWeixinQrPolling({
    read: async () => ({ status: "ok", qrStatus: "confirmed" }),
    onConfirmed: async () => {}, onResult: (result) => received.push(result.qrStatus),
    onError: (error) => assert.fail(String(error)),
  });
  t.after(stopNew);
  await setImmediate();
  assert.deepEqual(received, ["confirmed"]);
});

test("确认补读期间重新登录，旧补读及通知失效而新结果正常提交", async () => {
  const pending = deferred<void>();
  const applied: string[] = [];
  const stop = startWeixinQrPolling({
    read: async () => ({ status: "ok", qrStatus: "confirmed" }),
    onConfirmed: async (isCurrent) => {
      await pending.promise;
      if (isCurrent()) applied.push("old-settings");
    },
    onResult: () => applied.push("old-result"),
    onError: (error) => assert.fail(String(error)),
  });
  await setImmediate();
  stop();
  const stopNew = startWeixinQrPolling({
    read: async () => ({ status: "ok", qrStatus: "confirmed" }),
    onConfirmed: async () => { applied.push("new-settings"); },
    onResult: () => applied.push("new-result"),
    onError: (error) => assert.fail(String(error)),
  });
  pending.resolve();
  await setImmediate();
  stopNew();
  assert.deepEqual(applied, ["new-settings", "new-result"]);
});

function appEffect() {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect"
      && node.arguments[0]?.getText(tree).includes("return startWeixinQrPolling(")) {
      callback = node.arguments[0];
      const dependencies = node.arguments[1];
      assert.ok(dependencies && ts.isArrayLiteralExpression(dependencies));
      assert.deepEqual(dependencies.elements.map(item => item.getText(tree)), ["weixinQrPending", "weixinQr?.qrContent"]);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(callback);
  return ts.transpileModule(`const effect = ${callback.getText(tree)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

for (const cancel of [false, true]) {
  test(`App 确认补读期间${cancel ? "销毁后不更新状态或弹提示" : "用户编辑草稿不会被覆盖"}`, async () => {
    const settings = deferred<void>();
    const applied: string[] = [];
    const form = { current: {} };
    const create = new Function("weixinQrPending", "startWeixinQrPolling", "call", "settingsFormRef", "refreshSettings", "refreshWeixinStatus", "setWeixinQr", "showNotice", "showResultNotice", "isSuccessStatus", "t", "stringifyError", appEffect() + "return effect();");
    const stop = create(
      true, startWeixinQrPolling, async () => ({ status: "ok", qrStatus: "confirmed" }), form,
      async (_silent: boolean, shouldApply: () => boolean) => {
        await settings.promise;
        if (shouldApply()) applied.push("settings");
      },
      async (_silent: boolean, isCurrent: () => boolean) => { if (isCurrent()) applied.push("status"); },
      () => applied.push("qr"), () => applied.push("notice"), () => applied.push("error"),
      (status: string) => status === "ok", (s: string) => s, String,
    );
    await setImmediate();
    if (cancel) stop();
    else form.current = {};
    settings.resolve();
    await setImmediate();
    stop();
    assert.deepEqual(applied, cancel ? [] : ["status", "qr", "notice"]);
  });
}
