import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

type Element = { type: any; props: Record<string, any> };
const tick = () => new Promise(resolve => setImmediate(resolve));
function nodes(value: any): Element[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  return value.props ? [value, ...nodes(value.props.children), ...nodes(value.props.actions)] : [];
}
function find(root: Element, predicate: (node: Element) => boolean) {
  const value = nodes(root).find(predicate);
  assert.ok(value, "控件未渲染");
  return value;
}
function harness(file: string, component: string) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const hooks: any[] = [], effects: Array<() => void> = [];
  const cleanups = new Map<number, () => void>();
  const calls: Array<{ command: string; args: any; resolve: (value: any) => void; reject: (reason: unknown) => void }> = [];
  const notices: unknown[] = [];
  let cursor = 0, changes = 0;
  const React = { createElement: (type: any, props: object, ...children: unknown[]) => ({ type, props: { ...props, children } }) };
  const react = {
    useState(initial: any) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], (value: any) => { changes++; hooks[index] = typeof value === "function" ? value(hooks[index]) : value; }];
    },
    useRef(initial: unknown) { const index = cursor++; return hooks[index] ??= { current: initial }; },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const index = cursor++, old = hooks[index];
      if (!old || deps.some((value, i) => !Object.is(value, old[i]))) {
        hooks[index] = deps;
        effects.push(() => { cleanups.get(index)?.(); const cleanup = effect(); if (cleanup) cleanups.set(index, cleanup); });
      }
    },
    useMemo: (callback: () => unknown) => callback(),
    useDeferredValue: (value: unknown) => value,
    startTransition: (callback: () => void) => callback(),
  };
  const modules: Record<string, any> = {
    react,
    "@tauri-apps/api/core": { invoke: (command: string, args: unknown) => new Promise((resolve, reject) => calls.push({ command, args, resolve, reject })) },
    "./management-model": { matchesManagementQuery: () => true },
    "@/i18n": { t: (text: string) => text, tf: (text: string, args: unknown[]) => text.replace(/\{(\d+)\}/g, (_, i) => String(args[i])) },
    "./i18n": { t: (text: string) => text },
  };
  const context = vm.createContext({ React, exports: {}, require: (name: string) => modules[name] ?? new Proxy({}, { get: (_, key) => String(key) }) });
  vm.runInContext(`${compiled}\nglobalThis.component = ${component};`, context);
  return {
    calls, notices,
    render() { cursor = 0; const root = context.component({ notify: (...args: unknown[]) => { notices.push(args); } }); while (effects.length) effects.shift()!(); return root as Element; },
    unmount() { cleanups.forEach(cleanup => cleanup()); },
    changes: () => changes,
  };
}

test("Skills 进入和重新挂载只读缓存，刷新点击合并且卸载后不提交", async () => {
  const screen = harness("./ManagementExtra.tsx", "SkillsPage");
  screen.render();
  assert.equal(screen.calls[0].command, "list_installed_skills");
  const payload = { status: "ok", skills: [], repos: [], repoCounts: {}, repositorySkills: [], repoErrors: [] };
  screen.calls[0].resolve(payload); await tick();
  assert.equal(screen.calls.length, 1);
  const button = find(screen.render(), node => nodes(node).some(child => child.props.children?.includes("刷新目录")) && node.props.onClick);
  button.props.onClick(); button.props.onClick();
  assert.equal(screen.calls.length, 2);
  assert.equal(screen.calls[1].command, "refresh_skill_catalog");
  screen.unmount();
  const before = screen.changes();
  screen.calls[1].resolve(payload); await tick();
  assert.equal(screen.changes(), before);
  const next = harness("./ManagementExtra.tsx", "SkillsPage");
  next.render();
  assert.equal(next.calls[0].command, "list_installed_skills");
  next.unmount();
});

test("Skills 写操作隔离旧刷新并合并重复点击", async () => {
  const screen = harness("./ManagementExtra.tsx", "SkillsPage");
  const payload = (name: string) => ({ status: "ok", message: name, skills: [{ id: name, name, installed: true, bundled: true }], repos: [], repoCounts: {}, repositorySkills: [], repoErrors: [] });
  screen.render();
  screen.calls[0].resolve(payload("initial")); await tick();
  let root = screen.render();
  find(root, node => node.props.onClick && nodes(node).some(child => child.props.children?.includes("刷新目录"))).props.onClick();
  root = screen.render();
  const importButton = find(root, node => node.props.onClick && nodes(node).some(child => child.props.children?.includes("从 cc-switch 导入")));
  importButton.props.onClick(); importButton.props.onClick();
  assert.equal(screen.calls.length, 3);
  screen.calls[2].resolve(payload("new")); await tick();
  screen.calls[1].resolve(payload("old")); await tick();
  root = screen.render();
  assert.equal(find(root, node => node.props.rowHeight === 68).props.items[0].id, "new");
  importButton.props.onClick();
  screen.unmount();
  const before = screen.changes();
  screen.calls[3].reject(new Error("late failure")); await tick();
  assert.equal(screen.changes(), before);
});

test("收藏列表读取摘要，正文按选择读取并隔离旧结果", async () => {
  const screen = harness("./prompt-tools.tsx", "PromptToolsPanel");
  screen.render();
  assert.equal(screen.calls[0].args.payload.summaryOnly, true);
  const summaries = ["one", "two"].map(id => ({ id, title: id, tags: [], excerpt: "摘要", order: 0 }));
  screen.calls[0].resolve({ status: "ok", favorites: summaries, tags: [], total: 2 }); await tick();
  const items = nodes(screen.render()).filter(node => node.props.className === "prompt-manager-item");
  items[0].props.onClick(); items[1].props.onClick();
  assert.equal(screen.calls[1].args.action, "library/get");
  screen.calls[2].resolve({ status: "ok", favorite: { ...summaries[1], body: "完整正文二" } }); await tick();
  screen.calls[1].resolve({ status: "ok", favorite: { ...summaries[0], body: "完整正文一" } }); await tick();
  assert.equal(find(screen.render(), node => node.type === "pre").props.children[0], "完整正文二");
  items[0].props.onClick();
  screen.unmount();
  const before = screen.changes();
  screen.calls.at(-1)!.resolve({ status: "ok", favorite: { ...summaries[0], body: "late" } }); await tick();
  assert.equal(screen.changes(), before);
});

test("收藏编辑保存后预览使用最新正文", async () => {
  const screen = harness("./prompt-tools.tsx", "PromptToolsPanel");
  const favorite = { id: "one", title: "one", tags: [], excerpt: "摘要", body: "原正文", project: null, pinned: false, order: 0 };
  const list = { status: "ok", favorites: [favorite], tags: [], total: 1 };
  screen.render();
  screen.calls[0].resolve(list); await tick();
  find(screen.render(), node => node.props.className === "prompt-manager-item").props.onClick();
  screen.calls[1].resolve({ status: "ok", favorite }); await tick();
  find(screen.render(), node => node.props["aria-label"] === "编辑").props.onClick();
  find(screen.render(), node => node.props.maxLength === 20000).props.onChange({ currentTarget: { value: "新正文" } });
  find(screen.render(), node => node.props.className === "prompt-tools-editor").props.onSubmit({ preventDefault() {} });
  assert.equal(screen.calls[2].args.payload.body, "新正文");
  const saved = { ...favorite, body: "新正文", excerpt: "新正文" };
  screen.calls[2].resolve({ status: "ok", favorite: saved }); await tick();
  screen.calls[3].resolve({ ...list, favorites: [saved] }); await tick();
  assert.equal(find(screen.render(), node => node.type === "pre").props.children[0], "新正文");
  screen.unmount();
});
