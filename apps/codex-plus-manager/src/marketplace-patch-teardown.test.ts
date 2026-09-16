import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

import { injectAssetUrl } from "./inject-fragments.ts";

/**
 * 插件市场补丁必须能真正还原。
 *
 * 以前 `clearPluginPatchArtifacts()` 是空函数，而 `scanDeferred()` 在 relay 模式下
 * 每轮都会调它。结果是「切到 relay 模式 / 关掉插件市场解锁」之后，
 * `Array.prototype.filter`、`window.dispatchEvent`、`electronBridge.sendMessageFromView`
 * 以及被改写的 RPC `sendRequest` 会一直保持被替换的状态：开关看起来关掉了，实际仍在生效。
 */

const FRAGMENT = "renderer/marketplace/plugin-bridge.js";
const TAIL_MARKER = "  const pluginMarketplaceRequestPatchMaxMisses = ";

function slice(source: string, startMarker: string, endMarker: string, label: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${label} 片段未找到`);
  return source.slice(start, end);
}

function marketplacePatchRuntime(source: string) {
  const filterChunk = slice(
    source,
    "  function installPluginBuildFlavorFilterPatch() {",
    "\n  function restorePluginMarketplaceRequestParams(",
    "build flavor filter",
  );
  const bridgeChunk = source.slice(
    source.indexOf("  function installPluginMarketplaceBridgePatch() {"),
    source.indexOf(TAIL_MARKER),
  );
  assert.ok(bridgeChunk.length > 0, "bridge / window event 片段未找到");
  const tailChunk = source.slice(source.indexOf(TAIL_MARKER));
  assert.ok(tailChunk.length > 0, "补丁生命周期片段未找到");

  const diagnostics: string[] = [];
  const listeners = new Set<unknown>();
  const dispatchEvent = function originalDispatchEvent() {};
  const sendMessageFromView = function originalSendMessageFromView() {};
  const window: Record<string, unknown> = {
    dispatchEvent,
    electronBridge: { sendMessageFromView },
    addEventListener: (_type: string, handler: unknown) => listeners.add(handler),
    removeEventListener: (_type: string, handler: unknown) => listeners.delete(handler),
  };

  const patchedClients: Array<{ client: Record<string, unknown>; original: unknown }> = [];
  const candidate: Record<string, unknown> = {
    sendRequest: function realSendRequest() {},
  };

  const factory = new Function(
    "window",
    "codexPluginMarketplaceUnlockVersion",
    "codexPlusBackendSettingsLoaded",
    "codexPlusBackendSettings",
    "codexPlusSettings",
    "isCodexPluginBuildFlavorFilter",
    "isCodexPluginMarketplaceHiddenFilter",
    "patchPluginMarketplaceRequestMessage",
    "patchPluginMarketplaceResponseData",
    "loadAppServerRequestCandidates",
    "patchPluginMarketplaceRequestClient",
    "sendCodexPlusDiagnostic",
    `${filterChunk}\n${bridgeChunk}\n${tailChunk}\nreturn { installPluginBuildFlavorFilterPatch, installPluginMarketplaceBridgePatch, installPluginMarketplaceWindowEventPatchOnly, installPluginMarketplaceRequestPatch, clearPluginPatchArtifacts };`,
  );

  const api = factory(
    window,
    1,
    true,
    { launchMode: "official" },
    () => ({ pluginMarketplaceUnlock: true }),
    () => false,
    () => false,
    (message: unknown) => message,
    () => false,
    async () => ({ modules: [{}], candidates: [candidate], sources: [], discovery: "fallback" }),
    (client: Record<string, unknown>) => {
      const original = client.sendRequest;
      client.__codexPluginMarketplaceOriginalSendRequest = original;
      client.sendRequest = function patchedSendRequest() {};
      patchedClients.push({ client, original });
      return true;
    },
    (event: string) => diagnostics.push(event),
  ) as {
    installPluginBuildFlavorFilterPatch: () => void;
    installPluginMarketplaceBridgePatch: () => void;
    installPluginMarketplaceWindowEventPatchOnly: () => void;
    installPluginMarketplaceRequestPatch: () => void;
    clearPluginPatchArtifacts: () => void;
  };

  return { api, window, dispatchEvent, sendMessageFromView, listeners, diagnostics, patchedClients };
}

describe("插件市场补丁还原", () => {
  it("clearPluginPatchArtifacts 不再是空函数", async () => {
    const source = await readFile(injectAssetUrl(FRAGMENT), "utf8");
    assert.doesNotMatch(source, /function clearPluginPatchArtifacts\(\)\s*\{\s*\}/);
    const body = slice(
      source,
      "  function clearPluginPatchArtifacts() {",
      "\n  }",
      "clearPluginPatchArtifacts 函数体",
    );
    for (const call of [
      "restorePluginBuildFlavorFilterPatch()",
      "restorePluginMarketplaceWindowEventPatch()",
      "restorePluginMarketplaceBridgePatch()",
      "restorePluginMarketplaceRequestPatch()",
    ]) {
      assert.ok(body.includes(call), `clearPluginPatchArtifacts 必须调用 ${call}`);
    }
  });

  it("补丁还原依赖的原始值标记与真实实现一致", async () => {
    const source = await readFile(injectAssetUrl(FRAGMENT), "utf8");
    // 还原函数按这些属性名取回原值，真实打补丁的代码必须写同样的名字。
    assert.ok(source.includes("client.__codexPluginMarketplaceRawSendRequest = client.sendRequest;"));
    assert.ok(source.includes("client.__codexPluginMarketplaceOriginalSendRequest = originalSendRequest;"));
    assert.ok(source.includes("bridge.__codexPluginMarketplaceRawSendMessageFromView = originalSendMessageFromView;"));
    assert.ok(source.includes("bridge.__codexPluginMarketplaceOriginalSendMessageFromView"));
    assert.ok(source.includes("window.__codexPluginMarketplaceOriginalDispatchEvent"));
    assert.ok(source.includes("Array.prototype.__codexPluginBuildFlavorOriginalFilter"));
  });

  it("关闭插件市场解锁或切到 relay 模式后把宿主对象改回原样", async () => {
    const source = await readFile(injectAssetUrl(FRAGMENT), "utf8");
    const runtime = marketplacePatchRuntime(source);
    const originalFilter = Array.prototype.filter;
    const bridge = runtime.window.electronBridge as Record<string, unknown>;

    try {
      runtime.api.installPluginBuildFlavorFilterPatch();
      runtime.api.installPluginMarketplaceBridgePatch();
      runtime.api.installPluginMarketplaceWindowEventPatchOnly();
      runtime.api.installPluginMarketplaceRequestPatch();
      await Promise.resolve();
      await Promise.resolve();

      assert.notEqual(Array.prototype.filter, originalFilter, "filter 补丁应先装上");
      assert.notEqual(runtime.window.dispatchEvent, runtime.dispatchEvent, "dispatchEvent 补丁应先装上");
      assert.notEqual(bridge.sendMessageFromView, runtime.sendMessageFromView, "bridge 补丁应先装上");
      assert.equal(runtime.listeners.size, 1, "message 监听应先装上");
      assert.equal(runtime.patchedClients.length, 1, "RPC sendRequest 补丁应先装上");
      const patched = runtime.patchedClients[0];
      assert.notEqual(patched.client.sendRequest, patched.original, "sendRequest 应已被替换");

      runtime.api.clearPluginPatchArtifacts();

      assert.equal(Array.prototype.filter, originalFilter, "filter 必须还原");
      assert.equal(runtime.window.dispatchEvent, runtime.dispatchEvent, "dispatchEvent 必须还原");
      assert.equal(bridge.sendMessageFromView, runtime.sendMessageFromView, "bridge 必须还原");
      assert.equal(runtime.listeners.size, 0, "message 监听必须摘掉");
      assert.equal(patched.client.sendRequest, patched.original, "sendRequest 必须还原");
      assert.ok(
        runtime.diagnostics.includes("plugin_marketplace_patches_cleared"),
        "真正撤掉补丁后应上报一次诊断",
      );

      // 每轮 scan 都会调它：没有东西可撤时不能再刷诊断。
      const diagnosticCount = runtime.diagnostics.length;
      runtime.api.clearPluginPatchArtifacts();
      assert.equal(runtime.diagnostics.length, diagnosticCount, "重复清理不应重复上报");
    } finally {
      Array.prototype.filter = originalFilter;
      runtime.api.clearPluginPatchArtifacts();
    }
  });

  it("还原后重新开启仍然能再次装上补丁", async () => {
    const source = await readFile(injectAssetUrl(FRAGMENT), "utf8");
    const runtime = marketplacePatchRuntime(source);
    const originalFilter = Array.prototype.filter;

    try {
      runtime.api.installPluginBuildFlavorFilterPatch();
      const patchedFilter = Array.prototype.filter;
      assert.notEqual(patchedFilter, originalFilter);

      runtime.api.clearPluginPatchArtifacts();
      assert.equal(Array.prototype.filter, originalFilter);

      runtime.api.installPluginBuildFlavorFilterPatch();
      assert.notEqual(Array.prototype.filter, originalFilter, "清理后必须能重新装上");
    } finally {
      Array.prototype.filter = originalFilter;
      runtime.api.clearPluginPatchArtifacts();
    }
  });
});
