// 在独立 Edge 目录验证真实 DOM 和 React 面板；模型及持久化由专门的 Rust 测试覆盖。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const manager = path.join(root, "apps/codex-plus-manager");
const require = createRequire(path.join(manager, "package.json"));
const { build } = require("esbuild");
const output = await mkdtemp(path.join(tmpdir(), "codex3n-prompt-ui-"));
const browser = process.env.CODEX_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const fixtureState = `window.fixture={favorites:[],feedback:[],requests:[]};
window.fixtureRequest=async(action,payload={})=>{
  const state=window.fixture;state.requests.push({action,payload});
  if(action==='library/list')return{status:'ok',favorites:state.favorites.filter(x=>!payload.query||[x.title,x.body,...x.tags].join(' ').includes(payload.query))};
  if(action==='library/save'){const item={...payload,id:payload.id||crypto.randomUUID()};state.favorites=state.favorites.filter(x=>x.id!==item.id);state.favorites.push(item);return{status:'ok',favorite:item};}
  if(action==='library/delete')state.favorites=state.favorites.filter(x=>x.id!==payload.id);
  if(action==='feedback/save')state.feedback.push({...payload,id:crypto.randomUUID(),createdAt:Date.now()});
  if(action==='feedback/list')return{status:'ok',feedback:state.feedback};
  if(action==='generate')return{status:'ok',text:'请修复登录错误，并补充回归验证。',metadata:{mode:payload.mode||'rewrite',scenario:payload.scenario||'general',model:'fixture',systemPrompt:'规则'}};
  return{status:'ok'};
};`;
const mockApi = path.join(output, "api.js");
await writeFile(mockApi, "export async function invoke(command,args){return window.fixtureRequest(args.action,args.payload)}");
const entry = path.join(output, "manager-entry.tsx");
await writeFile(entry, `import {createRoot} from ${JSON.stringify(path.join(manager, "node_modules/react-dom/client.js"))};
import {PromptToolsPanel} from ${JSON.stringify(path.join(manager, "src/prompt-tools.tsx"))};
createRoot(document.getElementById('app')).render(<PromptToolsPanel/>);`);
const bundled = await build({ entryPoints: [entry], bundle: true, write: false, format: "iife", jsx: "automatic", platform: "browser",
  nodePaths: [path.join(manager, "node_modules")], alias: { "@": path.join(manager, "src"), "@tauri-apps/api/core": mockApi },
});
const fragment = async (name) => readFile(path.join(root, "assets/inject/renderer-inject", name), "utf8");
const injected = `(()=>{
const codexPlusBackendSettingsLoaded=true,codexPlusBackendSettings={enhancementsEnabled:true,promptEnhance:{enabled:true,rewriteEnabled:true,grillEnabled:true}};
function registerCodexPlusExtensionSelector(){} function visibleElement(){return true} function isExtensionUiNode(){return false}
function codexPlusDictationScope(x){return x} function codexPlusDictationEditor(x){return x?.querySelector('textarea')}
function codexPlusDictationFooterScore(){return 1} function codexPlusDictationView(){return null}
async function loadOptionalCodexAppModule(){return{}} function showToast(text){window.lastToast=text}
async function postJson(url,data){return window.fixtureRequest(url.replace('/prompt-enhance/',''),data)}
${await fragment("93-prompt-enhance-context.js")}
${await fragment("93-prompt-enhance.js")}
${await fragment("93-prompt-library.js")}
document.querySelector('textarea').__reactFiber$fixture={memoizedProps:{kind:'local',hostId:'local',cwd:'D:/fixture'}};
window.promptFixture={install:installCodexPlusPromptEnhance,state:codexPlusPromptEnhance,library:codexPlusPromptLibrary,settings:codexPlusBackendSettings};
installCodexPlusPromptEnhance();})();`;
const cssFile = (await readdir(path.join(manager, "dist/assets"))).find((name) => name.endsWith(".css"));
const css = await readFile(path.join(manager, "dist/assets", cssFile), "utf8");
const server = createServer((request, response) => {
  if (request.url === "/manager.js") { response.setHeader("content-type", "application/javascript"); response.end(bundled.outputFiles[0].text); return; }
  if (request.url === "/injected.js") { response.setHeader("content-type", "application/javascript"); response.end(injected); return; }
  if (request.url === "/style.css") { response.setHeader("content-type", "text/css"); response.end(css); return; }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><style>body{margin:0;padding:16px;box-sizing:border-box;width:100%;min-width:0;background:#202124;color:#eee}button{cursor:pointer}.composer-footer{margin-top:460px}textarea{width:90%;height:80px}</style>
    <script>${fixtureState}</script>${request.url === "/manager" ? '<div id="app"></div><script src="/manager.js"></script>' : '<div class="composer-footer" style="display:grid;grid-template-columns:auto 1fr"><textarea style="grid-column:1/-1">修复登录错误</textarea><div class="flex" style="display:flex"><button data-composer-navigation-target="permissions">权限</button></div></div><script src="/injected.js"></script>'}`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${path.join(output, "browser")}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
let socket, serial = 0; const pending = new Map();
const delay = () => new Promise((resolve) => setTimeout(resolve, 100));
async function eventually(fn, label) { for (let n = 0; n < 150; n++) { if (await fn()) return; await delay(); } throw new Error(`等待超时：${label}`); }
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, 15000);
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function click(text, within = "document") { await evaluate(`[...${within}.querySelectorAll('button')].find(x=>x.textContent===${JSON.stringify(text)})?.click()`); }
async function setValue(selector, value) {
  await evaluate(`(()=>{const x=document.querySelector(${JSON.stringify(selector)});const setter=Object.getOwnPropertyDescriptor(x.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;setter.call(x,${JSON.stringify(value)});x.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
try {
  let debugPort;
  await eventually(async () => { try { debugPort = Number((await readFile(path.join(output, "browser/DevToolsActivePort"), "utf8")).split("\n")[0]); return debugPort; } catch { return false; } }, "浏览器启动");
  const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  socket = new WebSocket(pages.find((page) => page.type === "page").webSocketDebuggerUrl);
  socket.addEventListener("message", ({ data }) => { const message = JSON.parse(data); const item = pending.get(message.id); if (item) { pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); } });
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  await call("Emulation.setDeviceMetricsOverride", { width: 400, height: 800, deviceScaleFactor: 1, mobile: false });
  await call("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await eventually(() => evaluate("!!window.promptFixture"), "注入入口");
  assert.equal(await evaluate("document.querySelector('[data-prompt-library-trigger]').parentElement===document.querySelector('[data-composer-navigation-target=permissions]').parentElement&&document.querySelector('[data-prompt-enhance-trigger]').parentElement===document.querySelector('[data-prompt-library-trigger]').parentElement"), true, "grid footer uses the native control row");
  await evaluate("document.querySelector('[data-prompt-library-trigger]').click()");
  await eventually(() => evaluate("!!document.querySelector('#codex-plus-prompt-library input[type=search]')"), "收藏列表");
  await click("收藏草稿");
  await setValue('#codex-plus-prompt-library input[aria-label="标题"]', "登录修复");
  await click("保存收藏");
  await eventually(() => evaluate("document.querySelector('#codex-plus-prompt-library .prompt-library-record summary')?.textContent.includes('登录修复')"), "保存收藏");
  await evaluate("document.querySelector('#codex-plus-prompt-library .prompt-library-record').open=true");
  assert.equal(await evaluate("document.querySelector('#codex-plus-prompt-library').getBoundingClientRect().width<=400"), true);
  assert.equal(await evaluate("!document.querySelector('#codex-plus-prompt-library .prompt-library-filters').open"), true, "filters stay folded");
  await writeFile(path.join(output, "library-400.png"), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
  const requestsBeforeIme = await evaluate("fixture.requests.length");
  await evaluate(`(()=>{const input=document.querySelector('#codex-plus-prompt-library input[type="search"]');input.dispatchEvent(new CompositionEvent('compositionstart'));input.value='登录';input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));})()`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(await evaluate("fixture.requests.length"), requestsBeforeIme, "search waits for Chinese composition to finish");
  await evaluate(`document.querySelector('#codex-plus-prompt-library input[type="search"]').dispatchEvent(new CompositionEvent('compositionend'))`);
  await eventually(() => evaluate(`fixture.requests.length>${requestsBeforeIme}`), "中文搜索");
  await setValue('#codex-plus-prompt-library input[type="search"]', "无匹配项");
  await eventually(() => evaluate("document.querySelector('#codex-plus-prompt-library')?.textContent.includes('没有匹配的收藏')"), "即时搜索");
  await setValue('#codex-plus-prompt-library input[type="search"]', "登录");
  await eventually(() => evaluate("!!document.querySelector('#codex-plus-prompt-library .prompt-library-record')"), "搜索恢复");
  await evaluate("document.querySelector('#codex-plus-prompt-library .prompt-library-record').open=true");
  await click("插入到末尾");
  await eventually(() => evaluate("document.querySelector('textarea').value.includes('\\n\\n')"), "收藏写回");
  await evaluate("document.querySelector('[data-prompt-enhance-trigger]').click()"); await call("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown" });
  assert.equal(await evaluate("document.activeElement.textContent"), "追问");
  await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Home", code: "Home" });
  assert.equal(await evaluate("document.activeElement.textContent"), "改写");
  await writeFile(path.join(output, "enhance-menu-400.png"), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
  await click("改写");
  await eventually(() => evaluate("promptFixture.state.phase==='result'"), "结果预览");
  assert.equal(await evaluate("fixture.feedback.length"), 0);
  await evaluate("[...document.querySelectorAll(\"#codex-plus-prompt-enhance-panel details\")].find(x=>x.querySelector(\"summary\")?.textContent===\"反馈\").open=true");
  await click("提交反馈"); await eventually(() => evaluate("fixture.feedback.length===1"), "主动反馈");
  await evaluate("promptFixture.settings.promptEnhance.rewriteEnabled=false;promptFixture.settings.promptEnhance.grillEnabled=false;promptFixture.install()");
  assert.equal(await evaluate("!!document.querySelector('[data-prompt-library-trigger]')&&!document.querySelector('[data-prompt-enhance-trigger]')"), true);
  for (const mode of ["rewrite", "grill"]) {
    await evaluate(`promptFixture.settings.promptEnhance.rewriteEnabled=${mode === "rewrite"};promptFixture.settings.promptEnhance.grillEnabled=${mode === "grill"};promptFixture.install();document.querySelector('[data-prompt-enhance-trigger]').click()`);
    await eventually(() => evaluate("promptFixture.state.phase==='result'"), "单模式直达");
    assert.equal(await evaluate("promptFixture.state.mode"), mode);
    assert.equal(await evaluate("document.querySelectorAll('[data-prompt-enhance-menu]').length"), 0, "single enabled mode has no selection menu");
    await click("×");
  }
  await call("Page.navigate", { url: `http://127.0.0.1:${port}/manager` });
  await eventually(() => evaluate("document.body?.textContent.includes('新建收藏')"), "React 管理器");
  await click("新建收藏");
  await eventually(() => evaluate("!!document.querySelector('form input[maxlength]')"), "收藏编辑");
  await setValue('form input[maxlength="200"]', "常用提示词");
  await setValue('form textarea', "请检查边界条件"); await click("保存收藏");
  await eventually(() => evaluate("document.querySelector('.prompt-tools-record summary')?.textContent.includes('常用提示词')"), "管理器保存");
  await writeFile(path.join(output, "manager-400.png"), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
  assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, JSON.stringify(await evaluate("[...document.querySelectorAll(\"*\")].filter(x=>x.getBoundingClientRect().right>innerWidth).slice(0,8).map(x=>({tag:x.tagName,cls:x.className,right:x.getBoundingClientRect().right}))")));
  await call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
  await writeFile(path.join(output, "manager-1000.png"), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
  console.log(JSON.stringify({ status: "ok", output, checks: ["quick-library", "live-search", "folded-filters", "draft-append", "explicit-feedback", "independent-switches", "single-mode-direct", "manager-create", "400px-layout"] }));
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await call("Browser.close"); } catch {} socket.close(); }
  child.kill(); server.close();
}
