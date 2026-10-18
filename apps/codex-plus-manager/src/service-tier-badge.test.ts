import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

test("重新注入移除旧服务模式控件", () => {
  const source = readFileSync(new URL("../../../assets/inject/renderer-inject/90-action-groups.js", import.meta.url), "utf8");
  const fn = source.match(/^  function removeLegacyCodexServiceTierBadges\([^]*?^  \}/m)?.[0];
  assert.ok(fn);
  let removed = 0;
  const context = vm.createContext({ document: { querySelectorAll: () => [{ remove: () => removed++ }] }, codexServiceTierBadgeClass: "codex-plus-service-tier-badge" });
  vm.runInContext(fn + ";removeLegacyCodexServiceTierBadges();", context);
  assert.equal(removed, 1);
});
