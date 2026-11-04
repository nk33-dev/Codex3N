import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = await mkdtemp(path.join(tmpdir(), "codex3n-model-picker-"));
const shard = name => readFile(path.join(root, "assets/inject/renderer-inject", name), "utf8");
const catalogSource = await shard("70-model-catalog.js");
const sortSource = catalogSource.slice(catalogSource.indexOf("  function sortModelChoices("), catalogSource.indexOf("  function modelArrayLooksPatchable("));
const groupsSource = await shard("71-model-picker-groups.js");
const definitions = [
  ["gpt-6.1-sol", "GPT-6.1-Sol", "default", "系统默认"],
  ["gpt-6-astra", "GPT-6-Astra", "default", "系统默认"],
  ["gpt-5.4", "GPT-5.4", "default", "系统默认"],
  ["gpt-5.6-sol", "GPT-5.6-Sol", "default", "系统默认"],
  ["default/deepseek", "DeepSeek（系统默认）", "default", "系统默认"],
  ["opus", "Claude-Opus-5-5", "vendor", "分组1"],
  ["sonnet", "Claude-Sonnet-5-5", "vendor", "分组1"],
  ["haiku", "Claude-Haiku-5-5", "vendor", "分组1"],
  ["vendor/deepseek", "DeepSeek（分组1）", "vendor", "分组1"],
  ["deepseek", "DeepSeek（自动）", "auto", "自动组"],
];
const metadata = Object.fromEntries(definitions.map(([slug, displayName, id, name]) => [
  slug, { displayName, codex_plus_group_id: id, codex_plus_group: name, codex_plus_default: id === "default" },
]));
const html = `<!doctype html><html lang="zh"><meta charset="utf-8"><style>
body{margin:0;padding:10px;background:#202020;color:#ddd;font:14px system-ui;letter-spacing:0;--color-token-text-primary:#ddd;--color-token-text-secondary:#aaa;--color-token-bg-secondary:#303030}
body.light{background:#fff;color:#202020;--color-token-text-primary:#202020;--color-token-text-secondary:#606060;--color-token-bg-secondary:#eee}
[data-model-picker-view]{width:100%;max-width:340px}
.fixture_ModelList_items{display:flex;flex-direction:column}
[role=menuitemradio]{display:flex;align-items:center;width:100%;min-height:34px;background:none;border:0;color:inherit;font:inherit;text-align:left;padding:6px 8px;border-radius:8px;box-sizing:border-box}
[role=menuitemradio]:hover{background:#8882}
[data-menu-row-content],.flex-1{display:flex;flex:1;min-width:0}
.truncate{display:flex;flex:1;min-width:0}
</style><div data-model-picker-view="simple"><div class="fixture_ModelList_items"></div></div>
<script>
let codexModelCatalog={status:"ok",model_provider:"gateway",codex_plus_default_group_id:"default",
model_order:${JSON.stringify(definitions.map(row => row[0]))}, modelMetadata:${JSON.stringify(metadata)}};
function registerCodexPlusExtensionSelector(){}
async function loadCodexModelCatalog(){return codexModelCatalog}
${sortSource}
const entries=${JSON.stringify([...definitions].reverse())};
sortModelChoices(entries,entry=>entry[0]);
for(const [slug,name] of entries){
 const row=document.createElement("button");
 row.setAttribute("role","menuitemradio"); row.dataset.slug=slug;
 if(slug==="gpt-5.4")row.setAttribute("data-model-selected","true");
 const content=document.createElement("div");content.setAttribute("data-menu-row-content","");
 const outer=document.createElement("span");outer.className="flex-1";
 const inner=document.createElement("span");inner.className="truncate";
 const label=document.createElement("span");label.textContent=name.replace(/^GPT-/,"").replaceAll("-"," ");
 if(!name.startsWith("GPT-"))label.textContent=name;
 inner.append(label);outer.append(inner);content.append(outer);row.append(content);
 document.querySelector(".fixture_ModelList_items").append(row);
}
${groupsSource}
window.fixture={scan:()=>window.__codexPlusModelPickerGroupsRuntime.scan(),
groups:()=>window.__codexPlusModelPickerGroupsRuntime.groupsFor(document),
rename:()=>{for(const entry of Object.values(codexModelCatalog.modelMetadata)){
if(entry.codex_plus_group_id==="vendor")entry.codex_plus_group="分组1 · "+ "供应商名称".repeat(15);
}window.fixture.scan()}};
window.fixture.scan();
</script></html>`;
const fixture = path.join(output, "models.html");
await writeFile(fixture, html);
const child = spawn(process.env.CODEX_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${path.join(output, "browser")}`, "about:blank"],
  { windowsHide: true, stdio: "ignore" });
let socket;
let sequence = 0;
const pending = new Map();
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const response = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert.equal(response.exceptionDetails, undefined, JSON.stringify(response.exceptionDetails));
  return response.result.value;
};
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      port = Number((await readFile(path.join(output, "browser/DevToolsActivePort"), "utf8")).split("\n")[0]);
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(port, "隔离浏览器应启动");
  const pages = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json());
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.error) item.reject(Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  };
  await call("Page.enable");
  await call("Page.navigate", { url: `file:///${fixture.replaceAll("\\", "/")}` });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evaluate("!!window.fixture")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const groups = await evaluate("window.fixture.groups()");
  assert.deepEqual(groups.map(group => [group.id, group.name, group.count]), [
    ["default", "系统默认", 5], ["vendor", "分组1", 4], ["auto", "自动组", 1],
  ]);
  await evaluate(`document.querySelector('[data-codex-plus-model-group-id="vendor"]').click();window.fixture.scan()`);
  assert.equal(await evaluate(`document.querySelector('[data-codex-plus-model-groups]').getAttribute("data-codex-plus-model-provider-view")`), "models");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  assert.equal(await evaluate(`document.querySelector('[data-codex-plus-model-groups]').getAttribute("data-codex-plus-model-provider-view")`), "providers");
  await evaluate(`document.querySelector('[data-codex-plus-model-group-id="vendor"]').focus()`);
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
  await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  assert.equal(await evaluate(`document.querySelector('[data-codex-plus-model-groups]').getAttribute("data-codex-plus-model-provider-view")`), "models");
  await evaluate(`document.querySelector('[data-codex-plus-model-group-id="vendor"]').click();window.fixture.rename();window.fixture.scan()`);
  for (const [width, light] of [[310, false], [400, true]]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.body.classList.toggle("light",${light})`);
    assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
    assert.equal(await evaluate(`document.querySelectorAll(".codex-plus-model-group-header").length`), 3);
    assert.equal(await evaluate(`!!document.querySelector('.codex-plus-model-group-header .codex-plus-model-group-title:empty')`), false);
    const screenshot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(output, `models-${width}.png`), Buffer.from(screenshot.data, "base64"));
  }
  console.log(JSON.stringify({ status: "ok", output, groups: groups.length, keyboard: true, providerNavigation: true, viewports: [310, 400] }));
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await call("Browser.close"); } catch {}
    socket.close();
  }
  for (const item of pending.values()) clearTimeout(item.timer);
  if (child.exitCode === null) {
    await new Promise(resolve => { child.once("exit", resolve); setTimeout(resolve, 5000).unref(); });
  }
}
