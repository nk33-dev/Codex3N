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
