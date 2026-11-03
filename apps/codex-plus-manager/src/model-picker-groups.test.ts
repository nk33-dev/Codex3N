import assert from "node:assert/strict";
import { it } from "node:test";
import { readFile } from "node:fs/promises";

/**
 * 模型选择器分组折叠（聚合供应商场景）的契约测试。
 *
 * 字段与生命周期约束用源码断言；分组和折叠运行真实函数，浏览器行为由
 * scripts/model-picker-ui-smoke.mjs 验证。覆盖三类约束：
 *   1. 与后端约定的字段名不能漂（`codex_plus_group` / `codex_plus_group_id`）；
 *   2. 影响别人的行为约束：不搬动 React 管理的行、隐藏原生标签要退出无障碍树、
 *      单供应商不接管、聚合目录里"默认成员"那一组要能看懂；
 *   3. 自己的扫描/清理路径不能漏（否则会闪、会自喂扫描循环）。
 */

const SHARD_URL = new URL(
  "../../../assets/inject/renderer-inject/71-model-picker-groups.js",
  import.meta.url,
);
const MANIFEST_URL = new URL(
  "../../../assets/inject/renderer-inject/manifest.json",
  import.meta.url,
);

async function readShard() {
  return await readFile(SHARD_URL, "utf8");
}

it("分组折叠分片在 manifest 里排在模型目录之后、并在组装产物里", async () => {
  const manifest = JSON.parse(await readFile(MANIFEST_URL, "utf8")) as {
    fragments: Array<{ name: string }>;
  };
  const names = manifest.fragments.map((fragment) => fragment.name);
  const index = names.indexOf("71-model-picker-groups.js");
  assert.ok(index > 0, "分片必须登记进 manifest.json");
  assert.ok(
    names.indexOf("70-model-catalog.js") < index,
    "要排在 70-model-catalog.js 之后：它依赖 codexModelCatalog 快照",
  );
  assert.ok(
    names.indexOf("99-tail.js") > index,
    "必须排在 IIFE 收尾之前，否则代码不在主闭包里",
  );

  const artifact = await readFile(
    new URL("../../../assets/inject/renderer-inject.js", import.meta.url),
    "utf8",
  );
  assert.match(artifact, /codexPlusModelPickerGroupsRuntime/, "组装产物里要有本分片");
});

it("分组折叠读的字段名与后端发布一致", async () => {
  const source = await readShard();
  // 后端 aggregate_catalog.rs 发布 / model_suffix.rs 放行的两个键。
  assert.match(source, /entry\.codex_plus_group\b/);
  assert.match(source, /entry\.codex_plus_group_id\b/);
});

it("不搬动 React 管理的行，只用类名隐藏", async () => {
  const source = await readShard();
  // 行必须留在原位：只允许插标题/工具条、加类名和属性。
  assert.doesNotMatch(source, /appendChild\(entry\.row\)|appendChild\(row\)/);
  assert.doesNotMatch(source, /\.row\.remove\(\)/);
  assert.match(source, /codex-plus-model-group-collapsed\{display:none!important\}/);
  // 折叠状态必须落在行自己的类名上，而不是重排 DOM。
  assert.match(source, /classList\.toggle\("codex-plus-model-group-collapsed"/);
});

it("隐藏原生标签时同步退出无障碍树，避免读屏念两遍", async () => {
  const source = await readShard();
  assert.match(source, /native\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(source, /native\.removeAttribute\("aria-hidden"\)/);
});

it("只有一个供应商时不接管原生列表", async () => {
  const source = await readShard();
  assert.match(source, /if \(groups\.length < 2\) \{/);
  // 单组时要能退回原始状态。
  assert.match(source, /codexPlusModelPickerClear\(list\)/);
  assert.match(source, /list\.removeAttribute\("data-codex-plus-model-groups"\)/);
});

it("默认成员的裸名模型归到默认供应商分组，不产生空标题", async () => {
  const source = await readShard();
  // 分组名解析：优先 codex_plus_group，其次 description 的 "上游 · 供应商"。
  assert.match(source, /const separator = description\.lastIndexOf\(" · "\)/);
  assert.match(source, /codexPlusModelPickerDefaultProviderName/);
  assert.doesNotMatch(source, /group\.id = "__ungrouped__"/);
});

async function pickerRuntime(catalog: Record<string, unknown> = {}, saved: unknown = null) {
  let stored = saved ? JSON.stringify(saved) : null;
  return new Function("catalog", "storage", `
    const codexModelCatalog = catalog;
    const window = { localStorage: storage };
    const document = { documentElement: { lang: "zh" }, getElementById: () => ({}) };
    const navigator = { language: "zh" };
    const registerCodexPlusExtensionSelector = () => {};
    const setTimeout = () => 0, clearTimeout = () => {};
    ${await readShard()}
    codexPlusModelPickerStore();
    return {
      rows: codexPlusModelPickerRows,
      groups: (rows) => codexPlusModelPickerUniqueGroupIds(codexPlusModelPickerGroups(rows)),
      toggle: (group) => {
        codexPlusModelPickerToggleGroup({ querySelector: () => null }, group);
      },
      expanded: codexPlusModelPickerGroupExpanded,
      state: codexPlusModelPickerGroupsState,
    };
  `)(catalog, { getItem: () => stored, setItem: (_key: string, value: string) => { stored = value; } });
}

function modelRow(text: string) {
  const label = { textContent: text, classList: { contains: () => false }, getAttribute: () => null };
  const outer = { firstElementChild: { children: [label], firstElementChild: label } };
  const content = { querySelector: (selector: string) => selector.startsWith("span.") ? outer : null };
  return {
    querySelector: () => content,
    getAttribute: () => null,
    setAttribute() {},
    classList: { toggle() {} },
  };
}

it("系统默认合并原生与补充模型，其他供应商和自动入口独立归组", async () => {
  const runtime = await pickerRuntime({
    codex_plus_default_group_id: "default-id",
    modelMetadata: {
      "gpt-6.1-sol": { displayName: "GPT-6.1-Sol", codex_plus_group: "系统默认", codex_plus_group_id: "default-id", codex_plus_default: true },
      "default-id/deepseek": { displayName: "DeepSeek（系统默认）", codex_plus_group: "系统默认", codex_plus_group_id: "default-id" },
      opus: { displayName: "Claude-Opus-5-5", codex_plus_group: "分组1", codex_plus_group_id: "vendor-id" },
      "vendor-id/deepseek": { displayName: "DeepSeek（分组1）", codex_plus_group: "分组1", codex_plus_group_id: "vendor-id" },
      deepseek: { displayName: "DeepSeek（自动）", codex_plus_group: "自动组", codex_plus_group_id: "auto-id" },
    },
  });
  const rows = runtime.rows({ querySelectorAll: () => [
    modelRow("6.1 Sol"), modelRow("DeepSeek（系统默认）"), modelRow("Claude-Opus-5-5"),
    modelRow("DeepSeek（分组1）"), modelRow("DeepSeek（自动）"), modelRow("5.6 Sol"),
  ] });
  const groups = runtime.groups(rows);
  assert.deepEqual(groups.map((group: any) => [group.id, group.name, group.entries.length]), [
    ["default-id", "系统默认", 3], ["vendor-id", "分组1", 2], ["auto-id", "自动组", 1],
  ]);
  runtime.toggle(groups[1]);
  assert.equal(runtime.expanded(groups[0]), true);
  assert.equal(runtime.expanded(groups[1]), false);
  assert.equal(runtime.expanded(groups[2]), true);
});

it("缺少标题的不同身份仍有可见标题，折叠状态不串组", async () => {
  const runtime = await pickerRuntime();
  const groups = runtime.groups([
    { groupId: "a", provider: "", label: "A", row: modelRow("A") },
    { groupId: "b", provider: "", label: "B", row: modelRow("B") },
  ]);
  assert.deepEqual(groups.map((group: any) => group.id), ["a", "b"]);
  assert.ok(groups.every((group: any) => group.name.length > 0));
  runtime.toggle(groups[0]);
  assert.equal(runtime.expanded(groups[1]), true);
});

it("切换供应商目录后清理旧归属，恢复时读取当前默认身份", async () => {
  const catalog: Record<string, any> = {
    model_provider: "first",
    codex_plus_default_group_id: "a",
    modelMetadata: { custom: { displayName: "Custom", codex_plus_group: "分组1", codex_plus_group_id: "a" } },
  };
  const runtime = await pickerRuntime(catalog);
  const list = { querySelectorAll: () => [modelRow("Custom")] };
  assert.equal(runtime.rows(list)[0].groupId, "a");
  catalog.model_provider = "second";
  catalog.codex_plus_default_group_id = "b";
  catalog.modelMetadata = { custom: { displayName: "Custom", codex_plus_group: "分组2", codex_plus_group_id: "b" } };
  const groups = runtime.groups(runtime.rows(list));
  assert.equal(groups[0].id, "b");
  assert.equal(groups[0].name, "分组2");
});

it("记住的默认身份不会阻止目录首次加载", async () => {
  const source = await readShard();
  const start = source.indexOf("  function codexPlusModelPickerEnsureCatalog()");
  const end = source.indexOf("\n  /**", start);
  let loads = 0;
  const ensure = new Function("loadCodexModelCatalog", `
    const codexModelCatalog = { status: "loading" };
    const codexPlusModelPickerGroupsState = { defaultGroupId: "saved", catalogRetryAt: 0 };
    ${source.slice(start, end)}
    return codexPlusModelPickerEnsureCatalog;
  `)(async () => { loads++; });
  ensure();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 1);
});

it("扫描器自己插的节点都带归属标记，避免自喂扫描循环", async () => {
  const source = await readShard();
  assert.match(
    source,
    /registerCodexPlusExtensionSelector\('\[data-codex-plus-ext="builtin-model-picker-groups"\]'\)/,
    "必须登记扩展选择器，否则扫描调度器会把我们插的标题当成 Codex 原生节点",
  );
  const marks = source.match(/data-codex-plus-ext", codexPlusModelPickerGroupsExtMark/g) ?? [];
  assert.ok(marks.length >= 4, "标题、工具条、行、标签都要打标记");
});

it("菜单关闭或组件重建后能自愈，不留下清不掉的残留", async () => {
  const source = await readShard();
  // React 回收兄弟节点后标题会消失，指纹没变也必须重建。
  assert.match(source, /codexPlusModelPickerHeadersIntact/);
  assert.match(source, /header\.nextElementSibling === first/);
  // 恢复时要摘干净自己加的类名与属性。
  assert.match(source, /row\.removeAttribute\(codexPlusModelPickerGroupAttr\)/);
  assert.match(source, /native\.removeAttribute\("data-codex-plus-ext"\)/);
});

it("重注入时与上一个实例交接，不先拆再建造成闪烁", async () => {
  const source = await readShard();
  assert.match(source, /window\.__codexPlusModelPickerGroupsRuntime\?\.dispose\?\.\(\)/);
  const dispose = source.match(/dispose\(\) \{[\s\S]*?\n    \},/)?.[0];
  assert.ok(dispose, "要有 dispose 实现");
  assert.doesNotMatch(dispose, /codexPlusModelPickerClear/, "dispose 不能顺手拆 DOM：重注入会闪");
  assert.match(source, /releaseDom\(\)/, "彻底还原要有单独出口");
});

it("折叠状态按分组 id 持久化，并且有中文文案", async () => {
  const source = await readShard();
  assert.match(source, /codexPlus\.modelPicker\.collapsedGroups\.v1/);
  assert.match(source, /全部展开/);
  assert.match(source, /全部折叠/);
  // 读屏文案要带展开/折叠状态。
  assert.match(source, /groupAria/);
});

it("默认供应商带「默认」标志，身份来自目录而不是猜名字", async () => {
  const source = await readShard();
  // 顶层 id 优先，其次目录条目的 default 标记，最后才是会话内记住的值。
  assert.match(source, /codex_plus_default_group_id/);
  assert.match(source, /codex_plus_default\b/);
  assert.match(source, /defaultGroupId/);
  // 标志要能随扫描补齐/摘掉，而不是建标题时定一次。
  assert.match(source, /codexPlusModelPickerSyncDefaultBadge/);
  assert.match(source, /codex-plus-model-group-default/);
  assert.match(source, /defaultBadge: "默认"/);
  // 默认分组在 id 去重改写之前先认出来，且按组内任意一行命中判定。
  assert.match(source, /group\.isDefault = !!defaultGroupId/);
  // 没有选中模型时优先展开默认供应商。
  assert.match(source, /keep = groups\.find\(\(group\) => group\.isDefault\)\?\.id/);
});

it("目录条目按别名匹配，且只用它补分组 id、不用它决定显示归属", async () => {
  const source = await readShard();
  // 目录的展示名（GPT-6.1-Sol）与选择器里的行（6.1 Sol）不一样，必须登记别名。
  assert.match(source, /codexPlusModelPickerCatalogAliases/);
  assert.match(source, /replace\(\/\^gpt\[-\\s\]\*\/iu, ""\)/);
  // 早期版本的教训：拿目录展示名去拟合行文本会把同一家切成好几段。
  assert.match(source, /const groupId = known\?\.groupId/);
  // 只有整行精确命中目录（含 `（后缀）` 的完整展示名）时，才用目录里的分组名做显示归属：
  // 网关把同名模型的后几家写成 `名字（供应商 id）`，标题要显示打过码的完整账号名；别名命中仍不决定归属。
  assert.match(source, /const provider = exactKnown\?\.provider \|\| split\.provider \|\| known\?\.provider/);
  // 先按原文比（网关关掉「模型名后带供应商」时同名几份只差零宽字符），再按宽松归一化比。
  assert.match(source, /const exactKnown = exact\.get\(`raw\\u0000\$\{identity\.text\}`\)\s*\|\| exact\.get\(codexPlusModelPickerNormalizeLoose\(identity\.text\)\)/);
  assert.match(source, /const rawKey = `raw\\u0000\$\{String\(displayName\)/);
  // 组内任意一行命中默认分组即认定该组是默认（裸名行的 id 可能来自目录）。
  assert.match(source, /group\.entries\.some\(\(entry\) => entry\.groupId === defaultGroupId/);
});

it("表头右端对齐：标题撑满剩余空间，不靠 auto 外边距推计数", async () => {
  const source = await readShard();
  // 回归：用 `margin-left:auto` 把计数推到右边时，多出「默认」徽标的那一行 auto 外边距
  // 会被吃掉，数字紧跟在徽标后面，与其它行错位。
  assert.match(source, /codex-plus-model-group-title\{flex:1 1 auto/);
  assert.doesNotMatch(
    source,
    /codex-plus-model-group-count\{flex:0 0 auto;margin-left:auto/,
    "计数不能再用 margin-left:auto 定位",
  );
});

it("默认标志不改变无障碍语义：读屏会念出「默认供应商」", async () => {
  const source = await readShard();
  assert.match(source, /（默认供应商）/);
  assert.match(source, /\(default provider\)/);
});

it("在 Codex++ 里收藏的模型在选择器行尾画星标，取消收藏或还原时拿掉", async () => {
  const source = await readShard();
  assert.match(source, /favorite: entry\.codex_plus_favorite === true/);
  assert.match(source, /favorite: exactKnown\?\.favorite === true/);
  assert.match(source, /codexPlusModelPickerFavoriteClass = "codex-plus-model-group-favorite"/);
  // 星标节点带归属标记，扫描不会把它当成原生标签，也不会自喂循环。
  assert.match(source, /star\.setAttribute\("data-codex-plus-ext", codexPlusModelPickerGroupsExtMark\)/);
  assert.match(source, /content\.querySelector\(`\.\$\{codexPlusModelPickerFavoriteClass\}`\)\?\.remove\(\)/);
});
