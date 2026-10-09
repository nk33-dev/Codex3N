import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";

import { readRendererInjectSource } from "./inject-fragments.ts";

const renderer = await readRendererInjectSource();
const syntax = ts.createSourceFile("renderer-inject.js", renderer, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const entry = syntax.statements[0];
assert.ok(ts.isExpressionStatement(entry) && ts.isCallExpression(entry.expression));
const wrapper = entry.expression.expression;
assert.ok(ts.isParenthesizedExpression(wrapper) && ts.isArrowFunction(wrapper.expression));
assert.ok(ts.isBlock(wrapper.expression.body));
const declarations = wrapper.expression.body.statements;

function runtimeSource(...names: string[]) {
  return names.map((name) => {
    const declaration = declarations.find((statement) =>
      (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
      || (ts.isVariableStatement(statement) && statement.declarationList.declarations.some((entry) => ts.isIdentifier(entry.name) && entry.name.text === name)),
    );
    assert.ok(declaration, `${name} 必须声明在主注入作用域`);
    return declaration.getText(syntax);
  }).join("\n");
}

function section(start: string, end: string) {
  const offset = renderer.indexOf(start);
  const limit = renderer.indexOf(end, offset);
  assert.ok(offset >= 0 && limit > offset);
  return renderer.slice(offset, limit);
}

test("客户端资产按内容定位，覆盖新前缀和单个请求失败", async () => {
  const visited: string[] = [];
  const urls = ["app://-/assets/app-shared-new.js", "app://-/assets/renamed-client.js", ...Array.from({ length: 30 }, (_, i) => `app://-/assets/other-${i}.js`)];
  const locate = new Function("codexAppAssetCandidateUrls", "codexAppAssetUrl", "fetch", `
    ${runtimeSource("codexAppServerClientBundleHints", "codexAppServerClientAssetFetchLimit", "codexAppServerClientCaptureMarker", "codexAppServerClientCaptureAnchor", "locateCodexAppServerClientBreakpoint", "codexAppServerClientAssetCandidateUrls", "resolveCodexAppServerClientHintedUrl", "locateCodexAppServerClientInAssets")}
    return { locate: locateCodexAppServerClientInAssets, marker: codexAppServerClientCaptureMarker, anchor: codexAppServerClientCaptureAnchor };
  `)(() => urls, () => "", async (url: string) => {
    visited.push(url);
    if (url.includes("app-shared-")) throw new Error("asset unavailable");
    return { ok: true, text: async () => url.includes("renamed-client") ? `${locate.anchor}{${locate.marker}` : "unrelated bundle" };
  });
  const result = await locate.locate();
  assert.equal(result.urls.length, 24);
  assert.equal(visited[0], urls[0]);
  assert.equal(result.hit?.url, urls[1]);
  assert.equal(result.hit?.location.lineNumber, 0);
});

test("新版全局状态接口按能力识别，保留旧版导出兼容", () => {
  const resolve = new Function(`
    ${runtimeSource("codexStateCallByCapability", "codexStateApiFromModule")}
    return codexStateApiFromModule;
  `)();
  const legacy = () => null;
  const current = (params: unknown) => ({ get: "get-global-state", set: "set-global-state", params });
  assert.equal(resolve({ qut: legacy }, "app-initial-old"), legacy);
  assert.equal(resolve({ renamed: current, unrelated: legacy }, "app-shared-new"), current);
  assert.equal(resolve({ unrelated: legacy }, "app-shared-new"), null);
});

test("线程徽章重复安装保留标题的父节点和顺序", () => {
  type Node = { parentElement: unknown; dataset: Record<string, string>; textContent: string; className: string; setAttribute: (...args: unknown[]) => void; remove: () => void };
  const children: Node[] = [];
  let created = 0;
  const parent = {
    insertBefore(node: Node, before: Node) {
      assert.equal(before, title);
      node.parentElement = parent;
      children.splice(children.indexOf(before), 0, node);
    },
  };
  const title: Node = { parentElement: parent, dataset: {}, textContent: "会话", className: "title", setAttribute() {}, remove() { throw new Error("官方标题不应移除"); } };
  children.push(title);
  const row = { dataset: {}, querySelectorAll: () => [], querySelector: () => children.find((node) => node.className === "badge") || null };
  const install = new Function("document", "sessionRefFromRow", "threadIdBadgeMeta", "threadIdBadgeTitleNode", `
    const threadIdBadgeClass = "badge", codexThreadIdBadgeVersion = "test";
    ${runtimeSource("threadIdBadgeInsertBefore", "unwrapThreadIdBadgeWrappers", "installThreadIdBadge")}
    return installThreadIdBadge;
  `)({ createElement: () => { created++; return { parentElement: null, dataset: {}, setAttribute() {}, remove() {} }; } }, () => ({ session_id: "local:test" }), () => ({ label: "test", id: "test" }), () => title);
  install(row);
  install(row);
  assert.equal(created, 1);
  assert.equal(title.parentElement, parent);
  assert.equal(children.length, 2);
  assert.equal(children[1], title);
  assert.equal(children[0].textContent, "test");
});

test("模型仍可选择，但不再插入管理面板或未测试状态", () => {
  const descriptor = new Function("codexPlusModelMetadata", "codexModelCatalog", "modelReasoningEfforts", `
    ${section("  function codexPlusModelDescriptor(", "  function modelArrayLooksPatchable(")}
    return codexPlusModelDescriptor("custom-model");
  `)(() => null, { provider_name: "示例供应商" }, () => []);
  assert.equal(descriptor.model, "custom-model");
  assert.equal(descriptor.hidden, false);
  assert.equal(descriptor.isDefault, false);
  assert.equal(descriptor.description, "示例供应商");
  assert.doesNotMatch(renderer, /data-codex-model-controls|data-codex-model-source|管理自定义模型|codex-plus-hidden-models/);
});

test("手工上下文窗口覆盖同名上游模型描述", () => {
  const patch = new Function("codexPlusModelMetadata", "modelReasoningEfforts", `
    ${section("  function applyCodexPlusModelMetadata(", "  function codexPlusModelDescriptor(")}
    return applyCodexPlusModelMetadata;
  `)(() => ({ contextWindow: 1_000_000, maxContextWindow: 1_000_000 }), () => []);
  const descriptor = { model: "deepseek-flash", contextWindow: 262_144, maxContextWindow: 262_144 };
  assert.equal(patch(descriptor, descriptor.model), true);
  assert.equal(descriptor.contextWindow, 1_000_000);
  assert.equal(descriptor.maxContextWindow, 1_000_000);
});

test("注入重载清理会话中的旧 Key 徽章，密钥切换保留在设置页", () => {
  let removed = 0;
  const cleanup = new Function("document", `
    ${runtimeSource("removeLegacyRelayApiKeyBadges")}
    return removeLegacyRelayApiKeyBadges;
  `)({ querySelectorAll: () => Array.from({ length: 2 }, () => ({ remove() { removed += 1; } })) });
  cleanup();
  assert.equal(removed, 2);
  assert.doesNotMatch(renderer, /installCodexRelayApiKeyBadge|refreshCodexRelayApiKeyBadges|codexRelayApiKeyBadgeClass/);
  assert.match(renderer, /runScanStep\(removeLegacyRelayApiKeyBadges\)/);
  assert.match(renderer, /data-codex-relay-api-key-select/);
  assert.match(renderer, /\/relay-api-keys\/select/);
});

/** 用注入脚本里真实的 Key 面板渲染与加载逻辑搭建一个最小运行环境。 */
function relayKeysRuntime(state: { enabled: boolean; status?: string; activeKeyId?: string; keys?: unknown[]; switching?: boolean; liveKeyMatched?: boolean; requestError?: string }, backendStatus = "ok") {
  const summary = { textContent: "正在读取当前供应商…" };
  const list = { textContent: "", innerHTML: "" };
  let requests = 0;
  const serialize = (value: unknown) => String(value);
  const runtime = new Function("document", "postJson", "escapeHtml", `
    let codexPlusRelayApiKeys = ${JSON.stringify({
      status: "ok",
      providerId: "relay-1",
      providerName: "示例供应商",
      activeKeyId: "",
      keys: [],
      ...state,
    })};
    const codexPlusBackendStatus = { status: ${JSON.stringify(backendStatus)} };
    let codexPlusRelayApiKeySwitching = ${state.switching ? "true" : "false"};
    let codexPlusRelayApiKeysPromise = null;
    ${section("  function renderRelayApiKeys(", "  function selectCodexPlusTab(")}
    return { load: loadRelayApiKeys, refreshOnOpen: refreshRelayApiKeysOnPanelOpen };
  `)(
    { querySelector: (selector: string) => (selector.includes("summary") ? summary : selector.includes("list") ? list : null) },
    async () => {
      requests += 1;
      if (state.requestError) throw new Error(state.requestError);
      return { status: "ok" };
    },
    serialize,
  );
  return { summary, list, load: runtime.load, refreshOnOpen: runtime.refreshOnOpen, requestCount: () => requests };
}

test("已读取的 Key 列表在面板重开时重画，不会停在占位文字", async () => {
  // 面板 DOM 每次打开都是新建的，缓存命中分支必须重画，否则一直显示模板里的“正在读取当前供应商…”。
  const { summary, list, load, requestCount } = relayKeysRuntime({
    enabled: true,
    activeKeyId: "key-b",
    keys: [{ id: "key-a", name: "备用 Key" }, { id: "key-b", name: "主 Key" }],
  });
  await load();
  assert.equal(requestCount(), 0);
  assert.equal(summary.textContent, "当前供应商：示例供应商");
  assert.match(list.innerHTML, /<option value="key-a">备用 Key<\/option>/);
  // 当前 Key 由下拉框的选中项表达，不用再写“使用中”标签。
  assert.match(list.innerHTML, /<option value="key-b" selected>主 Key<\/option>/);
});

test("总开关关闭时下拉框照常可选，并说明只换 Key", async () => {
  // 总开关只管「整份切换供应商配置」；换 Key 走只改落点的窄路径，所以不禁用。
  const { summary, list, load } = relayKeysRuntime({
    enabled: false,
    activeKeyId: "key-a",
    keys: [{ id: "key-a", name: "备用 Key" }, { id: "key-b", name: "主 Key" }],
  });
  await load();
  assert.doesNotMatch(list.innerHTML, /disabled/);
  assert.equal(summary.textContent, "当前供应商：示例供应商（未启用供应商配置切换）");
  assert.match(list.innerHTML, /只更换当前 Key/);
});

test("切换进行中才禁用下拉框", async () => {
  const { list, load } = relayKeysRuntime({
    enabled: true,
    switching: true,
    activeKeyId: "key-a",
    keys: [{ id: "key-a", name: "备用 Key" }, { id: "key-b", name: "主 Key" }],
  });
  await load();
  assert.match(list.innerHTML, /data-codex-relay-api-key-select="true"[^>]* disabled/);
});

test("Key 选择器在值变化时提交，支持键盘选择", () => {
  const modal = declarations.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "openCodexPlusModal");
  assert.ok(modal);
  let handler: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(syntax) === "overlay"
      && node.expression.name.text === "addEventListener"
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "change") {
      handler = node.arguments[1];
    }
    ts.forEachChild(node, visit);
  }
  visit(modal);
  assert.ok(handler);
  const selected: string[] = [];
  const onChange = new Function("Element", "selectRelayApiKey", `return (${handler.getText(syntax)});`)(
    Object, (keyId: string) => selected.push(keyId),
  );
  const select = { value: "backup", closest: (selector: string) => selector === "[data-codex-relay-api-key-select]" ? select : null };
  onChange({ target: select });
  assert.deepEqual(selected, ["backup"]);
  assert.doesNotMatch(runtimeSource("openCodexPlusModal").split('overlay.addEventListener("click"')[1], /selectRelayApiKey\(apiKeySelect.value\)/);
});

test("没有命名 Key 时都提示去管理工具添加", async () => {
  for (const enabled of [true, false]) {
    const { list, load } = relayKeysRuntime({ enabled });
    await load();
    assert.match(list.innerHTML, /请先在管理工具中添加/);
    assert.doesNotMatch(list.innerHTML, /data-codex-relay-api-key-select/);
  }
});

test("live 里的 Key 不在列表里时如实提示，不假装匹配", async () => {
  const { list, load } = relayKeysRuntime({
    enabled: false,
    activeKeyId: "key-deepseek",
    liveKeyMatched: false,
    keys: [{ id: "key-deepseek", name: "DeepSeek" }],
  });
  await load();
  assert.match(list.innerHTML, /实际在用的 Key 不在这个列表里/);
  assert.match(list.innerHTML, /<option value="key-deepseek" selected>DeepSeek<\/option>/);
});

test("读取 Key 失败后显示失败状态，不在每次刷新时重复请求", async () => {
  const { summary, load, requestCount } = relayKeysRuntime({ enabled: true, requestError: "桥接不可用" });
  await load(true);
  assert.equal(requestCount(), 1);
  assert.equal(summary.textContent, "桥接不可用");
  await load();
  assert.equal(requestCount(), 1);
});

test("面板打开时用缓存重画，不重复请求", async () => {
  // 重画必须由「打开面板」驱动：新面板 DOM 是新建的，靠事件门控会永久停在占位文案。
  const { summary, list, load, refreshOnOpen, requestCount } = relayKeysRuntime({
    enabled: true,
    activeKeyId: "key-b",
    keys: [{ id: "key-a", name: "备用 Key" }, { id: "key-b", name: "主 Key" }],
  });
  await load();
  summary.textContent = "正在读取当前供应商…";
  list.innerHTML = "";
  await refreshOnOpen();
  assert.equal(requestCount(), 0);
  assert.equal(summary.textContent, "当前供应商：示例供应商");
  assert.match(list.innerHTML, /<option value="key-b" selected>主 Key<\/option>/);
});

test("后端已连接但上次读取失败时，面板打开会补拉一次", async () => {
  const { summary, load, refreshOnOpen, requestCount } = relayKeysRuntime({ enabled: true, requestError: "桥接不可用" });
  await load(true);
  assert.equal(requestCount(), 1);
  await refreshOnOpen();
  assert.equal(requestCount(), 2);
  assert.equal(summary.textContent, "桥接不可用");
});

test("后端没连上时不会永远停在占位文字", async () => {
  // 首拉挂在 backendStatus==="ok" 上，所以后端未就绪时必须由面板打开推一次请求，
  // 超时/失败后显示失败文案，而不是把模板里的“正在读取当前供应商…”留在界面上。
  const { summary, refreshOnOpen, requestCount } = relayKeysRuntime({ enabled: true, status: "loading", requestError: "桥接不可用" }, "checking");
  await refreshOnOpen();
  assert.equal(requestCount(), 1);
  assert.equal(summary.textContent, "桥接不可用");
});

test("设置对象按输入身份缓存，热路径不再重复解析", () => {
  // codexPlusSettings() 挂在滚动与逐帧对齐路径上：缓存命中时不能重复 JSON.parse，
  // 并且 localStorage 被别处直接改写、或后端设置对象被替换时都要重算。
  const backendHolder: { current: Record<string, unknown> } = { current: { enhancementsEnabled: true } };
  let reads = 0;
  let parses = 0;
  const realParse = JSON.parse.bind(JSON);
  const runtime = new Function(
    "defaultCodexPlusSettings", "backendCodexPlusSettings", "codexPlusSettingsKey", "localStorage", "window", "backendHolder", "JSON", `
    let codexPlusBackendSettings = backendHolder.current;
    ${section("  // `codexPlusSettings()` 挂在滚动监听和逐帧对齐路径上", "  // Dream skin runtime is adapted from")}
    return {
      codexPlusSettings,
      setBackend: (next) => { codexPlusBackendSettings = next; },
    };
  `)(
    () => ({ conversationView: false }),
    // 真实实现从后端设置里取映射后的值，这里照同样方式跟随 holder，否则看不出重算。
    () => ({ stepwise: backendHolder.current.codexAppStepwiseEnabled !== false }),
    "codex-plus-settings",
    { getItem: () => { reads += 1; return JSON.stringify({ pasteFix: true }); }, setItem: () => {} },
    { __CODEX_PLUS_DREAM_SKIN_THEME__: { id: "skin-a" } },
    backendHolder,
    { parse: (text: string) => { parses += 1; return realParse(text); }, stringify: JSON.stringify },
  );

  assert.equal(runtime.codexPlusSettings().pasteFix, true);
  assert.equal(parses, 1);
  assert.equal(runtime.codexPlusSettings().stepwise, true);
  assert.equal(parses, 1, "第二次调用必须命中缓存，不再解析");

  const nextBackend = { enhancementsEnabled: true, codexAppStepwiseEnabled: false };
  backendHolder.current = nextBackend;
  runtime.setBackend(nextBackend);
  assert.equal(runtime.codexPlusSettings().stepwise, false, "后端设置换对象后要重算");
  assert.equal(parses, 2);
  assert.equal(reads >= 3, true, "每次调用仍会读一次 localStorage 原文用于比较");
});

test("相同目录刷新不重绘菜单，也不重启白名单补扫", async () => {
  let now = 1000;
  let renders = 0;
  let schedules = 0;
  let requests = 0;
  let models = ["custom"];
  const load = new Function("readCodexAppServerPreparation", "Date", "renderCodexPlusMenu", "scheduleCodexModelWhitelistRefresh", `
    ${runtimeSource("codexModelCatalog", "codexModelCatalogLoadedAt", "codexModelCatalogPromise", "codexModelCatalogRetryAt", "codexModelCatalogFailures")}
    const refreshCodexModelQueries = () => {};
    ${section("  async function loadCodexModelCatalog(", "  function codexPlusModelMetadata(")}
    return loadCodexModelCatalog;
  `)(async () => { requests += 1; return { status: "ok", models }; },
    { now: () => now }, () => { renders += 1; }, () => { schedules += 1; });
  await load();
  now += 11000;
  await load();
  assert.equal(requests, 2);
  assert.equal(renders, 1);
  assert.equal(schedules, 1);
  models = ["custom", "new-model"];
  await load(true);
  assert.equal(renders, 2);
  assert.equal(schedules, 2);
});

test("目录请求失败后退避，扫描复用进行中的请求", async () => {
  let now = 1000;
  let requests = 0;
  let resolveRequest: (value: unknown) => void = () => {};
  const load = new Function("readCodexAppServerPreparation", "Date", `
    ${runtimeSource("codexModelCatalog", "codexModelCatalogLoadedAt", "codexModelCatalogPromise", "codexModelCatalogRetryAt", "codexModelCatalogFailures", "loadCodexModelCatalog")}
    const renderCodexPlusMenu = () => {}, scheduleCodexModelWhitelistRefresh = () => {}, refreshCodexModelQueries = () => {};
    return loadCodexModelCatalog;
  `)(() => {
    requests += 1;
    if (requests === 1) return Promise.reject(new Error("offline"));
    return new Promise((resolve) => { resolveRequest = resolve; });
  }, { now: () => now });
  assert.equal((await load()).status, "failed");
  now += 4999;
  await load();
  assert.equal(requests, 1);
  now += 1;
  const retry = load();
  const concurrent = load();
  assert.equal(requests, 2);
  resolveRequest({ status: "ok", models: ["custom"] });
  assert.equal((await retry).status, "ok");
  await concurrent;
  now += 1000;
  await load();
  assert.equal(requests, 2);
});

function refreshRuntime(ready: () => boolean) {
  let now = 1000;
  let passes = 0;
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const schedule = new Function("Date", "window", "runCodexModelWhitelistRefreshPass", `
    let codexModelWhitelistRefreshUntil = 0, codexModelWhitelistRefreshTimer = 0;
    const codexPlusModelUnlockEnabled = () => true, sendCodexPlusDiagnostic = () => {};
    ${section("  function scheduleCodexModelWhitelistRefresh(", "  function refreshCodexModelWhitelistFromScan(")}
    return scheduleCodexModelWhitelistRefresh;
  `)({ now: () => now }, {
    setTimeout(callback: () => void, delay: number) { timers.push({ callback, delay }); return 1; },
  }, () => { passes += 1; return ready(); });
  return {
    schedule,
    timers,
    passes: () => passes,
    tick() { const timer = timers.shift()!; now += timer.delay; timer.callback(); },
  };
}

test("白名单就绪后立即停止补扫", () => {
  const runtime = refreshRuntime(() => true);
  runtime.schedule();
  assert.equal(runtime.passes(), 1);
  assert.equal(runtime.timers.length, 0);
});

test("白名单未就绪时逐步退避，有界补扫且复用定时器", () => {
  const runtime = refreshRuntime(() => false);
  runtime.schedule();
  runtime.schedule();
  assert.equal(runtime.timers.length, 1);
  const delays: number[] = [];
  while (runtime.timers.length) {
    assert.ok(delays.length < 10, "补扫不能无限重试");
    delays.push(runtime.timers[0].delay);
    runtime.tick();
  }
  assert.deepEqual(delays, [120, 240, 480, 960, 1000]);
  assert.equal(runtime.passes(), 6);
});

test("连续页面变化每秒最多触发一次模型扫描", () => {
  let now = 1000;
  let loads = 0;
  let passes = 0;
  const scan = new Function("Date", "loadCodexModelCatalog", "runCodexModelWhitelistRefreshPass", `
    ${runtimeSource("codexModelWhitelistLastScanAt")}
    const ensureCodexModelWhitelistInstalls = () => {}, codexPlusModelUnlockEnabled = () => true;
    ${section("  function refreshCodexModelWhitelistFromScan(", "  function threadIdVariants(")}
    return refreshCodexModelWhitelistFromScan;
  `)({ now: () => now }, () => { loads += 1; }, () => { passes += 1; });
  for (let index = 0; index < 100; index += 1) scan();
  assert.equal(loads, 1);
  assert.equal(passes, 1);
  now += 1000;
  scan();
  assert.equal(loads, 2);
});

test("远程供应商模块失败后退避，页面扫描不会绕过等待", async () => {
  let attempts = 0;
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const install = new Function("window", "loadAppServerRequestCandidates", `
    const codexRemoteSessionProviderPatchEnabled = () => true;
    const codexAppServerModelRequestPatchVersion = "test", sendCodexPlusDiagnostic = () => {};
    ${section("  const appServerModelRequestPatchMaxMisses", "  function ensureCodexModelWhitelistInstalls(")}
    return installAppServerModelRequestPatch;
  `)({
    setTimeout(callback: () => void, delay: number) { timers.push({ callback, delay }); return 1; },
  }, async () => { attempts += 1; return { modules: [] }; });
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  install();
  await settle();
  assert.equal(timers[0].delay, 250);
  for (let index = 0; index < 20; index += 1) install();
  assert.equal(attempts, 1);
  timers.shift()!.callback();
  await settle();
  assert.equal(attempts, 2);
  assert.equal(timers[0].delay, 500);
    for (let index = 0; index < 6; index += 1) {
      timers.shift()!.callback();
      await settle();
    }
    assert.equal(attempts, 8);
    assert.equal(timers.length, 0);
});
