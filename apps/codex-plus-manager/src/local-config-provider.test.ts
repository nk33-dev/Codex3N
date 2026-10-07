import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import { relayProfileWithNormalizedApiKeys } from "./provider-api-keys.ts";

test("官方供应商的本机配置在前端标准化后仍可编辑和切换", async () => {
  const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function normalizeRelayProfile(");
  const end = source.indexOf("function hydrateAggregateRelayProfile(", start);
  const usesStart = source.indexOf("function relayProfileUsesLiveFiles(");
  const usesEnd = source.indexOf("function tomlString(", usesStart);
  assert.ok(start >= 0 && end > start && usesStart >= 0 && usesEnd > usesStart);
  const compiled = ts.transpileModule(source.slice(start, end) + source.slice(usesStart, usesEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // 接真实实现而不是桩：命名 Key 的归一化被同步合并弄丢过一次，桩会让这条回归隐身。
  const runtime = new Function("relayProfileWithNormalizedApiKeys", `
    const defaultSettings = { relayBaseUrl: "" };
    const emptyContextSelection = () => ({}), normalizeContextSelection = () => ({});
    const normalizeRelayMode = value => value;
    const relaySessionProvider = () => "openai";
    const buildOfficialRelayAuthJson = value => value;
    const deriveRelayProfileFromFiles = value => value;
    ${compiled}
    return { normalizeRelayProfile, relayProfileUsesLiveFiles };
  `)(relayProfileWithNormalizedApiKeys);
  const config = 'model = "gpt-5.5"\napproval_policy = "never"\n';
  const normalized = runtime.normalizeRelayProfile({
    id: "local", name: "系统默认", relayMode: "official", configContents: config,
    authContents: '{"tokens":{"access_token":"test"}}', useCommonConfig: false,
  });
  assert.equal(normalized.configContents, config);
  assert.equal(normalized.useCommonConfig, false);
  assert.equal(runtime.relayProfileUsesLiveFiles(normalized), true);
  assert.equal(runtime.relayProfileUsesLiveFiles({ ...normalized, configContents: "" }), false);
  assert.doesNotMatch(source, /relay-default-profile/);
});

test("标准化保留命名 Key 并让 apiKey 跟随当前项", async () => {
  const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function normalizeRelayProfile(");
  const end = source.indexOf("function hydrateAggregateRelayProfile(", start);
  const usesStart = source.indexOf("function relayProfileUsesLiveFiles(");
  const usesEnd = source.indexOf("function tomlString(", usesStart);
  const compiled = ts.transpileModule(source.slice(start, end) + source.slice(usesStart, usesEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const runtime = new Function("relayProfileWithNormalizedApiKeys", `
    const defaultSettings = { relayBaseUrl: "" };
    const emptyContextSelection = () => ({}), normalizeContextSelection = () => ({});
    const normalizeRelayMode = value => value;
    const relaySessionProvider = () => "custom";
    const buildOfficialRelayAuthJson = value => value;
    const deriveRelayProfileFromFiles = value => value;
    const normalizeRelayModelRoutes = value => Array.isArray(value) ? value : [];
    ${compiled}
    return { normalizeRelayProfile };
  `)(relayProfileWithNormalizedApiKeys);

  // 保存走整表覆盖，标准化这一步丢掉 apiKeys 就等于下次保存把用户的 Key 清空。
  const withKeys = runtime.normalizeRelayProfile({
    id: "relay-a", name: "A", relayMode: "pureApi", apiKey: "sk-stale",
    apiKeys: [
      { id: "key-a", name: "主账号", apiKey: "sk-a" },
      { id: "key-b", name: "备用", apiKey: "sk-b" },
    ],
    activeApiKeyId: "key-b",
  });
  assert.deepEqual(withKeys.apiKeys.map((entry: { id: string }) => entry.id), ["key-a", "key-b"]);
  assert.equal(withKeys.activeApiKeyId, "key-b");
  assert.equal(withKeys.apiKey, "sk-b");

  // 旧配置只有单个 apiKey 时补成「默认」条目，界面才有可编辑的命名 Key。
  const legacy = runtime.normalizeRelayProfile({
    id: "relay-b", name: "B", relayMode: "pureApi", apiKey: "sk-legacy",
  });
  assert.deepEqual(legacy.apiKeys, [{ id: "default", name: "默认", apiKey: "sk-legacy" }]);
  assert.equal(legacy.activeApiKeyId, "default");
});
