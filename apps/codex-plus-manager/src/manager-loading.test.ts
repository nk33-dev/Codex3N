import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeManager, loadManagerPage, type ManagerPageLoaders } from "./manager-loading.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function pageLoaders(calls: string[], overrides: Partial<ManagerPageLoaders> = {}): ManagerPageLoaders {
  return new Proxy(overrides as ManagerPageLoaders, {
    get(target, key: keyof ManagerPageLoaders) {
      return async () => { calls.push(key); return target[key]?.(); };
    },
  });
}

test("启动公共请求并行，工具摘要等设置初始化完成后读取", async () => {
  const settings = deferred();
  const overview = deferred();
  const calls: string[] = [];
  const startup = initializeManager({
    startup: async () => { calls.push("startup"); return { showUpdate: true }; },
    settings: () => { calls.push("settings"); return settings.promise; },
    overview: () => { calls.push("overview"); return overview.promise; },
    tools: async () => { calls.push("tools"); },
  });
  assert.deepEqual(calls, ["startup", "settings", "overview"]);
  settings.resolve();
  await settings.promise;
  assert.ok(calls.includes("tools"));
  overview.resolve();
  assert.deepEqual(await startup, { showUpdate: true });
});

test("首页启动不请求其他页面，增强页按需读取远端市场", async () => {
  const calls: string[] = [];
  const loaders = pageLoaders(calls);
  await loadManagerPage("overview", loaders, new Set(["settings", "overview"]));
  assert.deepEqual(calls, []);
  await loadManagerPage("enhance", loaders);
  assert.deepEqual(calls, ["settings", "remotePluginMarketplace"]);
});

test("会话列表与设置并行，供应商默认选择等待设置完成", async () => {
  const calls: string[] = [];
  const settings = deferred();
  const loading = loadManagerPage("sessions", pageLoaders(calls, { settings: () => settings.promise }));
  assert.deepEqual(calls, ["settings", "sessions"]);
  settings.resolve();
  await loading;
  assert.deepEqual(calls, ["settings", "sessions", "providerSyncTargets"]);
});

test("脚本市场保留写入顺序，避免库存被旧设置覆盖", async () => {
  const calls: string[] = [];
  const market = deferred();
  const loading = loadManagerPage("userScripts", pageLoaders(calls, { scriptMarket: () => market.promise }));
  assert.deepEqual(calls, ["settings"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["settings", "scriptMarket"]);
  market.resolve();
  await loading;
  assert.deepEqual(calls, ["settings", "scriptMarket", "userScriptInventory"]);
});

test("切换页面后不再启动旧页面的后续批次", async () => {
  const calls: string[] = [];
  const settings = deferred();
  let current = true;
  const loading = loadManagerPage("sessions", pageLoaders(calls, { settings: () => settings.promise }), undefined, () => current);
  current = false;
  settings.resolve();
  await loading;
  assert.deepEqual(calls, ["settings", "sessions"]);
});

test("皮肤本地状态不等待远程市场响应", async () => {
  const calls: string[] = [];
  const market = deferred();
  const loading = loadManagerPage("dreamSkin", pageLoaders(calls, { dreamSkinMarket: () => market.promise }));
  assert.ok(calls.includes("dreamSkinStatus"));
  assert.ok(calls.includes("dreamSkinLibrary"));
  market.resolve();
  await loading;
});

test("社区主题确认后补齐市场，不重复读取已加载的主题草稿", async () => {
  const calls: string[] = [];
  await loadManagerPage("dreamSkin", pageLoaders(calls), new Set(["settings", "dreamSkinLibrary", "dreamSkinCommunity"]));
  assert.deepEqual(calls, ["overview", "dreamSkinMarket", "dreamSkinStatus"]);
});

test("微信页面的状态交给可见性调度，页面加载不重复查询", async () => {
  const calls: string[] = [];
  await loadManagerPage("weixin", pageLoaders(calls));
  assert.deepEqual(calls, ["settings", "sessions"]);
});
