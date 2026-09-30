import assert from "node:assert/strict";
import test from "node:test";

import { readRendererInjectSource } from "./inject-fragments.ts";

const renderer = await readRendererInjectSource();

function section(start: string, end: string) {
  const offset = renderer.indexOf(start);
  const limit = renderer.indexOf(end, offset);
  assert.ok(offset >= 0 && limit > offset);
  return renderer.slice(offset, limit);
}

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

test("模型切换区提供命名 Key 快捷入口", () => {
  assert.match(renderer, /data-codex-relay-api-key-badge/);
  assert.match(renderer, /openCodexPlusPage\("apiKeys"\)/);
  assert.match(renderer, /\/relay-api-keys\/select/);
});

/** 用注入脚本里真实的 Key 面板渲染与加载逻辑搭建一个最小运行环境。 */
function relayKeysRuntime(state: { enabled: boolean; activeKeyId?: string; keys?: unknown[]; switching?: boolean; liveKeyMatched?: boolean }) {
  const summary = { textContent: "正在读取当前供应商…" };
  const list = { textContent: "", innerHTML: "" };
  let requests = 0;
  const serialize = (value: unknown) => String(value);
  const load = new Function("document", "postJson", "escapeHtml", "refreshCodexRelayApiKeyBadges", `
    let codexPlusRelayApiKeys = ${JSON.stringify({
      status: "ok",
      providerId: "relay-1",
      providerName: "示例供应商",
      activeKeyId: "",
      keys: [],
      ...state,
    })};
    let codexPlusRelayApiKeySwitching = ${state.switching ? "true" : "false"};
    let codexPlusRelayApiKeysPromise = null;
    ${section("  function renderRelayApiKeys(", "  function selectCodexPlusTab(")}
    return loadRelayApiKeys;
  `)(
    { querySelector: (selector: string) => (selector.includes("summary") ? summary : selector.includes("list") ? list : null) },
    async () => { requests += 1; return { status: "ok" }; },
    serialize,
    () => {},
  );
  return { summary, list, load, requestCount: () => requests };
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
  const load = new Function("postJson", "Date", "renderCodexPlusMenu", "scheduleCodexModelWhitelistRefresh", `
    let codexModelCatalog = {}, codexModelCatalogLoadedAt = 0, codexModelCatalogPromise = null;
    let codexModelCatalogRetryAt = 0, codexModelCatalogFailures = 0;
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
    let codexModelWhitelistLastScanAt = 0;
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
