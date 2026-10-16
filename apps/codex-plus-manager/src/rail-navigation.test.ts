import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const fragment = (name: string) => readFileSync(new URL(`../../../assets/inject/renderer-inject/${name}`, import.meta.url), "utf8");
function extract(file: string, name: string) {
  const source = fragment(file).match(new RegExp(`^  function ${name}\\([^]*?^  \\}`, "m"))?.[0];
  assert.ok(source, name);
  return source;
}

/** 只实现锚点和插入逻辑用到的那几个 DOM 接口。 */
class FakeNode {
  id = "";
  parentElement: FakeNode | null = null;
  children: FakeNode[] = [];
  attrs = new Map<string, string>();
  constructor(id = "", dest = "") {
    this.id = id;
    if (dest) this.attrs.set("data-sidebar-destination", dest);
  }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  get nextSibling() { const list = this.parentElement?.children || []; return list[list.indexOf(this) + 1] || null; }
  get previousElementSibling() { const list = this.parentElement?.children || []; return list[list.indexOf(this) - 1] || null; }
  append(...nodes: FakeNode[]) { nodes.forEach((node) => this.insertBefore(node, null)); return this; }
  insertBefore(node: FakeNode, before: FakeNode | null) {
    node.remove();
    const index = before ? this.children.indexOf(before) : -1;
    if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
    node.parentElement = this;
    return node;
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  descendants(): FakeNode[] { return this.children.flatMap((child) => [child, ...child.descendants()]); }
  querySelectorAll(selector: string) {
    const dest = selector.match(/data-sidebar-destination="([^"]+)"/)?.[1];
    return this.descendants().filter((node) => node.attrs.has("data-sidebar-destination") && (!dest || node.getAttribute("data-sidebar-destination") === dest));
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] || null; }
}

function railRuntime() {
  const homeGroup = new FakeNode().append(new FakeNode("", "builtin:home"));
  const customize = new FakeNode("", "builtin:customize");
  const group = new FakeNode().append(homeGroup, customize, new FakeNode("more"));
  const rail = new FakeNode().append(new FakeNode("top"), group);
  const all = () => [rail, ...rail.descendants()];
  const context = vm.createContext({
    codexPlusRailSelector: "nav", codexPlusRailDestinationSelector: "[data-sidebar-destination]",
    codexPlusRailNavId: "codex-plus-rail-nav", codexPlusRailExtensionsId: "codex-plus-rail-extensions",
    codexPlusMenuId: "codex-plus-menu", codexPlusBackendStatus: { status: "ok" },
    codexPlusRailTemplateButton: () => null,
    createCodexPlusRailButton: ({ id }: any) => new FakeNode(id),
    openCodexPlusPage() {}, openCodexPlusExtensions() {}, closeCodexPlusPageAfterNativeNavigation() {},
    codexPlusExtensionConstants: { extensionAttribute: "data-codex-plus-ext" },
    codexPlusDefaultExtensionIconPath: "",
    Element: FakeNode,
    document: {
      querySelector: (selector: string) => selector === "nav" ? rail : null,
      querySelectorAll: () => [],
      getElementById: (id: string) => all().find((node) => node.id === id) || null,
    },
  });
  rail.attrs.set("data-app-navigation-rail", "");
  (rail as any).dataset = { codexPlusRailNavigationListener: "true" };
  vm.runInContext([
    extract("40-backend-settings.js", "codexPlusRailPrimaryAnchor"),
    extract("40-backend-settings.js", "codexPlusRailInsertAnchor"),
    extract("40-backend-settings.js", "installCodexPlusRailNavigation"),
  ].join("\n"), context);
  const order = () => group.children.map((node) => node.id || node.getAttribute("data-sidebar-destination") || "home-group");
  return { context, rail, group, customize, order };
}

test("启动时只有主页和自定义，入口插在主页之后而不是图标栏顶部", () => {
  const app = railRuntime();
  assert.equal(app.context.installCodexPlusRailNavigation(), true);
  assert.deepEqual(app.order(), ["home-group", "codex-plus-rail-nav", "codex-plus-rail-extensions", "builtin:customize", "more"]);
  assert.equal(app.rail.children[0].id, "top", "不能插到 rail 顶层");
});

test("自动化晚到后，下一次扫描把入口挪到它后面，重复安装不再移动", () => {
  const app = railRuntime();
  app.context.installCodexPlusRailNavigation();
  app.group.insertBefore(new FakeNode("", "builtin:automations"), app.group.children[1]);
  app.context.installCodexPlusRailNavigation();
  const expected = ["home-group", "builtin:automations", "codex-plus-rail-nav", "codex-plus-rail-extensions", "builtin:customize", "more"];
  assert.deepEqual(app.order(), expected);
  let moves = 0;
  const insert = app.group.insertBefore.bind(app.group);
  app.group.insertBefore = (node, before) => { moves++; return insert(node, before); };
  app.context.installCodexPlusRailNavigation();
  assert.equal(moves, 0);
  assert.deepEqual(app.order(), expected);
});

test("原生按钮都还没渲染时先不插入", () => {
  const app = railRuntime();
  app.group.children.splice(0);
  assert.equal(app.context.installCodexPlusRailNavigation(), true);
  assert.equal(app.context.document.getElementById("codex-plus-rail-nav"), null);
});
