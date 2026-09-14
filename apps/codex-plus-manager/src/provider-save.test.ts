import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const saveSettingsValue = async");
const end = source.indexOf("  const beginWeixinQrLogin", start);
const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function harness() {
  const pending: Array<(value: unknown) => void> = [];
  const saved: unknown[] = [], drafts: unknown[] = [];
  const form = { current: { id: "original" } };
  const saving = { current: false }, switching = { current: false };
  const save = new Function("settingsSavingRef", "relaySwitchingRef", "settingsFormRef", "normalizeSettings", "run", "call", "isSuccessStatus", "setSettings", "setSettingsForm", "showNotice", "t", compiled + "return saveSettingsValue;")(
    saving, switching, form, (v: unknown) => v, (f: () => unknown) => f(),
    () => new Promise(resolve => pending.push(resolve)), (status: string) => status === "ok",
    (v: unknown) => saved.push(v), (v: unknown) => drafts.push(v), () => {}, (v: string) => v,
  );
  return { save, pending, saved, drafts, form, saving, switching };
}

test("连续保存不排队，切换期间不能保存，完成后释放互斥", async () => {
  const h = harness();
  const first = h.save({ id: "first" });
  assert.equal(await h.save({ id: "second" }), null);
  assert.equal(h.pending.length, 1);
  h.pending[0]({ status: "ok", settings: { id: "first" } });
  await first;
  assert.equal(h.saving.current, false);
  h.switching.current = true;
  assert.equal(await h.save({ id: "third" }), null);
  assert.equal(h.pending.length, 1);
});

test("保存期间发生新编辑只更新已保存基线，不覆盖草稿", async () => {
  const h = harness();
  const task = h.save({ id: "submitted" });
  await setImmediate();
  h.form.current = { id: "edited" };
  h.pending[0]({ status: "ok", settings: { id: "submitted" } });
  await task;
  assert.equal(h.saved.length, 1);
  assert.deepEqual(h.drafts, []);
  assert.equal(h.form.current.id, "edited");
});

test("业务失败和调用失败都保留草稿，后续可以重试", async () => {
  for (const result of [null, { status: "failed", settings: { id: "fallback" } }]) {
    const h = harness();
    const task = h.save({ id: "submitted" });
    h.pending[0](result);
    assert.equal(await task, null);
    assert.deepEqual(h.drafts, []);
    assert.equal(h.saving.current, false);
    const retry = h.save({ id: "retry" });
    h.pending[1]({ status: "ok", settings: { id: "retry" } });
    await retry;
    assert.equal(h.form.current.id, "retry");
  }
});
