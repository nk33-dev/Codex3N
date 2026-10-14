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

test("服务模式跟随模型按钮，忽略输入区、供应商同名项目及自己的徽章", () => {
  let hasModel = true;
  const footer: any = { children: [], querySelector: () => hasModel ? model : null };
  const controls: any = { display: "flex", parentElement: footer };
  const wrapper: any = { display: "contents", parentElement: controls };
  const model = { parentElement: wrapper };
  const editor = { matches: () => false, querySelector: () => ({}), querySelectorAll: () => { throw Error("不能扫描输入区按钮"); } };
  const badge = { matches: () => true, querySelector: () => null };
  const group = { matches: () => false, querySelector: () => null, querySelectorAll: () => [model] };
  footer.children = [editor, group, badge];
  const context = vm.createContext({
    codexServiceTierComposerFooter: () => footer,
    codexServiceTierBadgeVisibleElement: () => true,
    isExtensionUiNode: () => false,
    getComputedStyle: (node: any) => ({ display: node.display }),
  });
  vm.runInContext(extract("90-action-groups.js", "codexServiceTierBadgePlacement"), context);
  for (const legacy of [false, true]) {
    hasModel = !legacy;
    const placement = context.codexServiceTierBadgePlacement({ textContent: "同名供应商项目" });
    assert.equal(placement.parent, controls);
    assert.equal(placement.before, wrapper);
  }
  const block = { display: "block", parentElement: controls };
  wrapper.parentElement = block;
  assert.equal(context.codexServiceTierBadgePlacement({}).before, block);
  wrapper.parentElement = controls;
  controls.display = "grid";
  assert.equal(context.codexServiceTierBadgePlacement({}), null, "不能把徽章放到未知 grid 行");
});

test("重复安装徽章没有DOM写入，模型包裹层替换后只移动一次", () => {
  let writes = 0;
  let before: any = {};
  const parent: any = { insertBefore(node: any, anchor: any) { writes++; node.parentElement = parent; node.nextSibling = anchor; } };
  before.parentElement = parent;
  const badge = { dataset: { codexServiceTierBadgeVersion: "4" }, parentElement: parent, nextSibling: before, closest: () => ({}) };
  const context = vm.createContext({
    codexPlusSettings: () => ({ serviceTierControls: true }),
    codexServiceTierFindComposerEl: () => ({}),
    codexServiceTierBadgePlacement: () => ({ parent, before }),
    document: { querySelectorAll: () => [badge] },
    codexServiceTierComposerFooterSelector: "footer", codexServiceTierBadgeVersion: "4",
    wireCodexServiceTierBadge() {}, refreshCodexServiceTierBadges() {},
  });
  vm.runInContext(extract("90-action-groups.js", "installCodexServiceTierBadge"), context);
  for (let i = 0; i < 50; i++) context.installCodexServiceTierBadge();
  assert.equal(writes, 0);
  before = { parentElement: parent };
  context.installCodexServiceTierBadge();
  context.installCodexServiceTierBadge();
  assert.equal(writes, 1);
});

test("相同服务模式不写文字或属性，加载态禁用切换", () => {
  let writes = 0;
  const values: Record<string, any> = {};
  const attributes = new Map();
  const badge = new Proxy({
    dataset: new Proxy({}, { set(target, key, value) { writes++; return Reflect.set(target, key, value); } }),
    getAttribute: (key: string) => attributes.get(key),
    setAttribute(key: string, value: string) { writes++; attributes.set(key, value); },
  }, {
    get(target, key) { return key in target ? Reflect.get(target, key) : values[String(key)]; },
    set(_target, key, value) { writes++; values[String(key)] = value; return true; },
  });
  const backend = { status: "checking" };
  const tier = { status: "loading" };
  const context = vm.createContext({ document: { querySelectorAll: () => [badge] },
    codexPlusBackendStatus: backend, codexServiceTierState: tier });
  vm.runInContext(["codexServiceTierBadgeState", "refreshCodexServiceTierBadges"].map(name => extract("30-service-tier.js", name)).join("\n"), context);
  context.refreshCodexServiceTierBadges();
  assert.equal(values.textContent, "读取中");
  assert.equal(attributes.get("aria-disabled"), "true");
  const firstWrites = writes;
  for (let i = 0; i < 50; i++) context.refreshCodexServiceTierBadges();
  assert.equal(writes, firstWrites);
  backend.status = "ok";
  assert.equal(context.codexServiceTierBadgeState().disabled, true);
});

test("侧栏操作组、菜单和提示的DOM变化不触发增强扫描", () => {
  const context = vm.createContext(Object.fromEntries([
    "actionGroupClass", "moreMenuClass", "actionTooltipClass", "codexPlusPageClass", "codexPlusSidebarNavId",
    "codexPlusRailNavId", "codexPlusRailExtensionsId", "codexPlusRailSponsorId", "codexServiceTierBadgeClass",
    "sessionShareButtonClass", "sessionCopyMenuItemClass", "capacityAutoRetryChipId",
  ].map(name => [name, name])));
  context.isCodexPlusExtensionNode = () => false;
  vm.runInContext(extract("98-scan-schedule.js", "isExtensionUiNode"), context);
  for (const name of ["actionGroupClass", "moreMenuClass", "actionTooltipClass"]) {
    assert.equal(context.isExtensionUiNode({ closest: (selector: string) => selector.split(", ").includes(`.${name}`) ? {} : null }), true);
  }
});
