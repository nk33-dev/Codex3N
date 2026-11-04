// Verifies the English dictionary (src/i18n-en.ts) covers exactly the keys that
// are actually referenced by t("…") / tf("…") calls in the frontend source — no
// missing keys, no stale extras. Scanning real call sites (rather than trusting
// tools/i18n-keys.json) means hand-added wrapped strings are validated too, not
// just the codemod's output.
//
// Run after editing the dictionary, adding a t()/tf() call, or re-running the
// codemod:
//   node tools/i18n-verify.mjs

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tourSteps } from "../apps/codex-plus-manager/src/onboarding-model.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const appRoot = path.join(repoRoot, "apps", "codex-plus-manager");
const require = createRequire(path.join(appRoot, "package.json"));
const ts = require("typescript");

const SRC_FILES = [
  "src/App.tsx",
  "src/prompt-tools.tsx",
  "src/PluginMarketScreen.tsx",
  "src/ManagementPages.tsx",
  "src/ManagementExtra.tsx",
  "src/ProjectSessionPage.tsx",
  "src/SessionBackups.tsx",
  "src/ComputerUsePage.tsx",
  "src/ComputerUsePreview.tsx",
  "src/CuPipWindow.tsx",
  "src/AgentCollaborationPage.tsx",
  "src/update-notification.ts",
  "src/route-subtitle.ts",
  "src/launch-status.ts",
  "src/agent-cache.tsx",
  "src/components/ProviderPresetSelector.tsx",
  "src/components/providers/ProviderImportActions.tsx",
  "src/components/providers/EnvConflictNotice.tsx",
  "src/components/providers/RelayProfileList.tsx",
  "src/components/ui/manager-primitives.tsx",
  "src/screens/ClaudeSessionsScreen.tsx",
  "src/lib/default-settings.ts",
  "src/provider-utils.ts",
  "src/AgentDashboard.tsx",
  "src/AgentFocusDialog.tsx",
  "src/AgentDisconnectDialog.tsx",
  "src/OnboardingSetup.tsx",
  "src/CommunityExtensionsPanel.tsx",
  "src/CuratedPackages.tsx",
  "src/DshPluginsPanel.tsx",
  "src/ExtensionCard.tsx",
  "src/ExtensionCuration.tsx",
  "src/ExtensionManagerPanel.tsx",
  "src/ExtensionPublishDialog.tsx",
  "src/MyPublishedPanel.tsx",
  "src/ProviderMetaSyncDialog.tsx",
  "src/provider-meta-sync-model.ts",
  "src/RequestFlow.tsx",
  "src/cx-layout.tsx",
  "src/extension-config-form.tsx",
  "src/agent-focus-model.ts",
  "src/agent-focus-store.ts",
  "src/AppSelect.tsx",
  "src/CommandPalette.tsx",
  "src/GatewayAgents.tsx",
  "src/GatewayModelMatrix.tsx",
  "src/GatewayPage.tsx",
  "src/GatewayProviders.tsx",
  "src/GatewaySessions.tsx",
  "src/GatewayUsage.tsx",
  "src/HubOverview.tsx",
  "src/OnboardingTour.tsx",
  "src/ProviderExtrasDialog.tsx",
  "src/ProviderFormDialog.tsx",
  "src/ProviderModelsDialog.tsx",
  "src/ProviderKeyList.tsx",
  "src/ProviderSyncDialog.tsx",
  "src/ProviderTestDialog.tsx",
  "src/RelayBillingLine.tsx",
  "src/provider-test.ts",
  "src/history-recovery-report.ts",
  "src/ProviderReasoningDialog.tsx",
  "src/ProviderWindowsDialog.tsx",
  "src/SessionAgentTabs.tsx",
  "src/TrayPanel.tsx",
  "src/UsageTabs.tsx",
  "src/app-dialog.tsx",
  "src/gateway-ui.tsx",
  "src/vlm-test-translation.ts",
];

// ── Collect the keys referenced by t()/tf() across the source. ──────────────
const usedPlain = new Set();
const usedTemplate = new Set();

function scanFile(relPath) {
  const abs = path.join(appRoot, relPath);
  const text = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const fn = node.expression.text;
      const arg = node.arguments[0];
      const literal =
        arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : null;
      if (literal !== null) {
        // tr 是 vlm-test-translation.ts 注入的翻译回调：1 参->plain，2 参->template。
        const probeHint = relPath === "src/provider-test.ts" && fn === "hint";
        if (fn === "t" || ((fn === "tr" || probeHint) && node.arguments.length === 1)) usedPlain.add(literal);
        else if (fn === "tf" || ((fn === "tr" || probeHint) && node.arguments.length >= 2)) usedTemplate.add(literal);
      }
      if (arg && ts.isConditionalExpression(arg) && (fn === "t" || fn === "tf")) {
        const collect = (value) => {
          if (ts.isStringLiteralLike(value)) (fn === "t" ? usedPlain : usedTemplate).add(value.text);
          else if (ts.isConditionalExpression(value)) { collect(value.whenTrue); collect(value.whenFalse); }
        };
        collect(arg);
      }
    }
    if (relPath === "src/AgentFocusDialog.tsx" && ts.isPropertyAssignment(node)
      && ["name", "hint"].includes(node.name.getText(sf)) && ts.isStringLiteralLike(node.initializer)) {
      usedPlain.add(node.initializer.text);
    }
    if (relPath === "src/provider-meta-sync-model.ts" && ts.isFunctionDeclaration(node)
      && ["currentSourceLabel", "ignoredReasonLabel"].includes(node.name?.text)) {
      const collect = (child) => {
        if (ts.isStringLiteralLike(child) && /\p{Script=Han}/u.test(child.text)) usedPlain.add(child.text);
        ts.forEachChild(child, collect);
      };
      collect(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

for (const f of SRC_FILES) scanFile(f);
for (const steps of [tourSteps(null), tourSteps("Codex"), tourSteps(null, true)]) {
  for (const step of steps) {
    (step.args && !step.plainTitle ? usedTemplate : usedPlain).add(step.title);
    (step.args ? usedTemplate : usedPlain).add(step.body);
  }
}

// 增强设置项清单的文案在管理器里以 t(item.title) 这类动态参数翻译，扫描调用点看不到，
// 这里按 src/enhancement-catalog.ts 的 enhancementCatalogStrings() 同样的字段补进来。
const catalog = JSON.parse(
  readFileSync(path.join(repoRoot, "crates", "codex-plus-core", "assets", "enhancement-settings.json"), "utf8"),
);
for (const group of catalog.groups) {
  usedPlain.add(group.title);
  if (group.description) usedPlain.add(group.description);
}
for (const item of catalog.items) {
  usedPlain.add(item.title);
  usedPlain.add(item.description);
  if (item.descriptionWhenEnhancementsOn) usedPlain.add(item.descriptionWhenEnhancementsOn);
  for (const option of item.options ?? []) usedPlain.add(option.label);
}
for (const builtin of catalog.builtins ?? []) {
  usedPlain.add(builtin.title);
  usedPlain.add(builtin.description);
}

// ── Read the dictionary keys out of i18n-en.ts. ─────────────────────────────
const dictSource = readFileSync(path.join(appRoot, "src", "i18n-en.ts"), "utf8");

function recordKeys(varName) {
  const re = new RegExp(`export const ${varName}\\s*:\\s*Record<string,\\s*string>\\s*=\\s*\\{`);
  const match = re.exec(dictSource);
  if (!match) throw new Error(`Could not find ${varName} in i18n-en.ts`);
  const start = match.index + match[0].length - 1; // position of "{"
  let depth = 0;
  let i = start;
  let inStr = null;
  let escaped = false;
  for (; i < dictSource.length; i++) {
    const ch = dictSource[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") inStr = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  const literal = dictSource.slice(start, i);
  // eslint-disable-next-line no-eval
  const obj = (0, eval)(`(${literal})`);
  return new Set(Object.keys(obj));
}

let ok = true;

function check(label, usedSet, dictSet) {
  const missing = [...usedSet].filter((k) => !dictSet.has(k));
  const extra = [...dictSet].filter((k) => !usedSet.has(k));
  console.log(`${label}: ${usedSet.size} referenced, ${dictSet.size} translated`);
  if (missing.length) {
    ok = false;
    console.log(`  MISSING from dictionary (${missing.length}):`);
    for (const k of missing) console.log(`    ${JSON.stringify(k)}`);
  }
  if (extra.length) {
    ok = false;
    console.log(`  STALE in dictionary (${extra.length}):`);
    for (const k of extra) console.log(`    ${JSON.stringify(k)}`);
  }
}

check("plain", usedPlain, recordKeys("EN_PLAIN"));
check("template", usedTemplate, recordKeys("EN_TEMPLATE"));

if (!ok) {
  console.error("\nDictionary does not match t()/tf() usage in source.");
  process.exit(1);
}
console.log("\nDictionary matches every t()/tf() call site exactly.");
