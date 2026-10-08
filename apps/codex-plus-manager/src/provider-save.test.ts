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
  const save = new Function("settingsSavingRef", "relaySwitchingRef", "settingsFormRef", "normalizeSettings", "run", "call", "isSuccessStatus", "setSettings", "setSettingsForm", "showNotice", "t", "dictationSettingsIssue", "dictationSettingsValidationMessage", compiled + "return saveSettingsValue;")(
    saving, switching, form, (v: unknown) => v, (f: () => unknown) => f(),
    () => new Promise(resolve => pending.push(resolve)), (status: string) => status === "ok",
    (v: unknown) => saved.push(v), (v: unknown) => drafts.push(v), () => {}, (v: string) => v, () => null, (v: unknown) => v,
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

function detailHarness() {
  const detail = source.slice(source.indexOf("function RelayProfileDetail("), source.indexOf("function ContextScreen("));
  const start = detail.indexOf("  const saveDraft = async");
  const end = detail.indexOf("  const switchDraft", start);
  const body = ts.transpileModule(detail.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const saving = { current: false }, mounted = { current: true };
  const pending: Array<(value: unknown) => void> = [];
  let saved = 0;
  const actions = { relaySwitching: false };
  const env = {
    savingDraftRef: saving, mountedRef: mounted, actions, validationError: null, modelRowsError: null,
    setSavingDraft: () => {}, draftWithModelRows: () => ({ id: "supplier" }),
    isAggregateRelayProfile: () => false, deriveRelayProfileFromFiles: (v: unknown) => v,
    normalizeSettings: (v: unknown) => v, isNew: false, form: {}, profile: { id: "supplier", configContents: "" },
    updateRelayProfile: () => ({ relayProfiles: [{ id: "supplier" }] }), relaySettingsValidation: () => null,
    codexBaseUrlFromConfig: () => "", relayFiles: null, isActive: false,
    modelRouteSaveRequiresRestart: () => false,
    onFormChange: () => new Promise(resolve => pending.push(resolve)), onSaved: () => { saved += 1; },
  };
  const save = new Function("env", `const { ${Object.keys(env).join(",")} } = env; ${body} return saveDraft;`)(env);
  return { save, pending, saving, mounted, actions, saved: () => saved };
}

test("供应商详情重复保存只发一次请求，切换期间保留草稿", async () => {
  const h = detailHarness();
  const first = h.save();
  await h.save();
  assert.equal(h.pending.length, 1);
  h.pending[0]({ relayProfiles: [{ id: "supplier" }], relayProfilesEnabled: false });
  await first;
  assert.equal(h.saved(), 1);
  assert.equal(h.saving.current, false);
  h.actions.relaySwitching = true;
  await h.save();
  assert.equal(h.pending.length, 1);
});

test("供应商详情销毁后不触发旧页面保存回调", async () => {
  const h = detailHarness();
  const task = h.save();
  h.mounted.current = false;
  h.pending[0]({ relayProfiles: [{ id: "supplier" }], relayProfilesEnabled: false });
  await task;
  assert.equal(h.saved(), 0);
  assert.equal(h.saving.current, false);
});
