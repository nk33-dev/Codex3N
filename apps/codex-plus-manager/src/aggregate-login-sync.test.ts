import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { isAggregateProfile, normalizeAggregateDefaultRelayId, normalizeAggregateMembers } from "./aggregate-members.ts";
import { clampAggregateRoutePriority, normalizeAggregateRoutes } from "./aggregate-routes.ts";

test("聚合登录同步开关经过回填、标准化和保存镜像后保持选择", async () => {
  const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  const app = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set([
    "hydrateAggregateRelayProfile", "normalizeAggregateConfig", "normalizeAggregateProfilesFromRelayProfiles",
    "clampAggregateWeight", "normalizeRelaySessionProvider", "isAggregateRelayProfile",
  ]);
  const functions = app.statements.filter((node) => ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? ""));
  assert.equal(functions.length, names.size);
  const strategies = app.statements.find((node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((entry) => ts.isIdentifier(entry.name) && entry.name.text === "aggregateStrategyOptions"));
  assert.ok(strategies);
  const compiled = ts.transpileModule([...functions, strategies].map((node) => node.getText(app)).join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const runtime = new Function(
    "isAggregateProfile", "normalizeAggregateDefaultRelayId", "normalizeAggregateMembers",
    "clampAggregateRoutePriority", "normalizeAggregateRoutes", "t",
    `${compiled}\nreturn { hydrateAggregateRelayProfile, normalizeAggregateConfig, normalizeAggregateProfilesFromRelayProfiles };`,
  )(isAggregateProfile, normalizeAggregateDefaultRelayId, normalizeAggregateMembers,
    clampAggregateRoutePriority, normalizeAggregateRoutes, (value: string) => value);

  for (const enabled of [true, false, undefined]) {
    const mirror = {
      id: "aggregate", name: "聚合", strategy: "failover", modelAggregationEnabled: true,
      members: [{ relayId: "official", weight: 1 }], defaultRelayId: "official",
      syncDefaultMemberLogin: enabled,
    };
    const loaded = runtime.hydrateAggregateRelayProfile({ id: "aggregate" }, mirror);
    const normalized = runtime.normalizeAggregateConfig(loaded.aggregate, [], new Set(["official"]));
    const saved = runtime.normalizeAggregateProfilesFromRelayProfiles([{ ...loaded, aggregate: normalized }]);
    const reloaded = runtime.hydrateAggregateRelayProfile({ id: "aggregate" }, JSON.parse(JSON.stringify(saved))[0]);
    assert.equal(reloaded.aggregate.syncDefaultMemberLogin, enabled === true);
    assert.equal(reloaded.aggregate.defaultRelayId, "official");
    assert.deepEqual(reloaded.aggregate.members, [{ profileId: "official", weight: 1 }]);
  }
});
