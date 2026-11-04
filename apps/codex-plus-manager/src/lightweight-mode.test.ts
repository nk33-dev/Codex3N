import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const start = source.indexOf("async function confirmLightweightMode(");
const end = source.indexOf("function GlobalSettingsScreen(", start);
const hooks = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
function fixture(dirty = false) {
  const values: any[] = [];
  const refs: any[] = [];
  let cursor = 0, refCursor = 0, mounted = false;
  let listener!: (event: { payload: boolean }) => void;
  let confirmResult = true, confirms = 0;
  const initial = deferred<boolean>();
  const write = deferred<boolean>();
  const calls: any[] = [];
  const hook = new Function("useState", "useRef", "useEffect", "listen", "invoke", "appConfirm", "t", "stringifyError", hooks + "\nreturn useLightweightModeSetting;")(
    (initial: any) => {
      const index = cursor++;
      if (!(index in values)) values[index] = initial;
      return [values[index], (value: any) => { values[index] = value; }];
    },
    (initial: any) => refs[refCursor++] ?? (refs[refCursor - 1] = { current: initial }),
    (effect: () => void) => { if (!mounted) { mounted = true; effect(); } },
    async (_name: string, callback: typeof listener) => { listener = callback; return () => {}; },
    (name: string, args: any) => {
      calls.push([name, args]);
      return name === "lightweight_mode_enabled" ? initial.promise : write.promise;
    },
    async () => { confirms++; return confirmResult; },
    (s: string) => s,
    String,
  );
  const render = () => { cursor = 0; refCursor = 0; return hook(dirty); };
  render();
  return { render, initial, write, calls, event: (payload: boolean) => listener({ payload }),
    cancel: () => { confirmResult = false; }, confirms: () => confirms };
}

test("轻量开关的迟到初读和保存响应不覆盖新事件", async () => {
  const f = fixture();
  await tick();
  f.event(true);
  f.initial.resolve(false);
  await tick();
  assert.equal(f.render().enabled, true);
  const saving = f.render().toggle();
  f.event(false);
  f.event(true);
  f.write.resolve(false);
  await saving;
  assert.equal(f.render().enabled, true);
});

test("未保存草稿取消后不写盘，连续点击只发一次切换", async () => {
  const f = fixture(true);
  await tick();
  f.initial.resolve(false);
  await tick();
  f.cancel();
  await f.render().toggle();
  assert.equal(f.confirms(), 1);
  assert.equal(f.calls.filter(([name]) => name === "set_lightweight_mode_enabled").length, 0);
  const clean = fixture();
  await tick();
  clean.initial.resolve(false);
  await tick();
  const state = clean.render();
  const first = state.toggle();
  await state.toggle();
  assert.equal(clean.calls.filter(([name]) => name === "set_lightweight_mode_enabled").length, 1);
  clean.write.resolve(true);
  await first;
  assert.equal(clean.render().enabled, true);
});

test("保存失败保留原值，较早操作的失败不覆盖新事件", async () => {
  const f = fixture();
  await tick();
  f.initial.resolve(false);
  await tick();
  const saving = f.render().toggle();
  f.write.reject(Error("保存失败"));
  await saving;
  assert.equal(f.render().enabled, false);
  assert.equal(f.render().saving, false);
  assert.match(f.render().error, /保存失败/);
  const stale = fixture();
  await tick();
  stale.initial.resolve(false);
  await tick();
  const old = stale.render().toggle();
  await tick();
  stale.event(true);
  stale.write.reject(Error("旧请求失败"));
  await old;
  assert.equal(stale.render().enabled, true);
  assert.equal(stale.render().error, "");
});

test("后台启动跳过主窗口，托盘开启先通知主界面确认", () => {
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(lib, /if !lightweight::enabled\(\) \{\s*build_main_window/);
  assert.match(lib, /lightweight::request_from_tray\(app\)/);
  assert.match(source, /listen\("codex-plus-lightweight-mode-requested"/);
  assert.match(lib, /#\[cfg\(all\(windows, debug_assertions\)\)\][\s\S]*?CODEX_PLUS_MANAGER_TEST_DEBUG_PORT/);
});
