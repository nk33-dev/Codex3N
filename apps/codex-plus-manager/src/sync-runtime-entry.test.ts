import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const fragment = (name: string) => readFileSync(new URL(`../../../assets/inject/renderer-inject/${name}`, import.meta.url), "utf8");

test("提示词工具通过同一延迟扫描安装，侧栏独立更新不重装", () => {
  const source = fragment("95-conversation-view.js");
  const parsed = ts.createSourceFile("scan.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const scan = parsed.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "scanDeferred");
  assert.ok(scan);
  let installs = 0, extensionScans = 0;
  const runtime = new Function("installCodexPlusPromptEnhance", "runScanStep", "runCodexPlusScanSteps", "sessionRows", "updateDeleteButtonOffsets", "archivedPageRows", "removeLegacyCodexServiceTierBadges", "refreshCodexModelWhitelistFromScan", "window", "tryAttachButton", "attachArchivedPageDeleteButton",
    `${scan.getText(parsed)} return scanDeferred;`,
  )(
    () => installs++, (step: () => void) => step(), () => extensionScans++, () => [], () => {}, () => [], () => {}, () => {}, {}, () => {}, () => {},
  );
  runtime({ sidebar: true });
  assert.equal(installs, 0);
  runtime({ conversation: true });
  runtime({ shell: true });
  assert.equal(installs, 2);
  assert.equal(extensionScans, 3);
  const preparation = fragment("30-service-tier.js");
  assert.equal((preparation.match(/runScanStep\(installCodexPlusPromptEnhance\)/g) ?? []).length, 2);
});

test("会话目标分片随真实清单装入，模型扫描只安装一次", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../../../assets/inject/renderer-inject/manifest.json", import.meta.url), "utf8"));
  const goal = manifest.fragments.find((entry: { name: string }) => entry.name === "32-thread-goal.js");
  assert.ok(goal);
  const assembled = readFileSync(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
  assert.ok(assembled.includes(fragment(goal.name)));
  const source = fragment("70-model-catalog.js");
  const ensure = source.match(/^  function ensureCodexModelWhitelistInstalls\([^]*?^  \}/m)?.[0];
  assert.ok(ensure);
  let installed = 0;
  const window = { __codexPlusNativeThreadGoal: { install: async (id: string, options: { hostId: string }) => {
    assert.equal(id, "fixture-thread");
    assert.equal(options.hostId, "local");
    installed++;
  } } };
  const run = new Function("window", "currentSessionRef", "codexPlusModelUnlockEnabled", "codexPluginMarketplacePatchEnabled",
    "codexPlusBackendSettingsLoaded", "codexPlusSettings", "installDictationSupportPatch",
    `${fragment(goal.name)}\n${ensure}\nreturn ensureCodexModelWhitelistInstalls;`,
  )(window, () => ({ session_id: "fixture-thread", host_id: "local" }), () => false, () => false, false, () => ({}), () => {});
  run(); run();
  await new Promise<void>((resolve) => setImmediate(resolve));
  run();
  assert.equal(installed, 1);
});
