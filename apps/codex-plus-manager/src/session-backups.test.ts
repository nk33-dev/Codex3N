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
    const remove = nodes(h.render()).find(node => node.type === "button" && node.props["aria-label"] === "删除备份")!;
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

function text(value: any): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value?.props) return text(value.props.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function button(h: ReturnType<typeof harness>, label: string) {
  const node = nodes(h.render()).find(node => node.type === "button" && (node.props["aria-label"] === label || text(node) === label));
  assert.ok(node, label);
  return node;
}
function selectPage(h: ReturnType<typeof harness>) {
  nodes(h.render()).find(node => node.type === "input" && node.props["aria-label"] === "全选本页")!.props.onChange();
}
async function loaded(approved = true, count = 2) {
  const h = harness(approved);
  h.render();
  h.calls[0].resolve({ status: "ok", backups: Array.from({ length: count }, (_, index) => ({ ...backup, token: `token-${index}`, title: `会话 ${index}` })), warnings: [] });
  await tick();
  return h;
}

test("批量删除一次确认，顺序提交，失败项保留选择并可重试", async () => {
  const h = await loaded();
  selectPage(h);
  const remove = button(h, "删除已选 (2)");
  remove.props.onClick(); remove.props.onClick(); await tick();
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0], /2 份备份/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].args.token, "token-0");
  assert.equal(button(h, "删除已选 (2)").props.disabled, true);
  h.calls[1].resolve({ status: "ok" }); await tick();
  assert.equal(h.calls[2].args.token, "token-1");
  h.calls[2].resolve({ status: "failed", message: "fixture failure" }); await tick();
  assert.equal(h.calls[3].command, "list_local_session_backups");
  h.calls[3].resolve({ status: "ok", backups: [{ ...backup, token: "token-1" }], warnings: [] }); await tick();
  assert.equal(button(h, "删除已选 (1)").props.disabled, false);
  assert.match(text(h.render()), /已删除 1 份备份/);
  assert.match(text(h.render()), /1 份备份删除失败/);
  assert.match(text(h.render()), /fixture failure/);
  nodes(h.render()).find(node => node.props["aria-label"] === "搜索备份标题或 ID")!.props.onChange({ target: { value: "not-found" } });
  assert.match(text(h.render()), /没有匹配的备份/);
  assert.doesNotMatch(text(h.render()), /无法读取备份/);
  h.unmount();
});

test("取消批量删除不提交且保留选择", async () => {
  const h = await loaded(false);
  selectPage(h);
  button(h, "删除已选 (2)").props.onClick(); await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(button(h, "删除已选 (2)").props.disabled, false);
  h.unmount();
});

test("本页全选跨页保留，搜索只影响可见列表", async () => {
  const h = await loaded(true, 51);
  selectPage(h);
  button(h, "下一页").props.onClick();
  assert.equal(nodes(h.render()).filter(node => node.props.className === "backup-row").length, 1);
  selectPage(h);
  assert.ok(button(h, "删除已选 (51)"));
  const search = () => nodes(h.render()).find(node => node.type === "input" && node.props["aria-label"] === "搜索备份标题或 ID")!;
  search().props.onChange({ target: { value: "token-50" } });
  assert.equal(nodes(h.render()).filter(node => node.props.className === "backup-row").length, 1);
  assert.ok(button(h, "删除已选 (51)"));
  button(h, "取消全部选择").props.onClick();
  selectPage(h);
  button(h, "删除已选 (1)").props.onClick(); await tick();
  assert.equal(h.calls[1].args.token, "token-50");
  h.calls[1].resolve({ status: "ok" }); await tick();
  h.calls[2].resolve({ status: "ok", backups: [{ ...backup, token: "token-0" }], warnings: [] }); await tick();
  button(h, "清除搜索").props.onClick();
  assert.match(text(h.render()), /第 1\/1 页/);
  assert.equal(button(h, "下一页").props.disabled, true);
  h.unmount();
});

test("删除末页唯一备份后回到有效页，刷新失败显示重试入口", async () => {
  const h = await loaded(true, 51);
  button(h, "下一页").props.onClick();
  button(h, "删除备份").props.onClick(); await tick();
  assert.equal(h.calls[1].args.token, "token-50");
  h.calls[1].resolve({ status: "ok" }); await tick();
  h.calls[2].resolve({ status: "ok", backups: Array.from({ length: 50 }, (_, index) => ({ ...backup, token: `token-${index}` })), warnings: [] }); await tick();
  assert.match(text(h.render()), /第 1\/1 页/);
  assert.equal(nodes(h.render()).filter(node => node.props.className === "backup-row").length, 50);
  h.unmount();
  const failed = harness(true);
  failed.render();
  failed.calls[0].resolve({ status: "failed", message: "fixture read failure" }); await tick();
  assert.match(text(failed.render()), /无法读取备份/);
  button(failed, "重试").props.onClick();
  failed.calls[1].resolve({ status: "ok", backups: [], warnings: [] }); await tick();
  assert.match(text(failed.render()), /还没有删除备份/);
  assert.doesNotMatch(text(failed.render()), /fixture read failure/);
  failed.unmount();
});

test("批删离页后不提交剩余项，也不更新状态", async () => {
  const h = await loaded();
  selectPage(h);
  button(h, "删除已选 (2)").props.onClick(); await tick();
  h.unmount();
  const changes = h.changes();
  h.calls[1].resolve({ status: "ok" }); await tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.changes(), changes);
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
