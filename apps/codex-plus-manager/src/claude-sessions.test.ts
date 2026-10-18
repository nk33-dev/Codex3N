import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as model from "./claude-sessions-model.ts";
import { matchesManagementQuery } from "./management-model.ts";

const source = readFileSync(new URL("./screens/ClaudeSessionsScreen.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const session = (key = "one", id = "same-id"): model.ClaudeSession => ({
  key, id, title: `title-${key}`, cwd: "/workspace/project", createdAtMs: 1, updatedAtMs: 2,
  transcriptPath: `/workspace/claude/projects/project/${key}.jsonl`, fileSize: 100,
  desktop: false, protectedReason: null, warnings: [],
});
const page = (sessions = [session()]) => ({
  status: "ok", sessions, offset: 0, limit: 50, hasMore: false, totalCount: sessions.length, warnings: [],
});

type Element = { type: any; props: Record<string, any> };
function elements(node: any): Element[] {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node.props) return [];
  return [node, ...elements(node.props.children), ...elements(node.props.actions), ...elements(node.props.footer)];
}
function text(node: any): string {
  if (node == null || typeof node === "boolean") return "";
  if (Array.isArray(node)) return node.map(text).join("");
  if (typeof node === "object") return text(node.props?.children);
  return String(node);
}
function find(root: Element, predicate: (element: Element) => boolean) {
  const match = elements(root).find(predicate);
  assert.ok(match, "expected control was not rendered");
  return match;
}

function harness(component = "ClaudeSessionsScreen", props: object = {}, approved = false) {
  const hooks: any[] = [];
  const effects: (() => void)[] = [];
  const cleanups = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  const calls: Array<{ command: string; args: any; resolve: (value: unknown) => void }> = [];
  const confirmations: string[] = [];
  let cursor = 0;
  let changes = 0;
  const React = { createElement: (type: any, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
  const modules: Record<string, any> = {
    react: {
      useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = initial;
        return [hooks[index], (value: any) => { changes++; hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
      },
      useRef: (initial: unknown) => {
        const index = cursor++;
        if (!(index in hooks)) hooks[index] = { current: initial };
        return hooks[index];
      },
      useEffect: (effect: () => (() => void) | undefined, dependencies: unknown[]) => {
        const index = cursor++;
        const previous = hooks[index];
        if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
          hooks[index] = dependencies;
          effects.push(() => { cleanups.get(index)?.(); const cleanup = effect(); if (cleanup) cleanups.set(index, cleanup); });
        }
      },
    },
    "@tauri-apps/api/core": { invoke: (command: string, args: unknown) => new Promise((resolve) => calls.push({ command, args, resolve })) },
    "@tauri-apps/plugin-dialog": { confirm: async (message: string) => { confirmations.push(message); return approved; } },
    "../ManagementPages": { ManagementDrawer: "ManagementDrawer", PageHeader: "PageHeader" },
    "../management-model": { matchesManagementQuery },
    "../claude-sessions-model": model,
    "../i18n": { t: (value: string) => value, tf: (value: string, args: unknown[]) => value.replace(/\{(\d+)\}/g, (_, i) => String(args[i])) },
  };
  const context = vm.createContext({
    React, exports: {}, require: (name: string) => modules[name] ?? new Proxy({}, { get: (_, key) => String(key) }),
    window: { setTimeout: (callback: () => void) => { const id = timers.size + 1; timers.set(id, callback); return id; }, clearTimeout: (id: number) => timers.delete(id) },
    navigator: { clipboard: { writeText: async () => {} } },
  });
  vm.runInContext(`${compiled}\nglobalThis.component = ${component};`, context);
  return {
    calls, confirmations,
    render: () => {
      cursor = 0;
      const root = context.component(props) as Element;
      while (effects.length) effects.shift()!();
      return root;
    },
    timers: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((callback) => callback()); },
    unmount: () => cleanups.forEach((cleanup) => cleanup()),
    changes: () => changes,
  };
}

test("Claude 会话独立导航，不加载 Codex 维护接口", async () => {
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(app, /id: "claudeSessions"[^}]+tool: "claude"/);
  const loaders = readFileSync(new URL("./manager-loading.ts", import.meta.url), "utf8");
  assert.match(loaders, /claudeSessions: \[\]/);
  const screen = harness();
  screen.render();
  assert.equal(screen.calls.length, 1);
  assert.equal(screen.calls[0].command, "list_claude_sessions");
  screen.unmount();
  const before = screen.changes();
  screen.calls[0].resolve(page());
  await tick();
  assert.equal(screen.changes(), before);
});

test("选择和分组使用文件 key，不把重复会话 ID 合并", () => {
  const one = session("one"), two = session("two");
  two.protectedReason = "ambiguous";
  const groups = model.claudeSessionGroups([one, two], "project");
  assert.equal(groups[0].sessions.length, 2);
  assert.deepEqual(model.selectableSessionKeys([one, two]), ["one"]);
  assert.deepEqual(model.deletionCounts([
    { key: "one", title: "", status: "ok", message: "", backupToken: "backup" },
    { key: "two", title: "", status: "partial", message: "", backupToken: "backup2" },
  ], 3), { deleted: 1, failed: 1, unprocessed: 1 });
});

test("搜索发送给后端，覆盖全部分页", async () => {
  const screen = harness();
  screen.render();
  screen.calls[0].resolve(page());
  await tick();
  find(screen.render(), (node) => node.type === "input" && node.props.placeholder).props.onChange({ target: { value: "old session" } });
  screen.render();
  screen.timers();
  screen.render();
  assert.equal(screen.calls.at(-1)!.command, "list_claude_sessions");
  assert.equal(screen.calls.at(-1)!.args.query, "old session");
  assert.equal(screen.calls.at(-1)!.args.offset, 0);
  screen.unmount();
});

test("取消项目删除不会执行删除，重复点击不会创建并发预览", async () => {
  const screen = harness();
  screen.render();
  screen.calls[0].resolve(page());
  await tick();
  const remove = find(screen.render(), (node) => node.props.label === "删除该项目的全部会话");
  remove.props.onClick(); remove.props.onClick();
  assert.equal(screen.calls.length, 2);
  assert.equal(screen.calls[1].command, "preview_claude_session_deletion");
  assert.equal(screen.calls[1].args.projectPath, "/workspace/project");
  screen.calls[1].resolve({ status: "ok", token: "preview", sessions: Array.from({ length: 52 }, (_, i) => session(String(i))), fileCount: 52, backupRoot: "backup" });
  await tick();
  assert.match(screen.confirmations[0], /删除 52 个会话/);
  assert.equal(screen.calls.length, 2);
  screen.unmount();
});

test("确认后只提交预览 token，并保留部分失败和未处理数量", async () => {
  const screen = harness("ClaudeSessionsScreen", {}, true);
  screen.render();
  screen.calls[0].resolve(page());
  await tick();
  find(screen.render(), (node) => node.props.label === "删除该项目的全部会话").props.onClick();
  screen.calls[1].resolve({ status: "ok", token: "preview", sessions: [session("one"), session("two"), session("three")], fileCount: 3, backupRoot: "backup" });
  await tick();
  assert.equal(screen.calls[2].command, "delete_claude_sessions");
  assert.equal(screen.calls[2].args.token, "preview");
  assert.equal(Object.keys(screen.calls[2].args).length, 1);
  screen.calls[2].resolve({ status: "partial", stopped: true, outcomes: [
    { key: "one", title: "one", status: "ok", message: "deleted", backupToken: "saved" },
    { key: "two", title: "two", status: "partial", message: "file locked", backupToken: "recoverable" },
  ] });
  await tick();
  const root = screen.render();
  assert.match(text(root), /已删除 1 个，失败 1 个，未处理 1 个/);
  assert.match(text(root), /file locked/);
  assert.match(text(root), /recoverable/);
  assert.equal(screen.calls.at(-1)!.command, "list_claude_sessions");
  screen.unmount();
});

test("对话按需分页，详情关闭后忽略迟到响应", async () => {
  const screen = harness("SessionDetail", { session: session(), onClose: () => {} });
  screen.render();
  assert.equal(screen.calls[0].command, "read_claude_session");
  screen.calls[0].resolve({ status: "ok", messages: [], offset: 0, limit: 50, totalCount: 70, hasMore: true, warnings: [] });
  await tick();
  find(screen.render(), (node) => typeof node.type === "function" && node.type.name === "Action" && text(node) === "下一页").props.onClick();
  screen.render();
  assert.equal(screen.calls[1].args.offset, 50);
  screen.unmount();
  const before = screen.changes();
  screen.calls[1].resolve({ status: "failed", message: "late failure" });
  await tick();
  assert.equal(screen.changes(), before);
});

test("切换备份视图并恢复，先确认再发送恢复请求", async () => {
  const screen = harness("ClaudeSessionsScreen", {}, true);
  screen.render();
  screen.calls[0].resolve(page());
  await tick();
  find(screen.render(), (node) => node.props.role === "tab" && text(node).includes("删除备份")).props.onClick();
  screen.render();
  assert.equal(screen.calls[1].command, "list_claude_session_backups");
  screen.calls[1].resolve({ status: "ok", backups: [
    { token: "backup-token", title: "restore title", sessionId: "one", cwd: "/workspace/project", createdAtMs: 1, complete: false, restored: false, fileCount: 2 },
  ], warnings: [] });
  await tick();
  find(screen.render(), (node) => node.props.label === "恢复会话").props.onClick();
  await tick();
  assert.match(screen.confirmations[0], /恢复会话/);
  assert.equal(screen.calls[2].command, "restore_claude_session");
  assert.equal(screen.calls[2].args.token, "backup-token");
  screen.calls[2].resolve({ status: "ok" });
  await tick();
  assert.match(text(screen.render()), /会话已恢复/);
  screen.unmount();
});
