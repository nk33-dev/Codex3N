import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";
import { defaultDreamSkinColors, defaultDreamSkinTheme } from "./dream-skin.ts";

const app = ts.createSourceFile("App.tsx", readFileSync(new URL("./App.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function runtime(name: string, extras: Record<string, unknown> = {}) {
  const fn = app.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(fn);
  const components: Record<string, string> = {};
  const collect = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(app);
      if (/^[A-Z]\w*$/.test(tag)) components[tag] = "div";
    }
    ts.forEachChild(node, collect);
  };
  collect(fn);
  const context = vm.createContext({ ...components, exports: {}, require: () => jsxRuntime,
    useState: (initial: unknown) => [initial, () => {}], useRef: () => ({ current: null }),
    t: (value: string) => value, tf: (value: string, args: string[]) => value.replace("{0}", args[0]),
    isWindowsPlatform: true, defaultDreamSkinColors, defaultDreamSkinTheme,
    dreamSkinWindowsPreviewUrl: "builtin.jpg", dreamSkinMacPreviewUrl: "builtin.png",
    convertFileSrc: (value: string) => value, dreamSkinStateLabel: () => "正常", ...extras });
  vm.runInContext(ts.transpileModule(fn.getText(app), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context[name] as (props: any) => any;
}
function find(element: any, className: string): any[] {
  if (!element || typeof element !== "object") return [];
  if (Array.isArray(element)) return element.flatMap(child => find(child, className));
  return [...(String(element.props?.className || "").split(" ").includes(className) ? [element] : []), ...find(element.props?.children, className)];
}

test("关闭、暂停及总开关关闭时显示原生外观，保存的主题仍可编辑", () => {
  const render = runtime("DreamSkinScreen");
  const theme = { key: "stored:test", name: "已保存主题", kind: "stored", active: true };
  for (const state of ["disabled", "paused", "masterOff", "enabled"]) {
    const tree = render({ form: { enhancementsEnabled: state !== "masterOff", codexAppDreamSkinEnabled: state !== "disabled", codexAppDreamSkinPaused: state === "paused" },
      library: { themes: [theme] }, draft: { config: defaultDreamSkinTheme(), imagePath: "", builtin: true },
      selectedTheme: theme.key, status: { state: "pass", liveApplied: false, paused: false, checks: [] }, actions: {}, dirty: false });
    const current = find(tree, "dream-skin-current-copy")[0];
    assert.equal(current.props.children[1].props.children, state === "enabled" ? theme.name : "Codex 原生外观");
    assert.equal(find(tree, "is-current").length, state === "enabled" ? 1 : 0);
    assert.equal(find(tree, "dream-skin-selected-copy").length, 1);
  }
});

test("封面失败后显示占位，同组件收到新地址可继续加载", () => {
  let failed: string | null = null;
  const render = runtime("DreamSkinPreview", { useState: () => [failed, (url: string) => { failed = url; }] });
  const first = render({ src: "first.jpg", name: "主题" });
  assert.equal(first.type, "img"); first.props.onError();
  const unavailable = render({ src: "first.jpg", name: "主题" });
  assert.equal(unavailable.type, "div");
  assert.equal(unavailable.props["aria-label"], "主题：预览暂不可用");
  const recovered = render({ src: "second.jpg", name: "主题" });
  assert.equal(recovered.type, "img"); assert.equal(recovered.props.src, "second.jpg");
  assert.equal(render({ src: "", name: "主题" }).type, "div");
});
