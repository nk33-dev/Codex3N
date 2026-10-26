import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../../assets/inject/renderer-inject/40-backend-settings.js", import.meta.url), "utf8");
const runtimeSource = source.slice(source.indexOf("  window.__codexPlusBackendCleanup?.();"), source.indexOf("  function userScriptStatusLabel("));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function runtime(sharedWindow: any = {}) {
  let now = 100000, requests = 0, settingsReady = true;
  let status: any = { status: "ok" };
  let fetchResult = async (): Promise<any> => ({ ok: true, json: async () => ({ status: "failed", message: "恢复失败，请重试" }) });
  const label: any = { dataset: {}, textContent: "" };
  const description = { textContent: "" };
  const button: any = {
    disabled: false, attrs: {} as Record<string, string>,
    getAttribute(name: string) { return this.attrs[name]; },
    setAttribute(name: string, value: string) { this.attrs[name] = value; },
  };
  let timerId = 0;
  const timers = new Map<number, () => void>();
  const window = sharedWindow;
  window.__CODEX_PLUS_RECOVERY__ = { baseUrl: "http://127.0.0.1:12345", token: "synthetic-token", instance: "synthetic-instance" };
  const context = vm.createContext({
    window, AbortController, Set, Promise,
    Date: { now: () => now },
    setTimeout: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: () => void) => { timers.set(++timerId, fn); return timerId; },
    clearInterval: (id: number) => timers.delete(id),
    document: {
      querySelector: (selector: string) => selector.includes("description") ? description : selector.includes("status]") ? label : null,
      querySelectorAll: (selector: string) => selector.includes("reconnect") ? [button] : [],
    },
    codexPlusVersion: "", codexPlusSidebarNavId: "sidebar",
    refreshCodexServiceTierControls() {}, syncOfficialUsagePolicy() {}, sendCodexPlusDiagnostic() {},
    syncBackendSettingsFromHeartbeat: async () => settingsReady,
    postJson: async () => status,
    fetch: async (url: string) => {
      if (url.endsWith("/status")) return { ok: true };
      requests++; return fetchResult();
    },
  });
  vm.runInContext(runtimeSource, context);
  return {
    window, label, description, button, timers, context,
    check: (auto = false) => context.checkBackendStatus(auto),
    reconnect: (manual = false) => context.requestBackendRecovery(manual),
    setStatus: (value: any) => { status = value; },
    setSettingsReady: (value: boolean) => { settingsReady = value; },
    setFetch: (fn: typeof fetchResult) => { fetchResult = fn; },
    advance: (ms: number) => { now += ms; },
    requests: () => requests,
  };
}

test("连接成功同时要求桥接和设置读取成功，HTTP fallback 不冒充业务可用", async () => {
  for (const kind of ["settings", "http"]) {
    const app = runtime();
    if (kind === "settings") app.setSettingsReady(false);
    else app.setStatus({ status: "ok", transport: "http-helper" });
    for (let i = 0; i < 3; i++) await app.check();
    assert.equal(app.label.textContent, "连接失败");
    assert.notEqual(app.label.dataset.status, "ok");
    app.setSettingsReady(true);
    app.setStatus({ status: "ok" });
    await app.check();
    assert.equal(app.label.textContent, "已连接");
    assert.equal(app.description.textContent, "");
  }
});

test("手动与自动重连合并，失败原因保留，手动重试绕过退避", async () => {
  const app = runtime();
  const pending = deferred<any>();
  app.setFetch(() => pending.promise);
  const first = app.reconnect();
  const second = app.reconnect(true);
  await Promise.resolve();
  assert.equal(app.requests(), 1);
  assert.equal(app.button.disabled, true);
  assert.equal(app.label.textContent, "正在重连");
  pending.resolve({ ok: true, json: async () => ({ status: "failed", message: "测试失败原因" }) });
  await Promise.all([first, second]);
  assert.equal(app.description.textContent, "测试失败原因");
  assert.equal(app.button.disabled, false);
  await app.reconnect();
  assert.equal(app.requests(), 1);
  app.setFetch(async () => ({ ok: true, json: async () => ({ status: "failed", message: "再次失败" }) }));
  await app.reconnect(true);
  assert.equal(app.requests(), 2);
  app.advance(20001);
  await app.reconnect();
  assert.equal(app.requests(), 3);
});

test("恢复回执仍需重新确认业务连接，主进程不可达时不唤起软件", async () => {
  const app = runtime();
  app.setFetch(async () => ({ ok: true, json: async () => ({ status: "ok" }) }));
  await app.reconnect(true);
  assert.equal(app.label.textContent, "已连接");
  app.setStatus({ status: "failed" });
  app.setFetch(async () => { throw new Error("ECONNREFUSED"); });
  await app.reconnect(true);
  assert.equal(app.description.textContent, "请打开 Codex3N 后重试");
  assert.equal(app.label.textContent, "连接失败");
});

test("重注入清理旧心跳并隔离迟到的恢复响应", async () => {
  const old = runtime();
  const pending = deferred<any>();
  let signal: AbortSignal | undefined;
  old.context.fetch = async (_url: string, options: any) => { signal = options.signal; return pending.promise; };
  old.context.scheduleBackendHeartbeat();
  const recovery = old.reconnect(true);
  await Promise.resolve();
  const current = runtime(old.window);
  assert.equal(signal?.aborted, true);
  pending.resolve({ ok: true, json: async () => ({ status: "failed", message: "旧错误" }) });
  await recovery;
  assert.notEqual(current.description.textContent, "旧错误");
  assert.equal(old.timers.size, 0);
  await current.check();
  assert.equal(current.label.textContent, "已连接");
});

test("持续失败触发一次自动恢复，重复心跳复用退避", async () => {
  const app = runtime();
  app.setStatus({ status: "failed", timeout: true });
  for (let i = 0; i < 4; i++) await app.check(true);
  await Promise.resolve();
  assert.equal(app.requests(), 1);
  await app.check(true);
  assert.equal(app.requests(), 1);
});

test("繁忙页面的自动恢复宽限有上限，手动恢复可立即执行", async () => {
  const app = runtime();
  app.window.__codexSessionDeleteBridge = () => {};
  app.window.__codexPlusBridgeHealth = { firstFailureAt: 100000, lastAttemptAt: 100000 };
  await app.reconnect();
  assert.equal(app.requests(), 0);
  app.advance(31000);
  app.window.__codexPlusBridgeHealth.lastAttemptAt = 131000;
  await app.reconnect();
  assert.equal(app.requests(), 1);
  const manual = runtime();
  manual.window.__codexSessionDeleteBridge = () => {};
  manual.window.__codexPlusBridgeHealth = { firstFailureAt: 100000, lastAttemptAt: 100000 };
  await manual.reconnect(true);
  assert.equal(manual.requests(), 1);
});

test("旧面板上的重连按钮调用当前代次的恢复入口", async () => {
  const old = runtime();
  const click = () => old.window.__codexPlusReconnectBackend();
  const current = runtime(old.window);
  await click();
  assert.equal(current.requests(), 1);
  assert.equal(old.requests(), 0);
});

test("原生页面通过独立恢复 binding 工作，不依赖页面 fetch", async () => {
  const app = runtime();
  const calls: any[] = [];
  app.window.__codexPlusRecoveryBridge = async (path: string, payload: any) => {
    calls.push({ path, payload });
    return { status: path === "/status" ? "idle" : "ok" };
  };
  app.setFetch(async () => { throw new Error("native network policy blocks loopback"); });
  await app.reconnect(true);
  assert.equal(app.label.textContent, "已连接");
  assert.equal(app.requests(), 0);
  assert.deepEqual(calls.map(call => call.path), ["/reconnect", "/status"]);
  assert.equal(calls[0].payload.token, "synthetic-token");
  assert.doesNotMatch(source, /refreshCodexServiceTierControls/);
});

test("客户端超时回包只记录失败，不会更新成功时间", async () => {
  const transport = readFileSync(new URL("../../../assets/inject/renderer-inject/60-plugin-marketplace.js", import.meta.url), "utf8");
  const start = transport.indexOf("  async function postJson(");
  const end = transport.indexOf("  function downloadMarkdownFallback(", start);
  let successes = 0, failures = 0;
  const context = vm.createContext({
    window: { __codexSessionDeleteBridge: async () => ({ status: "failed", transportFailed: true }) },
    recordCodexPlusBridgeSuccess: () => { successes++; },
    recordCodexPlusBridgeFailure: () => { failures++; },
  });
  vm.runInContext(transport.slice(start, end), context);
  await context.postJson("/settings/get", {});
  assert.equal(successes, 0);
  assert.equal(failures, 1);
  context.window.__codexSessionDeleteBridge = async () => ({ status: "failed", message: "业务失败" });
  await context.postJson("/settings/get", {});
  assert.equal(successes, 1);
});
