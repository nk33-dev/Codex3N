import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");

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

test("相同目录刷新不重绘菜单，也不重启白名单补扫", async () => {
  let now = 1000;
  let renders = 0;
  let schedules = 0;
  let requests = 0;
  let models = ["custom"];
  const load = new Function("postJson", "Date", "renderCodexPlusMenu", "scheduleCodexModelWhitelistRefresh", `
    let codexModelCatalog = {}, codexModelCatalogLoadedAt = 0, codexModelCatalogPromise = null;
    let codexModelCatalogRetryAt = 0, codexModelCatalogFailures = 0;
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
  for (let index = 0; index < 8; index += 1) {
    timers.shift()!.callback();
    await settle();
  }
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 30000);
});
