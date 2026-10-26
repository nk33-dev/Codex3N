import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { parseModelMetadataMap, synchronizeModelMetadataLiteSupport } from "./model-metadata.ts";
import { reasoningParameterMode, setModelReasoningParameterMode } from "./model-reasoning.ts";
import { requestCompatibilityEnabled, settingsRequireLocalHelper } from "./model-routes.ts";

test("reasoning modes retain level drafts, round trip and require the helper only when opted in", () => {
  const original = JSON.stringify({ model: { custom: "kept", supported_reasoning_levels: [{ effort: "high" }] }, other: { custom: true } });
  const omitted = setModelReasoningParameterMode(original, "model", "omit");
  assert.equal(reasoningParameterMode(parseModelMetadataMap(omitted).model), "omit");
  assert.deepEqual(parseModelMetadataMap(omitted).model.supported_reasoning_levels, [{ effort: "high" }]);
  const reset = setModelReasoningParameterMode(omitted, "model", "auto");
  assert.deepEqual(JSON.parse(reset), JSON.parse(original));
  const profile = { id: "p", name: "p", protocol: "responses" as const, relayMode: "pureApi" as const, officialMixApiKey: false, modelMetadata: original, apiKey: "fixture-only", baseUrl: "https://example.test" };
  const settings = { activeRelayId: "p", relayProfilesEnabled: true, enhancementsEnabled: false, relayProfiles: [profile] };
  assert.equal(settingsRequireLocalHelper(settings), false);
  assert.equal(settingsRequireLocalHelper({ ...settings, relayProfiles: [{ ...profile, modelMetadata: omitted }] }), true);
  assert.equal(requestCompatibilityEnabled({ ...profile, strictResponsesReasoning: true }), true);
  assert.equal(requestCompatibilityEnabled({ ...profile, relayMode: "official", strictResponsesReasoning: true }), false);
});

test("Lite controls edit one selected model and preserve the rest of an imported document", () => {
  const original = { models: [{ slug: "one", custom: 42 }, { slug: "two", use_responses_lite: false }] };
  const changed = synchronizeModelMetadataLiteSupport(JSON.stringify(original), "one", "supported");
  assert.ok(changed);
  assert.equal(changed.preview.metadata.use_responses_lite, true);
  assert.deepEqual(JSON.parse(changed.document).models[1], original.models[1]);
  const reset = synchronizeModelMetadataLiteSupport(changed.document, "one", "inherit");
  assert.ok(reset);
  assert.deepEqual(JSON.parse(reset.document), original);
  assert.equal(synchronizeModelMetadataLiteSupport('{"models":[{"slug":"one"},{"slug":"one"}]}', "one", "supported"), null);
});

test("language switches persist preferences and notify React without reload or storing drafts", async () => {
  const source = readFileSync(new URL("./i18n.ts", import.meta.url), "utf8");
  const saved = new Map(); let reloads = 0; let calls = 0;
  const exports: Record<string, any> = {};
  const context = vm.createContext({ exports, require: (name: string) => name === "./preferences"
    ? { readPreference: (key: string) => saved.get(key), writePreference: async (key: string, value: string) => { saved.set(key, value); } }
    : ({ EN_PLAIN: { "概览": "Overview" }, EN_BACKEND: {}, EN_BACKEND_PATTERNS: [], EN_TEMPLATE: {} }),
    window: { localStorage: { getItem: (k: string) => saved.get(k), setItem: (k: string, v: string) => saved.set(k, v) }, location: { reload: () => { reloads++; } } } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const unsubscribe = exports.subscribeLanguage(() => { calls++; });
  assert.equal(exports.t("概览"), "概览");
  exports.setLanguage("en"); await Promise.resolve(); assert.equal(exports.t("概览"), "Overview");
  exports.setLanguage("en"); assert.equal(calls, 1);
  exports.setLanguage("zh"); await Promise.resolve(); assert.equal(exports.t("概览"), "概览");
  unsubscribe(); exports.setLanguage("en"); await Promise.resolve(); assert.equal(calls, 2);
  assert.equal(reloads, 0);
  assert.deepEqual([...saved.keys()], ["codex-plus-lang"]);
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(app, /useSyncExternalStore\(subscribeLanguage, getLanguage, getLanguage\)/);
  for (const name of ["App.tsx", "components/ProviderPresetSelector.tsx"]) {
    const file = ts.createSourceFile(name, readFileSync(new URL(`./${name}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(file) === "t") {
        let p: ts.Node | undefined = node.parent; let lazy = false;
        while (p && !ts.isSourceFile(p)) { if (ts.isFunctionLike(p)) { lazy = true; break; } p = p.parent; }
        // 默认供应商名称是配置数据，保持创建时快照；导航/提示标签才需动态翻译。
        const defaultName = node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === "默认中转";
        if (name === "App.tsx" && defaultName) assert.ok(ts.isPropertyAssignment(node.parent), "配置名称不能变成动态 getter");
        const dataSnapshot = name === "App.tsx" && ts.isPropertyAssignment(node.parent)
          && node.parent.name.getText(file) === "name" && defaultName;
        assert.equal(lazy || dataSnapshot, true, `${name} contains a frozen UI label`);
      }
      ts.forEachChild(node, visit);
    }; visit(file);
  }
});

test("active session page receives backend search, loading state and protected project deletion", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let page: ts.JsxSelfClosingElement | undefined;
  const walk = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === "ProjectSessionPage") page = node;
    ts.forEachChild(node, walk);
  };
  walk(file);
  assert.ok(page);
  const attributes = page.attributes.getText(file);
  assert.match(attributes, /loading=\{localSessionsLoading\}/);
  assert.match(attributes, /refreshLocalSessions\(false, offset \?\? 0, query\)/);
  assert.match(attributes, /onDeleteProject=\{actions\.deleteProjectLocalSessions\}/);
  assert.match(attributes, /onArchiveMany=\{actions\.archiveLocalSessions\}/);
});
