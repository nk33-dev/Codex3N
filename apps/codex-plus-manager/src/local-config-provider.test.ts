import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

test("官方供应商的本机配置在前端标准化后仍可编辑和切换", async () => {
  const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function normalizeRelayProfile(");
  const end = source.indexOf("function hydrateAggregateRelayProfile(", start);
  const usesStart = source.indexOf("function relayProfileUsesLiveFiles(");
  const usesEnd = source.indexOf("function authJsonHasOpenAiApiKey(", usesStart);
  assert.ok(start >= 0 && end > start && usesStart >= 0 && usesEnd > usesStart);
  const compiled = ts.transpileModule(source.slice(start, end) + source.slice(usesStart, usesEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const runtime = new Function(`
    const defaultSettings = { relayBaseUrl: "" };
    const emptyContextSelection = () => ({}), normalizeContextSelection = () => ({});
    const normalizeRelayMode = value => value;
    const relaySessionProvider = () => "openai";
    const buildOfficialRelayAuthJson = value => value;
    const deriveRelayProfileFromFiles = value => value;
    ${compiled}
    return { normalizeRelayProfile, relayProfileUsesLiveFiles };
  `)();
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
