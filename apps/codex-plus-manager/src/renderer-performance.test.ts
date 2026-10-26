import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readRendererInjectSource } from "./inject-fragments.ts";

const renderer = await readRendererInjectSource();
const syntax = ts.createSourceFile("renderer.js", renderer, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const entry = syntax.statements[0] as ts.ExpressionStatement;
const arrow = ((entry.expression as ts.CallExpression).expression as ts.ParenthesizedExpression).expression as ts.ArrowFunction;
const declarations = (arrow.body as ts.Block).statements;
function source(...names: string[]) {
  return names.map((name) => {
    const declaration = declarations.find((statement) =>
      (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
      || (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === name)));
    assert.ok(declaration, `${name} 必须在主作用域`);
    return declaration.getText(syntax);
  }).join("\n");
}
function events() {
  const listeners = new Map<string, Set<(event: any) => void>>();
  return {
    listeners,
    addEventListener(name: string, fn: (event: any) => void) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)!.add(fn); },
    removeEventListener(name: string, fn: (event: any) => void) { listeners.get(name)?.delete(fn); },
    emit(name: string, event = {}) { for (const fn of [...(listeners.get(name) || [])]) fn({ type: name, ...event }); },
  };
}
function clock() {
  let time = 0, id = 0;
  const frames = new Map<number, () => void>(), timers = new Map<number, { fn: () => void; at: number }>();
  return {
    frames, timers, now: () => time,
    requestAnimationFrame(fn: () => void) { frames.set(++id, fn); return id; },
    cancelAnimationFrame(key: number) { frames.delete(key); },
    setTimeout(fn: () => void, delay: number) { timers.set(++id, { fn, at: time + delay }); return id; },
    clearTimeout(key: number) { timers.delete(key); },
    tick() { time += 16; for (const [key, fn] of [...frames]) if (frames.delete(key)) fn(); },
    advance(ms: number) { time += ms; for (const [key, item] of [...timers]) if (item.at <= time && timers.delete(key)) item.fn(); },
  };
}
function compile(text: string, deps: Record<string, any>, result: string) {
  return new Function(...Object.keys(deps), `${text}\nreturn ${result};`)(...Object.values(deps));
}
function perfRuntime(longTasks = true) {
  const time = clock();
  let node: any = null, selected = "";
  const document = Object.assign(events(), { hidden: false, querySelector: (selector: string) =>
    selector.includes("aria-current") ? { getAttribute: () => selected } : node });
  const window = { location: { href: "app://-/thread/start" }, innerHeight: 900, __CODEX_PLUS_VERSION__: "1.7.7-3n.1" };
  let nativeObserver: any;
  class Observer {
    static supportedEntryTypes = longTasks ? ["longtask"] : [];
    callback: any; disconnected = false;
    constructor(fn: any) { this.callback = fn; nativeObserver = this; }
    observe() {}
    takeRecords() { return []; }
    disconnect() { this.disconnected = true; }
  }
  const published: any[] = [];
  const create = compile(source("createCodexPlusPerformanceDiagnostics"), {
    window, document, ...time, performance: { now: time.now }, PerformanceObserver: Observer,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
  }, "createCodexPlusPerformanceDiagnostics");
  const api = create({ officialVersion: () => "26.1007.2314.0", repositoryVersion: "1.7.7-3n.1", publish: (report: any) => published.push(report) });
  const makeNode = (key: string) => ({ isConnected: true, getAttribute: () => key, getBoundingClientRect: () => ({ width: 800, height: 50, bottom: 100, top: 50 }) });
  return { api, window, document, time, published, makeNode,
    observer: () => nativeObserver,
    select: (id: string) => { selected = id; },
    content: (next: any) => { node = next; },
    click: (id: string) => document.emit("click", { target: { closest: () => ({ getAttribute: () => id }) } }),
  };
}

test("诊断默认不采样，无监听和计时器", () => {
  const app = perfRuntime();
  assert.equal(app.api.snapshot(), null);
  assert.equal(app.api.begin("layout"), null);
  assert.equal(app.time.timers.size, 0);
  assert.equal(app.document.listeners.size, 0);
});

test("采样上限为60秒，晚到的RPC不计入下一轮", () => {
  const app = perfRuntime();
  app.api.start(120000);
  const old = app.api.begin("thread/read", true);
  app.time.advance(60000);
  assert.equal(app.api.snapshot().active, false);
  assert.equal(app.time.timers.size, 0);
  assert.equal(app.observer().disconnected, true);
  assert.equal(app.document.listeners.get("click")?.size, 0);
  app.api.start(); old();
  assert.deepEqual(app.api.snapshot().spans, {});
  app.api.stop();
});

test("诊断只接受阶段和RPC白名单，缺失能力如实报告", () => {
  const app = perfRuntime(false);
  app.api.start();
  assert.equal(app.api.begin("secret/prompt", true), null);
  const end = app.api.begin("thread/read", true);
  app.time.advance(12); end(); end();
  const report = app.api.stop();
  assert.deepEqual(report.spans["rpc:thread/read"], { count: 1, totalMs: 12, maxMs: 12 });
  assert.ok(report.missing.includes("longTasks"));
  assert.ok(report.missing.includes("requestQueueTiming"));
  assert.equal(report.versions.official, "26.1007.2314.0");
  assert.equal(app.published.length, 1);
  assert.doesNotMatch(JSON.stringify(report), /app:\/\/|secret\/prompt|threadId|params|body/);
});

test("内容可见等到目标会话和两帧确认，旧内容不能算作成功", () => {
  const app = perfRuntime();
  app.content(app.makeNode("old-turn"));
  app.api.start(); app.click("private-thread-B"); app.select("private-thread-B");
  app.time.tick();
  assert.equal(app.api.snapshot().switches.length, 0);
  app.content(app.makeNode("new-turn")); app.time.tick();
  assert.equal(app.api.snapshot().switches.length, 0);
  app.time.tick();
  const report = app.api.stop();
  assert.equal(report.switches[0].status, "visible");
  assert.equal(report.switches[0].contentVisibleMs, 48);
  assert.doesNotMatch(JSON.stringify(report), /private-thread|old-turn|new-turn/);
});

test("快速A→B→A及隐藏中止旧测量，RPC完成不代表绘制完成", () => {
  const app = perfRuntime();
  app.api.start(); app.click("B");
  const end = app.api.begin("thread/resume", true);
  app.time.advance(5); end();
  assert.equal(app.api.snapshot().switches.length, 0);
  app.click("A");
  assert.equal(app.api.snapshot().switches[0].status, "superseded");
  app.document.hidden = true; app.time.tick();
  assert.equal(app.api.stop().switches[1].status, "hidden");
  assert.equal(app.time.frames.size, 0);
});

test("长任务只保留计数和时长，重开采样不会累积监听", () => {
  const app = perfRuntime();
  app.api.start(); app.api.start();
  assert.equal(app.document.listeners.get("click")?.size, 1);
  app.observer().callback({ getEntries: () => [{ startTime: app.time.now(), duration: 82, name: "private-title", attribution: "secret" }] });
  const report = app.api.stop();
  assert.deepEqual(report.longTasks, { count: 1, totalMs: 82, maxMs: 82 });
  assert.doesNotMatch(JSON.stringify(report), /private-title|secret/);
});

function scanRuntime() {
  const time = clock();
  const window = Object.assign(events(), { location: { href: "app://-/A" } });
  const document = Object.assign(events(), { hidden: false });
  const runs: Array<{ phase: string; work: any }> = [];
  const state = { rafId: 0, targetsDirty: false };
  const start = renderer.indexOf("  const codexPlusAllScanWork =");
  const end = renderer.indexOf("  /**\n   * 侧边栏入口的启动补扫", start);
  assert.ok(start > 0 && end > start);
  const api = compile(source("runScheduledScan") + renderer.slice(start, end) + source("scan"), {
    window, document, ...time, clearInterval: time.clearTimeout, conversationViewState: state,
    selectors: { sidebarThread: "[data-app-action-sidebar-thread-id]", conversationViewScrollContainer: ".thread-scroll-container", conversationViewFooter: "[data-thread-scroll-footer]", appHeader: "header" },
    shouldScheduleScan: (records: any[]) => records.some((record) => !record.ignore),
    isExtensionUiNode: (node: any) => !!node?.extension,
    nodeOrAncestorLooksLikeCodexUserBubble: () => false,
    installDictationSupportPatch() {}, runScanStep: (fn: any) => fn(),
    scanLightweight: (work: any) => runs.push({ phase: "light", work }),
    scanDeferred: (work: any) => runs.push({ phase: "deferred", work }),
  }, "{ scheduleScan, scan, onCodexPlusScanNavigation, onCodexPlusScanVisibility, dispose: window.__codexPlusScanCleanup }");
  return { api, time, window, document, runs, state };
}
function mutationFor(area: string) {
  const node = { nodeType: 1,
    matches: (selector: string) => area === "sidebar" ? selector.includes("aside.app-shell-left-panel") : selector.includes(".thread-scroll-container"),
    closest: () => null, querySelector: () => null };
  return { target: node, addedNodes: [], removedNodes: [] };
}

test("200ms内合并扫描，脏任务全部保留，只有一个延迟帧", () => {
  const app = scanRuntime();
  app.api.scheduleScan([mutationFor("sidebar")]); app.api.scheduleScan([mutationFor("conversation")]);
  assert.equal(app.time.timers.size, 1);
  app.time.advance(199);
  assert.equal(app.runs.length, 0);
  app.time.advance(1); app.api.scan({ menus: true });
  assert.equal(app.time.frames.size, 1);
  app.time.tick();
  const work = app.runs.at(-1)!.work;
  assert.ok(work.sidebar && work.conversation && work.menus);
});

test("正文变更不扫描，侧栏变更只安排侧栏任务", () => {
  const app = scanRuntime();
  app.api.scheduleScan([{ ...mutationFor("conversation"), ignore: true }]);
  assert.equal(app.time.timers.size, 0);
  app.api.scheduleScan([mutationFor("sidebar")]); app.time.advance(200);
  assert.deepEqual(app.runs[0].work, { sidebar: true });
});

test("扫描执行后复位排队标记，后续变更还能再安排扫描", () => {
  const app = scanRuntime();
  app.api.scheduleScan([mutationFor("sidebar")]); app.time.advance(200);
  app.api.scheduleScan([mutationFor("sidebar")]);
  assert.equal(app.time.timers.size, 1, "第二次变更必须重新排一次扫描");
  app.time.advance(200);
  assert.equal(app.runs.filter((item) => item.phase === "light").length, 2);
});

test("已有消息内的流式Markdown节点不触发扫描，菜单和新消息边界仍刷新", () => {
  const check = compile(source("isChatContentMutation"), {
    selectors: { conversationViewScrollContainer: ".thread-scroll-container", conversationViewFooter: "[data-thread-scroll-footer]" },
  }, "isChatContentMutation");
  const target = { closest: () => ({}) };
  const text = { nodeType: 3 };
  const span = { nodeType: 1, matches: () => false, querySelector: () => null };
  const boundary = { nodeType: 1, matches: () => true, querySelector: () => null };
  assert.equal(check({ target, addedNodes: [text, span], removedNodes: [] }), true);
  assert.equal(check({ target, addedNodes: [boundary], removedNodes: [] }), false);
  assert.equal(check({ target, addedNodes: [], removedNodes: [boundary] }), false);
});

test("切换取消旧延迟任务，新的导航只刷新当前页面", () => {
  const app = scanRuntime();
  app.api.scan({ conversation: true });
  const stale = [...app.time.frames.values()][0];
  app.api.onCodexPlusScanNavigation({ type: "popstate" });
  app.window.location.href = "app://-/B"; stale();
  assert.equal(app.runs.filter((item) => item.phase === "deferred").length, 0);
  app.time.advance(200); app.time.tick();
  assert.equal(app.runs.filter((item) => item.phase === "deferred").length, 1);
  assert.equal(app.state.targetsDirty, true);
});

test("隐藏暂停扫描，恢复补扫一次，销毁后旧回调不再刷新", () => {
  const app = scanRuntime();
  app.api.scan({ sidebar: true });
  app.document.hidden = true; app.document.emit("visibilitychange");
  app.api.scheduleScan([mutationFor("sidebar")]);
  assert.equal(app.time.frames.size + app.time.timers.size, 0);
  app.document.hidden = false; app.document.emit("visibilitychange"); app.document.emit("visibilitychange");
  assert.equal(app.time.timers.size, 1);
  app.time.advance(200);
  const stale = [...app.time.frames.values()][0];
  app.api.dispose(); stale();
  const count = app.runs.length;
  app.api.scan(); app.api.scheduleScan();
  assert.equal(app.runs.length, count);
  assert.equal(app.time.timers.size + app.time.frames.size, 0);
});

test("输入法组合按键不会被当成会话导航", () => {
  const app = scanRuntime();
  app.api.onCodexPlusScanNavigation({ type: "keydown", key: "Enter", isComposing: true });
  assert.equal(app.time.timers.size, 0);
});

test("输入法组词期间暂停已有扫描，结束后合并补扫，失焦释放状态", () => {
  const app = scanRuntime();
  app.api.scheduleScan([mutationFor("sidebar")]);
  app.document.emit("compositionstart");
  app.time.advance(500);
  app.api.scheduleScan([mutationFor("conversation")]);
  app.api.scan({ menus: true });
  assert.equal(app.runs.length, 0);
  assert.equal(app.time.frames.size + app.time.timers.size, 0);
  app.document.emit("compositionend");
  app.time.advance(200); app.time.tick();
  assert.equal(app.runs.length, 2);
  assert.ok(app.runs[1].work.sidebar && app.runs[1].work.conversation && app.runs[1].work.menus);
  app.document.emit("compositionstart");
  app.api.scheduleScan([mutationFor("sidebar")]);
  app.window.emit("blur"); app.time.advance(200);
  assert.equal(app.runs.length, 3);
  app.api.dispose();
  assert.equal(app.document.listeners.get("compositionstart")?.size, 0);
});

test("编辑文字不扫描，输入框和菜单挂载仍刷新", () => {
  const check = compile(source("isComposerContentMutation"), {}, "isComposerContentMutation");
  const editor = { closest: () => ({}) };
  const span = { nodeType: 1, matches: () => false };
  const menu = { nodeType: 1, matches: () => true };
  assert.equal(check({ target: editor, addedNodes: [span], removedNodes: [] }), true);
  assert.equal(check({ target: { nodeType: 3, parentElement: editor }, addedNodes: [], removedNodes: [] }), true);
  assert.equal(check({ target: editor, addedNodes: [menu], removedNodes: [] }), false);
  assert.equal(check({ target: { closest: () => null }, addedNodes: [menu], removedNodes: [] }), false);
});

test("相同心跳状态不重复写入DOM，新挂载节点仍更新", () => {
  let writes = 0, refreshes = 0;
  function node(): any {
    const values: Record<string, any> = {};
    const attributes: Record<string, string> = {};
    return new Proxy({ dataset: new Proxy({}, { set(target, key, value) { writes++; Reflect.set(target, key, value); return true; } }) }, {
      get(target, key) {
        if (key === "getAttribute") return (name: string) => attributes[name];
        if (key === "setAttribute") return (name: string, value: string) => { writes++; attributes[name] = value; };
        return key === "dataset" ? target.dataset : values[String(key)];
      },
      set(_target, key, value) { writes++; values[String(key)] = value; return true; },
    });
  }
  let label = node(); const indicator = node(), sidebar = node(), version = node(), description = node();
  const render = compile(source("renderBackendStatus"), {
    window: {}, CODEX_PLUS_BRIDGE_FAILURE_THRESHOLD: 3, codexPlusBridgeFailureCount: 0,
    codexPlusRecoveryPromise: null,
    codexPlusBackendStatus: { status: "ok", version: "1.7.7" }, codexPlusVersion: "", codexPlusSidebarNavId: "nav",
    document: { querySelector: (selector: string) => selector.includes("description") ? description : selector.includes("sidebar") ? sidebar : label,
      querySelectorAll: (selector: string) => selector.includes("version") ? [version] : [indicator] },
    refreshCodexServiceTierControls: () => { refreshes++; },
  }, "renderBackendStatus");
  render(); const firstWrites = writes;
  render(); render();
  assert.equal(writes, firstWrites);
  assert.equal(refreshes, 0);
  label = node(); render();
  assert.equal(label.textContent, "已连接");
  assert.ok(writes > firstWrites);
});

test("稳定对齐在三帧停止，持续变化最多16帧，隐藏不调度", () => {
  const time = clock(), state: any = { rafId: 0 }, document = { hidden: false };
  let frames = 0, moving = false;
  const schedule = compile(source("scheduleConversationViewAlign"), {
    ...time, document, window: {}, conversationViewState: state,
    codexPlusSettings: () => ({ conversationView: true }),
    conversationViewAlignNow: () => { frames++; return moving ? String(frames) : "stable"; },
  }, "scheduleConversationViewAlign");
  schedule(); schedule();
  for (let i = 0; i < 20; i++) time.tick();
  assert.equal(frames, 3);
  frames = 0; moving = true; schedule();
  for (let i = 0; i < 16; i++) { schedule(); time.tick(); }
  assert.equal(frames, 16);
  assert.equal(time.frames.size, 0);
  document.hidden = true; schedule();
  assert.equal(time.frames.size, 0);
});

test("目标缓存复用有效节点，节点替换和脏标记触发重新查找", () => {
  const state: any = { targetsDirty: true, elements: new Set(), observed: new WeakSet(), ro: null };
  const makeContent = () => ({ isConnected: true, closest: (selector: string) => selector === ".scroller" ? {} : null });
  let content: any = makeContent(), finds = 0;
  const composer = { isConnected: true };
  const resolve = compile(source("conversationViewResolveTargets", "conversationViewObserveIfNeeded"), {
    document: { documentElement: {}, body: {} }, conversationViewState: state,
    conversationViewScrollContainerSelector: ".scroller", conversationViewPaneBoundarySelector: "aside",
    conversationViewFindContentEl: () => { finds++; return content; },
    conversationViewFindComposerEl: () => composer, conversationViewRestoreElement() {},
  }, "conversationViewResolveTargets");
  resolve(); resolve(); resolve();
  assert.equal(finds, 1);
  content.isConnected = false; content = makeContent(); resolve();
  assert.equal(finds, 2);
  assert.equal(state.contentEl, content);
  state.targetsDirty = true; resolve();
  assert.equal(finds, 3);
});

test("布局观察忽略消息内部变化，新面板和被替换节点使缓存失效", () => {
  const content = { isConnected: true };
  const relevant = compile(source("conversationViewMutationRelevant"), {
    conversationViewState: { contentEl: content, composerEl: null },
    conversationViewScrollContainerSelector: ".thread-scroll-container",
    conversationViewContentAnchorSelector: "[data-content]",
    conversationViewFooterSelector: "[data-footer]",
    conversationViewPaneBoundarySelector: "aside",
    isExtensionUiNode: () => false, conversationViewLooksLikeThreadWidthBox: () => false,
  }, "conversationViewMutationRelevant");
  const node = { matches: () => false, querySelector: () => null, contains: () => false };
  assert.equal(relevant([{ type: "childList", target: node, addedNodes: [{ ...node, nodeType: 1 }], removedNodes: [] }]), false);
  assert.equal(relevant([{ type: "attributes", target: { ...node, matches: () => true } }]), true);
  content.isConnected = false;
  assert.equal(relevant([]), true);
});

test("RPC计时复用原请求，正常完成和异常均结束计时", () => {
  for (const name of ["patchAppServerModelRequestClient", "installCodexAppServerClientPrototypePatch"]) {
    const body = source(name);
    assert.match(body, /__codexPlusPerf\?\.begin\(requestMethod, true, /);
    assert.match(body, /finally\s*\{\s*finishTiming\?\.\(\)/);
  }
});

test("三组对照工具只部署采样，不调用会话读写接口", async () => {
  const script = await readFile(new URL("../../../scripts/profile-codex-switching.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(script, /sendRequest|thread\/read|thread\/resume|\.click\(|Debugger\.|Page\.reload/);
  assert.match(script, /enoughSamples: samples.length >= 20/);
});

test("对照工具按版本、类别和冷热状态合并批次，缺失注入计时保留null", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-performance-"));
  try {
    const paths = [];
    for (let i = 0; i < 3; i++) {
      const path = join(dir, `${i}.json`);
      paths.push(path);
      await writeFile(path, JSON.stringify({
        group: "baseline", category: i === 2 ? "long" : "short", temperature: "warm",
        sample: { schema: 1, durationMs: 60000,
          versions: { official: "26.1007.2314.0", injected: "1.7.6-3n.1", repository: "1.7.7-3n.1" },
          switches: Array.from({ length: 10 }, () => ({ status: "visible", contentVisibleMs: 1500 + i * 100 })),
          spans: {}, capabilities: { injectionTiming: false },
          missing: ["injectionTiming"], longTasks: { count: 1, totalMs: 70, maxMs: 70 },
        },
      }));
    }
    const script = fileURLToPath(new URL("../../../scripts/profile-codex-switching.mjs", import.meta.url));
    const output = execFileSync(process.execPath, [script, ...paths.flatMap((path) => ["--compare", path])], { encoding: "utf8" });
    const reports = output.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(reports.length, 2);
    assert.equal(reports[0].batches, 2);
    assert.equal(reports[0].confirmedSwitches, 20);
    assert.equal(reports[0].contentVisibleP95Ms, 1600);
    assert.equal(reports[0].injectionMs, null);
    assert.equal(reports[0].enoughSamples, true);
    assert.equal(reports[1].enoughSamples, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("thread/list诊断只记录参数等值分组和执行区间，按主机统计重叠", () => {
  const app = perfRuntime(); app.api.start();
  const first = app.api.begin("thread/list", true, { host: "ssh:secret-host", params: { cwd: "private/path", cursor: "private-cursor" } });
  app.time.advance(100);
  const second = app.api.begin("thread/list", true, { host: "ssh:secret-host", params: { cursor: "private-cursor", cwd: "private/path" } });
  const third = app.api.begin("thread/list", true, { host: "other-host", params: { cwd: "private/path", cursor: "private-cursor" } });
  first(); app.time.advance(30); second(); third();
  const report = app.api.stop();
  assert.equal(report.rpcOverlaps, 1);
  assert.equal(report.rpcRequests.length, 3);
  assert.equal(report.rpcRequests[0].paramsFingerprint, report.rpcRequests[1].paramsFingerprint);
  assert.equal(report.rpcRequests[0].endMs, 100);
  assert.equal(report.rpcRequests[1].startMs, 100);
  assert.equal(report.rpcRequests[1].endMs, 130);
  assert.ok(!/secret-host|private.path|private-cursor|other-host/.test(JSON.stringify(report)));
  app.api.start(); assert.equal(app.api.snapshot().rpcRequests.length, 0);
});
