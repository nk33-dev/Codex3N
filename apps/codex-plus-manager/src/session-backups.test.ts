import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("./SessionBackups.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
type Element = { type: any; props: Record<string, any> };
function nodes(value: any): Element[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return value.props ? [value, ...nodes(value.props.children)] : [];
}
function harness(approved: boolean) {
  const slots: any[] = [], effects: Function[] = [], cleanups: Function[] = [];
  const calls: Array<{ command: string; args: any; resolve: (value: any) => void }> = [];
  const confirmations: string[] = [];
  let cursor = 0, changes = 0;
  const react = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], (value: any) => { changes++; slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial: any) { return slots[cursor++] ??= { current: initial }; },
    useEffect(effect: Function) { const index = cursor++; if (!(index in slots)) { slots[index] = true; effects.push(effect); } },
  };
  const modules: Record<string, unknown> = {
    react,
    "@tauri-apps/api/core": { invoke: (command: string, args: any) => new Promise(resolve => calls.push({ command, args, resolve })) },
    "./app-dialog": { appConfirm: async (question: string) => { confirmations.push(question); return approved; } },
    "./i18n": { t: (text: string) => text, tf: (text: string, values: unknown[]) => text.replace(/\{(\d+)\}/g, (_, i) => String(values[i])) },
  };
  const context = vm.createContext({
    React: { createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }) },
    exports: {}, require: (name: string) => modules[name] ?? new Proxy({}, { get: (_, key) => String(key) }),
  });
  vm.runInContext(compiled, context);
  return {
    calls, confirmations, changes: () => changes,
    render() {
      cursor = 0;
      const tree = context.exports.SessionBackups();
      while (effects.length) { const cleanup = effects.shift()!(); if (cleanup) cleanups.push(cleanup); }
      return tree;
    },
    unmount() { cleanups.forEach(fn => fn()); },
  };
}
const backup = { token: "123-fixture", title: "Fixture", sessionId: "session", createdAtMs: 1000, fileCount: 1 };

test("Codex 备份列表只读，单份删除确认后才执行且重复点击不排队", async () => {
  for (const approved of [false, true]) {
    const h = harness(approved);
    h.render();
    assert.equal(h.calls[0].command, "list_local_session_backups");
    h.calls[0].resolve({ status: "ok", backups: [backup], warnings: [] }); await tick();
    const remove = nodes(h.render()).find(node => node.props["aria-label"] === "删除备份")!;
    assert.ok(remove);
    remove.props.onClick(); remove.props.onClick(); await tick();
    assert.equal(h.confirmations.length, 1);
    assert.equal(h.calls.length, approved ? 2 : 1);
    if (approved) {
      assert.equal(h.calls[1].command, "delete_local_session_backup");
      assert.equal(h.calls[1].args.token, backup.token);
      h.calls[1].resolve({ status: "ok" }); await tick();
      assert.equal(h.calls[2].command, "list_local_session_backups");
    }
    h.unmount();
  }
});

test("Codex 备份列表销毁后旧请求不提交", async () => {
  const h = harness(false);
  h.render(); h.unmount();
  const changes = h.changes();
  h.calls[0].resolve({ status: "ok", backups: [backup], warnings: [] }); await tick();
  assert.equal(h.changes(), changes);
});

test("两个后端备份操作均注册到 Tauri", () => {
  const registration = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  for (const command of ["list_local_session_backups", "cleanup_local_session_backups", "delete_local_session_backup", "restore_local_session_backup", "cleanup_claude_session_backups", "delete_claude_session_backup"]) {
    assert.equal(registration.split(`commands::${command},`).length - 1, 1, command);
  }
});
