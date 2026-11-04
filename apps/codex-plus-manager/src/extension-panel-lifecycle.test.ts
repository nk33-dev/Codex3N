import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("面板身份变化立即卸下旧页，迟到注册只撤销令牌", async () => {
  const text = readFileSync(new URL("./ExtensionManagerPanel.tsx", import.meta.url), "utf8");
  const source = ts.createSourceFile("panel.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "ExtensionManagerPanel");
  assert.ok(component);
  const compiled = ts.transpileModule(component.getText(source).replace("export function", "function"), {
    compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: "jsx", target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const hooks: any[] = [], effects: Array<() => void> = [];
  const cleanups = new Map<number, () => void>();
  const requests: Array<{ command: string; args: any; resolve: (result: any) => void }> = [];
  const released: string[] = [];
  let cursor = 0;
  const deps = {
    useRef: (value: unknown) => { const index = cursor++; return hooks[index] ??= { current: value }; },
    useState: (initial: any) => {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = typeof initial === "function" ? initial() : initial;
      return [hooks[index], (value: any) => { hooks[index] = value; }];
    },
    useMemo: (create: () => unknown) => create(),
    useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
      const index = cursor++, old = hooks[index];
      if (!old || deps.some((value, i) => !Object.is(value, old[i]))) {
        hooks[index] = deps;
        effects.push(() => { cleanups.get(index)?.(); const cleanup = effect(); if (cleanup) cleanups.set(index, cleanup); });
      }
    },
    invoke: (command: string, args: any) => {
      if (command === "release_extension_panel") { released.push(args.token); return Promise.resolve(); }
      return new Promise(resolve => requests.push({ command, args, resolve }));
    },
    convertFileSrc: (token: string) => `panel://${token}`,
    managerPanelSrcdoc: (html: string) => html,
    document: { querySelector: () => null },
    window: { addEventListener() {}, removeEventListener() {} },
    jsx: (type: string, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
    t: (value: string) => value,
    MANAGER_PANEL_MIN_HEIGHT: 80,
  };
  const renderPanel = new Function(...Object.keys(deps), `${compiled} return ExtensionManagerPanel;`)(...Object.values(deps));
  const render = (key: string) => {
    cursor = 0;
    const tree = renderPanel({ scriptKey: key, config: {}, onSaveConfig() {}, onToast() {} });
    while (effects.length) effects.shift()!();
    return tree;
  };
  const iframe = (tree: any) => tree.props.children.find((child: any) => child?.type === "iframe");
  render("a");
  requests[0].resolve({ title: "A", html: "html-a" }); await Promise.resolve();
  render("a");
  assert.equal(requests[1].command, "register_extension_panel");
  render("b");
  requests[1].resolve("late-a"); await Promise.resolve();
  assert.deepEqual(released, ["late-a"]);
  requests[2].resolve({ title: "B", html: "html-b" }); await Promise.resolve();
  render("b");
  requests[3].resolve("token-b"); await Promise.resolve();
  assert.equal(iframe(render("b")).props.src, "panel://token-b");
  assert.equal(iframe(render("c")), undefined);
  assert.ok(released.includes("token-b"));
});
