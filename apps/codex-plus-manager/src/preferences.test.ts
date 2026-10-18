import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./preferences.ts", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, "").replaceAll("export ", "");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function runtime(disk: { values: Record<string, string>; imported: boolean }, browser: Record<string, string>) {
  const invoke = async (command: string, payload?: { values: Record<string, string> }) => {
    if (command === "load_ui_preferences") return { values: { ...disk.values }, importLegacy: !disk.imported };
    Object.assign(disk.values, payload?.values); disk.imported = true;
  };
  const storage = { length: Object.keys(browser).length, key: (i: number) => Object.keys(browser)[i], getItem: (key: string) => browser[key] ?? null, setItem: (key: string, value: string) => { browser[key] = value; } };
  return new Function("invoke", "localStorage", compiled + "return { initializePreferences, readPreference, writePreference };")(invoke, storage);
}

test("界面偏好一次导入，清空 WebView 后仍从用户配置恢复", async () => {
  const disk = { values: {}, imported: false };
  const first = runtime(disk, { "codex-plus-theme": "light", "codex-plus-lang": "en", unrelated: "ignored" });
  await first.initializePreferences();
  assert.equal(first.readPreference("codex-plus-theme"), "light");
  assert.equal(first.readPreference("unrelated"), null);
  await first.writePreference("codex-plus-relay-fold:models", "false");
  const restart = runtime(disk, {});
  await restart.initializePreferences();
  assert.equal(restart.readPreference("codex-plus-theme"), "light");
  assert.equal(restart.readPreference("codex-plus-relay-fold:models"), "false");
  disk.values = {};
  const reset = runtime(disk, { "codex-plus-theme": "light" });
  await reset.initializePreferences();
  assert.equal(reset.readPreference("codex-plus-theme"), null);
});

test("连续偏好保存保留每个键的最后一次值", async () => {
  const disk = { values: {} as Record<string, string>, imported: true };
  const state = runtime(disk, {});
  await state.initializePreferences();
  await Promise.all([state.writePreference("codex-plus-theme", "light"), state.writePreference("codex-plus-lang", "en"), state.writePreference("codex-plus-theme", "dark")]);
  assert.deepEqual(disk.values, { "codex-plus-theme": "dark", "codex-plus-lang": "en" });
});
