import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";
import * as compact from "./auto-compact.ts";
import * as models from "./gateway-model.ts";
import * as windows from "./model-windows.ts";
import type { GatewayPoolEntry, ProviderCompaction } from "./gateway-model.ts";

type Element = { type: unknown; props: Record<string, any> };
function find(root: any, predicate: (node: Element) => boolean): Element | undefined {
  if (Array.isArray(root)) return root.map(child => find(child, predicate)).find(Boolean);
  if (!root?.props) return;
  return predicate(root) ? root : find(root.props.children, predicate);
}
function fixture(saved?: ProviderCompaction) {
  const state: any[] = [];
  let cursor = 0;
  const dependencies: Record<string, any> = {
    react: { useState: (initial: any) => {
      const index = cursor++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (value: any) => { state[index] = typeof value === "function" ? value(state[index]) : value; }];
    } },
    "react/jsx-runtime": jsxRuntime,
    "react-dom": { createPortal: (node: unknown) => node },
    "lucide-react": { Check: "check", RefreshCw: "refresh", RotateCcw: "reset", X: "x" },
    "@/components/ui/button": { Button: "button" },
    "@/components/ui/input": { Input: "input" },
    "./i18n": { t: (s: string) => s, tf: (s: string, args: any[]) => s.replace(/\{(\d+)\}/g, (_, i) => args[Number(i)]) },
    "./gateway-model": models,
    "./auto-compact": compact,
    "./model-windows": windows,
    "./ProviderExtrasDialog": { lookupPublicPrices: async () => ({}) },
    "./gateway-ui": { Avatar: "avatar" },
    "./use-escape-layer": { useEscapeLayer: () => {} },
    "./ProviderFormDialog.css": {},
  };
  const source = readFileSync(new URL("./ProviderWindowsDialog.tsx", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module: any = {};
  new Function("require", "exports", "document", js)((name: string) => {
    assert.ok(name in dependencies, name);
    return dependencies[name];
  }, module, { body: {} });
  const entry: GatewayPoolEntry = { id: "fixture", name: "测试", baseUrl: "http://127.0.0.1", protocol: "responses", official: false, keyCount: 1, models: ["alpha", "beta"], compaction: saved, modelWindows: { alpha: 1_000_000 } };
  const submissions: any[] = [];
  const render = (busy = false): Element => {
    cursor = 0;
    return module.ProviderWindowsDialog({ entry, busy, onSave: (...args: any[]) => submissions.push(args), onCancel() {} });
  };
  const input = (label: string) => {
    const node = find(render(), node => node.type === "input" && node.props["aria-label"] === label);
    assert.ok(node, label);
    return node;
  };
  const change = (label: string, value: string) => input(label).props.onChange({ currentTarget: { value } });
  const toggle = (checked: boolean) => {
    const node = find(render(), node => node.props.type === "checkbox")!;
    node.props.onChange({ currentTarget: { checked } });
  };
  const submit = (busy = false) => find(render(busy), node => node.type === "form")!.props.onSubmit({ preventDefault() {} });
  return { render, input, change, toggle, submit, submissions, summary: () => module.compactionSummary(entry) };
}

test("供应商比例与模型覆盖共同保存，关闭再开启保留值", () => {
  const f = fixture({ percent: "80%", modelOverridesEnabled: true, modelPercents: { "ALPHA[1M]": "70%", unlisted: "60%" } });
  assert.equal(f.input("alpha 的自动压缩比例").props.value, "70%");
  f.change("alpha 的自动压缩比例", "75.123456");
  f.toggle(false);
  assert.equal(find(f.render(), node => node.props["aria-label"] === "alpha 的自动压缩比例"), undefined);
  f.submit();
  assert.deepEqual(f.submissions[0][2], { percent: "80%", modelOverridesEnabled: false, modelPercents: { alpha: "75.123456%", unlisted: "60%" } });
  f.toggle(true);
  assert.equal(f.input("alpha 的自动压缩比例").props.value, "75.123456");
  assert.equal(f.input("beta 的自动压缩比例").props.placeholder, "80%");
  f.submit();
  assert.equal(f.submissions[1][2].modelOverridesEnabled, true);
});

test("非法百分比和保存中禁止提交，空值保留默认语义", () => {
  const f = fixture();
  const percent = () => find(f.render(), node => node.props.list === "provider-compact-presets")!;
  percent().props.onChange({ currentTarget: { value: "101%" } });
  f.submit();
  assert.equal(f.submissions.length, 0);
  percent().props.onChange({ currentTarget: { value: "" } });
  f.submit(true);
  assert.equal(f.submissions.length, 0);
  f.submit();
  assert.deepEqual(f.submissions[0][2], { percent: "", tokenLimit: null, modelOverridesEnabled: false, modelPercents: {} });
});

test("导入的绝对阈值在只改窗口或覆盖开关时保留，编辑供应商比例后清除", () => {
  const f = fixture({ percent: "", tokenLimit: 123456, modelOverridesEnabled: false, modelPercents: {} });
  f.toggle(true);
  f.submit();
  assert.equal(f.submissions[0][2].tokenLimit, 123456);
  const percent = find(f.render(), node => node.props.list === "provider-compact-presets")!;
  percent.props.onChange({ currentTarget: { value: "80%" } });
  f.submit();
  assert.equal(f.submissions[1][2].tokenLimit, null);
  const reset = fixture({ percent: "", tokenLimit: 123456, modelOverridesEnabled: false, modelPercents: {} });
  find(reset.render(), node => node.props["aria-label"] === "使用 Codex 默认压缩")!.props.onClick();
  reset.submit();
  assert.equal(reset.submissions[0][2].tokenLimit, null);
});
