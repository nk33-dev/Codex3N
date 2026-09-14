import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import * as jsxRuntime from "react/jsx-runtime";
import type { BackendSettings, RelayProfile } from "./provider-types.ts";

type Element = { type: unknown; props: Record<string, unknown> };
const translate = {
  t: (text: string) => text,
  tf: (text: string, values: unknown[]) => text.replace(/\{(\d+)\}/g, (_, i) => String(values[Number(i)])),
};

// 执行真实组件的回调，替换拖拽和 JSX 环境；不依赖源码注释或按钮字符串接线。
function compile(source: string, dependencies: Record<string, unknown>) {
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports: Record<string, unknown> = {};
  new Function("require", "exports", js)((name: string) => {
    assert.ok(name in dependencies, `未注入模块：${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}
const utils = compile(readFileSync(new URL("./provider-utils.ts", import.meta.url), "utf8"), { "./i18n": translate });
const dependencies = {
  "react/jsx-runtime": jsxRuntime,
  "@/i18n": translate,
  "../../provider-utils": utils,
  "@/components/ui/button": { Button: "button" },
  "lucide-react": Object.fromEntries(["CheckCircle2", "Copy", "Edit3", "GripVertical", "TestTube", "Trash2", "Plus", "RefreshCw", "Download"].map(name => [name, name])),
  "@dnd-kit/core": { DndContext: "dnd", closestCenter: () => {}, KeyboardSensor: {}, PointerSensor: {}, useSensor: () => ({}), useSensors: () => [] },
  "@dnd-kit/sortable": { SortableContext: "sortable", sortableKeyboardCoordinates: () => {}, verticalListSortingStrategy: () => {}, useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, transform: null, transition: undefined, isDragging: false }) },
  "@dnd-kit/utilities": { CSS: { Transform: { toString: () => undefined } } },
};
const listModule = compile(readFileSync(new URL("./components/providers/RelayProfileList.tsx", import.meta.url), "utf8") + "\nexport { SortableRelayProfileCard };", dependencies);
const card = listModule.SortableRelayProfileCard as (props: Record<string, unknown>) => Element;
const list = listModule.RelayProfileList as (props: Record<string, unknown>) => Element;
function find(root: unknown, predicate: (node: Element) => boolean): Element | undefined {
  if (Array.isArray(root)) return root.map(child => find(child, predicate)).find(Boolean);
  if (!root || typeof root !== "object" || !("props" in root)) return;
  const element = root as Element;
  return predicate(element) ? element : find(element.props.children, predicate);
}
function button(root: Element, title: string): Element {
  const found = find(root, node => node.type === "button" && node.props.title === title);
  assert.ok(found, title);
  return found;
}
function click(button: Element) {
  let stopped = false;
  (button.props.onClick as (event: { stopPropagation: () => void }) => void)({ stopPropagation: () => { stopped = true; } });
  return stopped;
}
const profile = { id: "b", name: "供应商 B", relayMode: "pureApi", protocol: "responses", sub2apiEnabled: false } as RelayProfile;

test("列表卡片切换、测试、编辑、复制、删除准确传递对象和 ID", () => {
  const events: unknown[] = [];
  const root = card({
    profile, enabled: true, activeRelayId: "a", disabled: false, canRemove: true,
    profileBrief: () => "配置摘要",
    onSwitch: (id: string) => events.push(["switch", id]),
    onTest: (value: RelayProfile) => events.push(["test", value]),
    onEdit: (id: string) => events.push(["edit", id]),
    onDuplicate: (id: string) => events.push(["duplicate", id]),
    onRemove: (id: string) => events.push(["remove", id]),
  });
  for (const title of ["设为当前", "发送 hi 测试", "编辑", "复制", "删除供应商"]) assert.equal(click(button(root, title)), true);
  assert.deepEqual(events, [["switch", "b"], ["test", profile], ["edit", "b"], ["duplicate", "b"], ["remove", "b"]]);
});

test("禁用切换、聚合测试和最后一个供应商删除保留保护", () => {
  const root = card({ profile: { ...profile, relayMode: "aggregate" }, enabled: true, activeRelayId: "a", disabled: true, canRemove: false, profileBrief: () => "",
    onSwitch: () => assert.fail("禁用仍切换"), onTest: () => assert.fail("聚合仍测试"),
  });
  const switching = button(root, "供应商切换不可用");
  assert.equal(switching.props.disabled, true);
  click(switching);
  const testing = button(root, "聚合供应商会在真实对话中轮转成员，请测试成员供应商");
  assert.equal(testing.props.disabled, true);
  click(testing);
  assert.equal(button(root, "删除供应商").props.disabled, true);
});

test("拖拽忽略空目标和原地放下，正常拖拽传递源与目标 ID", () => {
  const moved: string[][] = [];
  const root = list({ profiles: [profile], onReorder: (a: string, b: string) => moved.push([a, b]) });
  const end = root.props.onDragEnd as (event: unknown) => void;
  end({ active: { id: "a" }, over: null });
  end({ active: { id: "a" }, over: { id: "a" } });
  end({ active: { id: "a" }, over: { id: "b" } });
  assert.deepEqual(moved, [["a", "b"]]);
});

test("App 列表切换接线先同步配置，再传递同步结果和旧供应商 ID", () => {
  const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "RelayProfileList") {
      const attr = node.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText(tree) === "onSwitch");
      if (attr?.initializer && ts.isJsxExpression(attr.initializer)) callback = attr.initializer.expression;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert.ok(callback);
  const js = ts.transpileModule(`const switchFromList = ${callback.getText(tree)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const old = { activeRelayId: "a", relayBaseUrl: "old", relayApiKey: "old-key", activeAggregateRelayId: "old-aggregate" } as BackendSettings;
  const synced = { ...old, activeRelayId: "b", relayBaseUrl: "new", relayApiKey: "new-key", activeAggregateRelayId: "" };
  const order: string[] = [];
  const invoke = new Function("normalized", "syncLegacyRelayFields", "actions", js + "return switchFromList;")(
    old, (next: BackendSettings) => { assert.equal(next.activeRelayId, "b"); order.push("sync"); return synced; },
    { switchRelayProfile: (next: BackendSettings, previous: string) => { assert.equal(next, synced); assert.equal(previous, "a"); order.push("switch"); } },
  );
  invoke("b");
  assert.deepEqual(order, ["sync", "switch"]);
  assert.equal(old.activeRelayId, "a");
});

test("聚合供应商按钮实际调用传入的创建回调", () => {
  const module = compile(readFileSync(new URL("./components/providers/ProviderImportActions.tsx", import.meta.url), "utf8"), dependencies);
  const render = module.ProviderImportActions as (props: Record<string, unknown>) => Element;
  let calls = 0;
  const root = render({ onCreateAggregate: () => calls++, thirdPartyOpen: false });
  const found = find(root, node => node.type === "button" && Array.isArray(node.props.children) && node.props.children.includes("添加聚合供应商"));
  assert.ok(found);
  click(found);
  assert.equal(calls, 1);
});
