import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { readRendererInjectSource } from "./inject-fragments.ts";

function functionSource(text: string, name: string) {
  const ast = ts.createSourceFile("runtime.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let found: ts.FunctionDeclaration | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, name);
  return found.getText(ast);
}
function events() {
  const listeners = new Map<string, Set<Function>>();
  return { listeners,
    addEventListener(name: string, fn: Function) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    removeEventListener(name: string, fn: Function) { listeners.get(name)?.delete(fn); },
    emit(name: string) { for (const fn of listeners.get(name) || []) fn({ type: name }); },
  };
}
function compile(text: string, deps: Record<string, any>, result: string) {
  return new Function(...Object.keys(deps), `${text}\nreturn ${result};`)(...Object.values(deps));
}
const renderer = await readRendererInjectSource();
const patchSource = functionSource(renderer, "patchCodexPlusGitWorkerPerformance");
function gitRuntime() {
  let now = 0;
  const window = events(), document = events();
  const calls: any[] = [];
  const worker = { workerId: "git", allEventListeners: new Set<Function>(),
    request(request: any) { return new Promise((resolve, reject) => calls.push({ request, resolve, reject })); },
  };
  const original = worker.request;
  const patch = compile(patchSource, { window, document, Date: { now: () => now }, AbortController, DOMException, structuredClone }, "patchCodexPlusGitWorkerPerformance");
  const stop = patch(worker);
  const request = (overrides: any = {}) => worker.request({ method: "stable-metadata", params: { cwd: "D:/repo", hostConfig: { id: "durable" } }, ...overrides });
  return { worker, window, document, calls, stop, original, request, advance: (ms: number) => { now += ms; } };
}
const metadata = { root: "D:/repo", commonDir: "D:/repo/.git" };

test("相同仓库识别只启动一次，结果隔离，2秒后重新查询", async () => {
  const app = gitRuntime();
  const first = app.request(), second = app.request();
  await Promise.resolve();
  assert.equal(app.calls.length, 1);
  app.calls[0].resolve(metadata);
  const [a, b] = await Promise.all([first, second]);
  (a as any).root = "changed";
  assert.deepEqual(b, metadata);
  assert.deepEqual(await app.request(), metadata);
  assert.equal(app.calls.length, 1);
  app.advance(2001);
  const next = app.request(); await Promise.resolve();
  assert.equal(app.calls.length, 2);
  app.calls[1].resolve(metadata); await next;
  app.stop(); assert.equal(app.worker.request, app.original);
  assert.equal(app.worker.allEventListeners.size, 0);
  assert.equal(app.window.listeners.get("focus")?.size, 0);
});

test("一个调用取消不影响其他调用，全部取消才取消原生请求", async () => {
  const app = gitRuntime(), a = new AbortController(), b = new AbortController();
  const first = app.request({ signal: a.signal }), second = app.request({ signal: b.signal });
  const rejected = assert.rejects(first, { name: "AbortError" });
  await Promise.resolve(); a.abort(); await rejected;
  assert.equal(app.calls[0].request.signal.aborted, false);
  app.calls[0].resolve(metadata); assert.deepEqual(await second, metadata);
  app.advance(2001);
  const c = new AbortController(), last = app.request({ signal: c.signal });
  const canceled = assert.rejects(last, { name: "AbortError" });
  await Promise.resolve(); c.abort(); await canceled;
  assert.equal(app.calls[1].request.signal.aborted, true);
  app.calls[1].reject(new DOMException("canceled", "AbortError"));
  await Promise.resolve(); app.stop();
});

test("失败和非仓库不缓存，Git事件与窗口恢复使缓存失效", async () => {
  const app = gitRuntime();
  const failed = app.request(); const rejection = assert.rejects(failed, /failed/);
  await Promise.resolve(); app.calls[0].reject(new Error("failed")); await rejection;
  const empty = app.request(); await Promise.resolve(); app.calls[1].resolve(null); assert.equal(await empty, null);
  const valid = app.request(); await Promise.resolve(); app.calls[2].resolve(metadata); await valid;
  for (const listener of app.worker.allEventListeners) listener({ type: "repo-changed" });
  const fresh = app.request(); await Promise.resolve(); app.calls[3].resolve(metadata); await fresh;
  app.window.emit("focus");
  const focused = app.request(); await Promise.resolve(); app.calls[4].resolve(metadata); await focused;
  assert.equal(app.calls.length, 5);
  app.stop();
});

test("远程、监听初始化及写操作沿用原生请求，不跨目录合并", async () => {
  const app = gitRuntime();
  const requests = [
    { method: "stable-metadata", params: { cwd: "D:/repo", hostConfig: { id: "remote:ssh" } } },
    { method: "stable-metadata", params: { cwd: "D:/repo", hostConfig: { id: "durable" }, watchForGitInit: true } },
    { method: "checkout-branch", params: { root: "D:/repo", branch: "other" } },
  ];
  for (const request of requests) {
    const result = app.worker.request(request);
    assert.equal(app.calls.at(-1).request, request);
    app.calls.at(-1).resolve(metadata); await result;
  }
  const first = app.request(), second = app.request({ params: { cwd: "D:/other", hostConfig: { id: "durable" } } });
  await Promise.resolve(); assert.equal(app.calls.length, 5);
  app.calls[3].resolve(metadata); app.calls[4].resolve(metadata); await Promise.all([first, second]);
  app.stop();
});

test("Git客户端按能力安装，关闭后可重新开启，未知模块不反复探测", async () => {
  const app = gitRuntime(); app.stop();
  const pool = new Map();
  class GitClient { constructor() { return app.worker; } }
  class ComputerClient {}
  function factory(id: string) {
    switch (id) {
      case "git": pool.set(id, new GitClient()); return pool.get(id);
      case "computer-use": pool.set(id, new ComputerClient()); return pool.get(id);
    }
  }
  let module: any = { unstableExportName: factory }, loads = 0;
  const settings = { enhancementsEnabled: true };
  const runtime = compile(`let codexPlusGitPerformanceInstalling = false, codexPlusGitPerformanceRetryAt = 0;
    ${functionSource(renderer, "installCodexPlusGitPerformance")}`, {
    window: app.window, codexPlusScanDisposed: false, codexPlusIsWindowsPlatform: true,
    codexPlusBackendSettings: settings,
    loadOptionalCodexAppModule: async () => { loads++; return module; },
    patchCodexPlusGitWorkerPerformance: compile(patchSource, { window: app.window, document: app.document }, "patchCodexPlusGitWorkerPerformance"),
  }, "installCodexPlusGitPerformance");
  await runtime(); assert.notEqual(app.worker.request, app.original);
  await runtime(); assert.equal(loads, 1);
  (app.window as any).__codexPlusGitPerformanceCleanup();
  settings.enhancementsEnabled = false; await runtime(); assert.equal(loads, 1);
  settings.enhancementsEnabled = true; await runtime(); assert.equal(loads, 2);
  (app.window as any).__codexPlusGitPerformanceCleanup();
  module = {}; await runtime(); await runtime(); assert.equal(loads, 3);
  assert.equal(app.worker.request, app.original);
});

const conversation = await readFile(new URL("../../../assets/inject/conversation-performance.js", import.meta.url), "utf8");
const conversationSource = functionSource(conversation, "createConversationPerformance");
function conversationRuntime(count = 45) {
  const frames = new Map<number, Function>(); let frameId = 0, reads = 0;
  const window = events(), document = Object.assign(events(), { hidden: false, documentElement: {} as any,
    querySelectorAll: () => turns });
  const turns: any[] = Array.from({ length: count }, (_, index) => {
    const values = new Map<string, { value: string; priority: string }>();
    return { isConnected: true, index, style: {
      getPropertyValue: (name: string) => values.get(name)?.value || "",
      getPropertyPriority: (name: string) => values.get(name)?.priority || "",
      setProperty(name: string, value: string, priority = "") { values.set(name, { value, priority }); },
      removeProperty(name: string) { values.delete(name); },
    }, getBoundingClientRect() { reads++; return { width: 800, height: 100 + index }; } };
  });
  let observer: any;
  class Observer {
    callback: Function; disconnected = false;
    constructor(fn: Function) { this.callback = fn; observer = this; }
    observe() { this.disconnected = false; }
    disconnect() { this.disconnected = true; }
  }
  const create = compile(conversationSource, { window, document, MutationObserver: Observer, CSS: { supports: () => true },
    getComputedStyle: (node: any) => ({ contentVisibility: "visible", position: "static", blockSize: `${100 + node.index}px`, ...node.computed }),
    requestAnimationFrame(fn: Function) { frames.set(++frameId, fn); return frameId; },
    cancelAnimationFrame(id: number) { frames.delete(id); },
  }, "createConversationPerformance");
  const api = create();
  const tick = () => { for (const [id, fn] of [...frames]) if (frames.delete(id)) fn(); };
  return { api, window, document, turns, frames, tick, observer: () => observer, reads: () => reads };
}

test("长会话保留实测高度和最新两条，重复恢复不重新测量，停用还原样式", () => {
  const app = conversationRuntime(); app.api.setEnabled(true); app.tick();
  assert.equal(app.reads(), 43);
  assert.equal(app.turns[0].style.getPropertyValue("content-visibility"), "auto");
  assert.equal(app.turns[0].style.getPropertyValue("contain-intrinsic-block-size"), "auto 100px");
  assert.equal(app.turns[43].style.getPropertyValue("content-visibility"), "");
  app.document.emit("visibilitychange"); app.tick(); assert.equal(app.reads(), 43);
  app.turns[0].style.setProperty("content-visibility", "visible");
  app.api.stop();
  assert.equal(app.turns[0].style.getPropertyValue("content-visibility"), "visible");
  assert.equal(app.turns[1].style.getPropertyValue("content-visibility"), "");
  assert.equal(app.observer().disconnected, true);
  assert.equal(app.frames.size, 0);
});

test("短会话不改变布局，组词和隐藏时暂停，历史流式变化不重复全量扫描", () => {
  const short = conversationRuntime(5); short.api.setEnabled(true); short.tick(); assert.equal(short.reads(), 0);
  short.api.stop();
  const app = conversationRuntime(); app.api.setEnabled(true);
  app.document.emit("compositionstart"); app.tick(); assert.equal(app.reads(), 0);
  app.document.emit("compositionend"); app.tick(); assert.equal(app.reads(), 43);
  app.observer().callback([{ target: { closest: () => ({}) }, addedNodes: [{}], removedNodes: [] }]);
  assert.equal(app.frames.size, 0);
  app.document.hidden = true; app.document.emit("visibilitychange"); assert.equal(app.frames.size, 0);
  app.document.hidden = false; app.document.emit("visibilitychange"); app.tick();
  app.turns.splice(0, 40); app.document.emit("visibilitychange"); app.tick();
  assert.equal(app.turns[0].style.getPropertyValue("content-visibility"), "");
  app.api.stop();
});

test("多会话各自保留最新两条，宿主虚拟化和外边距折叠保持原样", () => {
  const app = conversationRuntime(90), left = {}, right = {};
  app.turns.forEach((node, index) => { node.closest = () => index < 45 ? left : right; });
  app.turns[0].computed = { contentVisibility: "auto" };
  app.turns[1].computed = { position: "absolute" };
  app.turns[2].computed = { display: "block", paddingBlockStart: "0px", borderBlockStartWidth: "0px" };
  app.turns[2].firstElementChild = { computed: { marginBlockStart: "8px" } };
  app.api.setEnabled(true); app.tick();
  for (const index of [0, 1, 2, 43, 44, 88, 89]) assert.equal(app.turns[index].style.getPropertyValue("content-visibility"), "");
  assert.equal(app.turns[42].style.getPropertyValue("content-visibility"), "auto");
  assert.equal(app.turns[87].style.getPropertyValue("content-visibility"), "auto");
  app.api.stop();
});
