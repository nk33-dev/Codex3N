import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
function section(start: string, end: string) {
  const offset = source.indexOf(start);
  const limit = source.indexOf(end, offset);
  assert.ok(offset >= 0 && limit > offset);
  return source.slice(offset, limit);
}

const apiModels = ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex-spark", "gpt-image-2", "gpt-image-1.5"];
function runtime({ provider = "crs", status = "ok", hasRoot = true, includeNativeModels = true } = {}) {
  const requests: Array<{ hostId: string; method: string; params: unknown }> = [];
  const invalidations: unknown[] = [];
  let writes = 0;
  const remotes = new Map<string, any>();
  const root = {
    forHost(hostId: string) {
      if (!remotes.has(hostId)) {
        // 模拟新版 Cap'n Web：方法通过 get 动态提供，禁止对代理赋值。
        remotes.set(hostId, new Proxy(() => {}, {
          get(_target, key) {
            if (key === "sendRequest") return async (method: string, params: unknown) => {
              requests.push({ hostId, method, params });
              return method === "model/list" ? {
                data: [...apiModels.slice(0, 5), "gpt-5.2"].map((model) => ({ model, hidden: false, isDefault: model === "gpt-5.5" })),
                nextCursor: "next-page",
              } : { unchanged: true };
            };
            if (key === "getConversation") return (id: string) => ({ id, hostId });
            if (key === "getTurnCoordinator") return () => ({ hostId, coordinator: true });
            return undefined;
          },
          set() { writes += 1; throw Error("Can't define properties on RPC stubs."); },
          defineProperty() { writes += 1; throw Error("Can't define properties on RPC stubs."); },
        }));
      }
      return remotes.get(hostId);
    },
  };
  const token = { __scopeBrand: "AppScope" };
  const signal = { scope: token };
  const atom = {};
  const node = { token, signalBindings: new WeakMap([[signal, atom]]), store: { get: () => root },
    queryClient: { invalidateQueries: (filter: unknown) => { invalidations.push(filter); return Promise.resolve(); } } };
  const fiber = { child: { memoizedProps: { value: new Map([[token, node]]) } } };
  const windowValue = hasRoot ? { __codexRoot: { _internalRoot: { current: fiber } } } : {};
  const create = new Function("window", "models", "provider", "status", "includeNativeModels", `
    const codexPlusSettings = () => ({ includeNativeModels });
    const codexModelCatalog = { status, model_provider: provider, sources: [{ type: 'config', status, models: models.length }] };
    const codexPlusModelNames = () => models;
    const codexPlusModelUnlockEnabled = () => true;
    const codexPlusModelMetadata = () => null, modelReasoningEfforts = () => [];
    const applyCodexPlusModelMetadata = () => false, sendCodexPlusDiagnostic = () => {};
    const codexAppServerModelRequestPatchVersion = '8';
    const codexRemoteSessionProviderRequestMethod = () => false;
    const applyCodexRemoteSessionProviderOverride = (_method, params) => params;
    const refreshCodexThreadModelBeforeTurn = async () => null;
    const codexThreadModelRequestState = () => ({});
    const loadCodexModelCatalog = async () => codexModelCatalog;
    ${section("  const codexAppServerRpcRoots", "  async function loadAppServerRequestModules(")}
    ${section("  function codexPlusModelDescriptor(", "  function patchModelContainer(")}
    ${section("  function appServerModelRequestMethod(", "  function codexPerModelContextEnabled(")}
    ${section("  function patchAppServerModelRequestClient(", "  const appServerModelRequestPatchMaxMisses")}
    return { collectScopedAppServerRequestCandidates, refreshCodexModelQueries, codexAppScopeNodes,
      setIncludeNativeModels: value => { includeNativeModels = value; } };
  `);
  return { ...create(windowValue, apiModels, provider, status, includeNativeModels), root, signal, requests, invalidations, writes: () => writes };
}

test("从已挂载作用域发现 RPC，8 个供应商模型进入原生 model/list", async () => {
  const app = runtime({ includeNativeModels: false });
  const ignored = { scope: app.signal.scope, resolve() { throw Error("不应初始化其他信号"); } };
  const clients = app.collectScopedAppServerRequestCandidates([{ renamedRpcSignal: app.signal, ignored }]);
  assert.equal(clients.length, 1);
  const result = await app.root.forHost("local").sendRequest("model/list", { limit: 100 });
  assert.deepEqual(result.data.map((item: { model: string }) => item.model), apiModels);
  assert.equal(result.nextCursor, "next-page");
  assert.equal(result.data.find((item: { model: string }) => item.model === "gpt-5.5").isDefault, true);
  assert.equal(app.writes(), 0);
  assert.deepEqual(app.invalidations, [{ queryKey: ["models", "list", "local"] }]);
});

test("RPC 适配去重并保留其他方法与原始参数", async () => {
  const app = runtime();
  app.collectScopedAppServerRequestCandidates([{ signal: app.signal }]);
  app.collectScopedAppServerRequestCandidates([{ signal: app.signal }]);
  const client = app.root.forHost("local");
  assert.equal(app.root.forHost("local"), client);
  assert.equal(app.invalidations.length, 1);
  assert.deepEqual(client.getConversation("test"), { id: "test", hostId: "local" });
  assert.deepEqual(client.getTurnCoordinator(), { hostId: "local", coordinator: true });
  const params = { cwd: "/project" };
  assert.deepEqual(await client.sendRequest("config/read", params), { unchanged: true });
  assert.equal(app.requests[0].params, params);
});

test("本机供应商模型不会注入远程主机", async () => {
  const app = runtime();
  app.collectScopedAppServerRequestCandidates([{ signal: app.signal }]);
  const result = await app.root.forHost("remote-host").sendRequest("model/list", {});
  assert.equal(result.data.length, 6);
  assert.equal(result.data.at(-1).model, "gpt-5.2");
});

test("官方目录与上游失败时保留原生模型，根节点未挂载时不操作", async () => {
  for (const options of [{ provider: "openai" }, { status: "failed" }]) {
    const app = runtime({ ...options, includeNativeModels: false });
    app.collectScopedAppServerRequestCandidates([{ signal: app.signal }]);
    const result = await app.root.forHost("local").sendRequest("model/list", {});
    assert.ok(result.data.some((item: { model: string }) => item.model === "gpt-5.2"));
  }
  const app = runtime({ hasRoot: false });
  assert.deepEqual(app.collectScopedAppServerRequestCandidates([{ signal: app.signal }]), []);
  assert.equal(app.invalidations.length, 0);
});

test("默认混入原生模型，取消及重新勾选后可切换列表且不重复模型", async () => {
  const app = runtime();
  app.collectScopedAppServerRequestCandidates([{ signal: app.signal }]);
  const client = app.root.forHost("local");
  const names = async () => (await client.sendRequest("model/list", {})).data.map((item: { model: string }) => item.model);
  const initial = await names();
  assert.equal(initial.length, 9);
  assert.equal(new Set(initial).size, 9);
  assert.ok(initial.includes("gpt-5.2"));
  app.setIncludeNativeModels(false);
  assert.deepEqual(await names(), apiModels);
  app.setIncludeNativeModels(true);
  assert.deepEqual(await names(), initial);
});

test("后端设置变化时刷新模型查询，相同设置不重复刷新", async () => {
  let includeNativeModels = true;
  let refreshes = 0;
  const load = new Function("postJson", "refreshCodexModelQueries", `
    const codexPlusBackendSettingsSeq = 0;
    let codexPlusBackendSettings = { enhancementsEnabled: true }, codexPlusBackendSettingsLoaded = false;
    ${section("  async function loadBackendSettingsState(", "  async function loadBackendSettings(")}
    return loadBackendSettingsState;
  `)(async () => ({ enhancementsEnabled: true, codexAppIncludeNativeModels: includeNativeModels }), () => { refreshes += 1; });
  await load();
  assert.equal(refreshes, 0);
  includeNativeModels = false;
  await load();
  await load();
  assert.equal(refreshes, 1);
  includeNativeModels = true;
  await load();
  assert.equal(refreshes, 2);
});
