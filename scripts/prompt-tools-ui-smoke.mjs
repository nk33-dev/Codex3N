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
const fixtureState = `window.fixture={favorites:[],requests:[]};
window.fixtureRequest=async(action,payload={})=>{
  const state=window.fixture;state.requests.push({action,payload});
  if(action==='library/list'){
    let items=state.favorites.slice();
    if(payload.tag)items=items.filter(x=>x.tags.includes(payload.tag));
    const query=String(payload.query||'').toLowerCase();
    if(query)items=items.filter(x=>[x.title,x.body,...x.tags].join(' ').toLowerCase().includes(query));
    const tags=[...new Set(items.flatMap(x=>x.tags))].sort();
    return{status:'ok',favorites:items,tags,total:items.length};
  }
  if(action==='library/add'){const body=payload.body;const item={id:'fav-'+state.favorites.length,title:body.split('\\n')[0].slice(0,80),body,tags:[],project:payload.project||null,pinned:false,order:-state.favorites.length-1};state.favorites.unshift(item);return{status:'ok',favorite:item};}
  if(action==='library/save'){const item={...payload,id:payload.id||'fav-'+state.favorites.length};state.favorites=state.favorites.filter(x=>x.id!==item.id).concat([item]);return{status:'ok',favorite:item};}
  if(action==='library/delete'){const index=state.favorites.findIndex(x=>x.id===payload.id);const favorite=state.favorites[index];state.favorites=state.favorites.filter(x=>x.id!==payload.id);return{status:'ok',favorite,index};}
  if(action==='library/restore'){const index=payload.index||0;state.favorites.splice(index,0,payload.favorite);return{status:'ok'};}
  if(action==='library/reorder')return{status:'ok'};
  if(action==='library/use')return{status:'ok'};
  if(action==='generate'){
    if(payload.mode==='grill'&&!payload.forceFinal){
      if((payload.history||[]).length>=4)return{status:'ok',kind:'summary',text:'图书管理系统\\n后端：Java\\n主要功能：图书、借阅、搜索\\n待定：前端框架'};
      return{status:'ok',kind:'questions',questions:[{id:'stack',title:'技术方向',question:'后端打算用什么语言？',options:[{label:'Java',description:'适合 Spring Boot 项目'},{label:'Python',description:'适合 Django 或 FastAPI 项目'}],recommended:0},{id:'features',title:'功能范围',question:'第一版需要哪些功能？',options:[{label:'图书和借阅',description:'先做基本流程'},{label:'加上用户管理',description:'区分管理员和读者'}],recommended:0}]};
    }
    return{status:'ok',kind:'final',text:'请修复登录错误，并补充回归验证。',metadata:{mode:payload.mode||'rewrite',scenario:payload.scenario||'general',model:'fixture',systemPrompt:'规则'}};
  }
  return{status:'ok'};
};`;
const mockApi = path.join(output, "api.js");
await writeFile(mockApi, "export async function invoke(command,args){return window.fixtureRequest(args.action,args.payload)}");
const entry = path.join(output, "manager-entry.tsx");
await writeFile(entry, `import {createRoot} from ${JSON.stringify(path.join(manager, "node_modules/react-dom/client.js"))};
import {PromptToolsPanel} from ${JSON.stringify(path.join(manager, "src/prompt-tools.tsx"))};
createRoot(document.getElementById('app')).render(<PromptToolsPanel/>);`);
const bundled = await build({ entryPoints: [entry], outdir: output, bundle: true, write: false, format: "iife", jsx: "automatic", platform: "browser",
  nodePaths: [path.join(manager, "node_modules")], alias: { "@": path.join(manager, "src"), "@tauri-apps/api/core": mockApi },
});
const fragment = async (name) => readFile(path.join(root, "assets/inject/renderer-inject", name), "utf8");
const injected = `(()=>{
const codexPlusBackendSettingsLoaded=true,codexPlusBackendSettings={enhancementsEnabled:true,promptEnhance:{enabled:true,rewriteEnabled:true,grillEnabled:true,favoritesEnabled:true}};
function registerCodexPlusExtensionSelector(){} function visibleElement(){return true} function isExtensionUiNode(){return false}
function codexPlusWindowZoom(){return Number(getComputedStyle(document.documentElement).zoom)||1}
function codexPlusDictationScope(x){return x?.closest?.('.composer-footer')||x} function codexPlusDictationEditor(x){return x?.querySelector?.('textarea')||document.querySelector('textarea')}
function codexPlusDictationFooterScore(){return 1} function codexPlusDictationView(){return null}
async function loadOptionalCodexAppModule(){return{}} function showToast(text,options){window.lastToast=text;window.lastToastAction=options?.action||null}
async function postJson(url,data){return window.fixtureRequest(url.replace('/prompt-enhance/',''),data)}
${await fragment("93-prompt-enhance-context.js")}
${await fragment("93-prompt-enhance.js")}
${await fragment("93-prompt-library.js")}
document.querySelector('textarea').__reactFiber$fixture={memoizedProps:{kind:'local',hostId:'local',cwd:'D:/fixture'}};
window.promptFixture={install:installCodexPlusPromptEnhance,state:codexPlusPromptEnhance,library:codexPlusPromptLibrary,settings:codexPlusBackendSettings};
installCodexPlusPromptEnhance();})();`;
const cssFile = (await readdir(path.join(manager, "dist/assets"))).find((name) => name.endsWith(".css"));
const css = await readFile(path.join(manager, "dist/assets", cssFile), "utf8") + "\n" + (bundled.outputFiles.find(file => file.path.endsWith(".css"))?.text || "");
let promptkitBundle;
if (process.env.DSH_PROMPTKIT_ROOT) {
  const kit = path.resolve(process.env.DSH_PROMPTKIT_ROOT), client = path.join(kit, "packages/promptkit/src/client");
  const kitEntry = path.join(output, "promptkit-entry.tsx");
  await writeFile(kitEntry, `import React from ${JSON.stringify(path.join(kit, "node_modules/react/index.js"))};
import {createRoot} from ${JSON.stringify(path.join(kit, "node_modules/react-dom/client.js"))};
import {App} from ${JSON.stringify(path.join(client, "App.tsx"))};
import {css} from ${JSON.stringify(path.join(client, "style.ts"))};
import {zh} from ${JSON.stringify(path.join(client, "locales.ts"))};
import {defaultSettings,DEFAULT_PRESETS} from ${JSON.stringify(path.join(kit, "packages/promptkit/src/shared/defaults.ts"))};
const style=document.createElement('style');style.textContent=css;document.head.append(style);
window.pk={calls:[],input:{draft:'做一个图书管理系统',draftRev:1,attachmentIds:[],occurrences:[],phase:'plain',queue:[]}};
const config={settings:{...defaultSettings(),favoritesEnabled:true},presets:DEFAULT_PRESETS,revision:0};
const api={onConfigurationChange:()=>()=>{},call:async(action,payload)=>{
  pk.calls.push({action,payload});
  if(action==='config.read')return config;
  if(action==='project.read')return null;
  if(action==='project.check')return true;
  if(action==='generate')return{...await fixtureRequest('generate',payload),context:{enabled:false,sections:[]},metadata:{}};
  if(action==='favorites.list')return{items:fixture.favorites.map(item=>({...item,excerpt:item.body})),revision:0,total:fixture.favorites.length,project:null,tags:[]};
  if(action==='favorites.get')return fixture.favorites.find(item=>item.id===payload.id);
  return true;
}};
createRoot(document.getElementById('app')).render(<App api={api} t={key=>zh[key]} sessionId="fixture" input={pk.input}
inputActions={{captureInsertion:()=>({draftRev:1}),insertText:()=>true,persistDraft:()=>{}}}/>);`);
  promptkitBundle = (await build({ entryPoints: [kitEntry], bundle: true, write: false, format: "iife", jsx: "automatic",
    platform: "browser", nodePaths: [path.join(kit, "node_modules"), path.join(kit, "packages/promptkit/node_modules")] })).outputFiles[0].text;
}
const server = createServer((request, response) => {
  if (request.url === "/promptkit.js") { response.setHeader("content-type", "application/javascript"); response.end(promptkitBundle); return; }
  if (request.url === "/manager.js") { response.setHeader("content-type", "application/javascript"); response.end(bundled.outputFiles.find(file => file.path.endsWith(".js")).text); return; }
  if (request.url === "/injected.js") { response.setHeader("content-type", "application/javascript"); response.end(injected); return; }
  if (request.url === "/style.css") { response.setHeader("content-type", "text/css"); response.end(css); return; }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><meta charset="utf-8">${request.url === "/promptkit" ? "" : '<link rel="stylesheet" href="/style.css">'}<style>body{margin:0;padding:16px;box-sizing:border-box;width:100%;min-width:0;background:#202124;color:#eee;font:13px/1.6 system-ui}button{cursor:pointer}.composer-footer{margin-top:420px}textarea{width:90%;height:80px}</style>
    <script>${fixtureState}</script>${request.url === "/promptkit" ? '<div id="app" style="position:absolute;bottom:24px;left:24px"></div><script src="/promptkit.js"></script>' : request.url === "/manager" ? '<div id="app"></div><script src="/manager.js"></script>' : '<div class="composer-footer" style="display:grid;grid-template-columns:auto 1fr"><textarea style="grid-column:1/-1">修复登录错误</textarea><div class="flex" style="display:flex"><button data-composer-navigation-target="permissions">权限</button></div></div><script src="/injected.js"></script>'}`);
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
async function click(text, within = "document") { await evaluate(`[...${within}.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)})?.click()`); }
async function setValue(selector, value) {
  await evaluate(`(()=>{const x=document.querySelector(${JSON.stringify(selector)});const setter=Object.getOwnPropertyDescriptor(x.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;setter.call(x,${JSON.stringify(value)});x.dispatchEvent(new Event('input',{bubbles:true}));})()`);
}
const shot = async (name) => writeFile(path.join(output, name), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
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

  // 收藏：存当前输入、搜索、点一条追加、删除。
  await evaluate("document.querySelector('[data-prompt-library-trigger]').click()");
  await eventually(() => evaluate("!!document.querySelector('#codex-plus-prompt-library input[type=search]')"), "收藏列表");
  await eventually(() => evaluate("document.querySelector('#codex-plus-prompt-library').textContent.includes('还没有常用提示词')"), "空收藏提示");
  await click("存当前输入");
  await eventually(() => evaluate("document.querySelector('#codex-plus-prompt-library .codex-plus-prompt-edit textarea')?.value.includes('修复登录错误')"), "保存后打开编辑");
  await click("保存", "document.querySelector('#codex-plus-prompt-library')");
  await eventually(() => evaluate("document.querySelector('#codex-plus-prompt-library .codex-plus-prompt-row')?.textContent.includes('修复登录错误')"), "保存收藏");
  await setValue('#codex-plus-prompt-library input[type="search"]', "无匹配项");
  await eventually(() => evaluate("document.querySelector('#codex-plus-prompt-library')?.textContent.includes('没有找到提示词')"), "即时搜索");
  await setValue('#codex-plus-prompt-library input[type="search"]', "登录");
  await eventually(() => evaluate("!!document.querySelector('#codex-plus-prompt-library .codex-plus-prompt-row')"), "搜索恢复");
  await evaluate("document.querySelector('#codex-plus-prompt-library .codex-plus-prompt-row-main').click()");
  await eventually(() => evaluate("document.querySelector('textarea').value.includes('\\n\\n修复登录错误')"), "收藏追加");
  assert.equal(await evaluate("!document.querySelector('#codex-plus-prompt-library')"), true, "row click closes the card");
  await evaluate("document.querySelector('[data-prompt-library-trigger]').click()");
  await eventually(() => evaluate("!!document.querySelector('#codex-plus-prompt-library [aria-label=删除]')"), "重新打开收藏");
  await evaluate("document.querySelector('#codex-plus-prompt-library [aria-label=删除]').click()");
  await eventually(() => evaluate("window.lastToast?.startsWith('已删除')"), "删除提示");
  assert.equal(await evaluate("fixture.favorites.length"), 0);
  await evaluate("window.lastToastAction?.run()");
  await eventually(() => evaluate("fixture.favorites.length===1"), "撤销删除");
  await evaluate("document.querySelector('#codex-plus-prompt-library [aria-label=关闭]').click()");
  await eventually(() => evaluate("!document.querySelector('#codex-plus-prompt-library')"), "关闭收藏");

  // 增强菜单与结果写回。
  await evaluate("document.querySelector('[data-prompt-enhance-trigger]').click()");
  await eventually(() => evaluate("!!document.querySelector('[data-prompt-enhance-menu]')"), "模式菜单");
  assert.equal(await evaluate("[...document.querySelectorAll('[data-prompt-enhance-menu] button')].map(b=>b.textContent.trim()).join('|')"), "增强提示词|需求对齐");
  await click("增强提示词", "document.querySelector('[data-prompt-enhance-menu]')");
  await eventually(() => evaluate("promptFixture.state.phase==='result'"), "改写结果");
  assert.equal(await evaluate("document.querySelector('#codex-plus-prompt-enhance-panel textarea').value.includes('修复登录错误')"), true);
  await shot("enhance-result-400.png");
  await click("替换", "document.querySelector('#codex-plus-prompt-enhance-panel')");
  await eventually(() => evaluate("document.querySelector('textarea').value==='请修复登录错误，并补充回归验证。'"), "替换写回");
  assert.equal(await evaluate("window.lastToast"), "已替换输入框内容");
  await evaluate("window.lastToastAction.run()");
  await eventually(() => evaluate("document.querySelector('textarea').value.startsWith('修复登录错误')"), "撤销替换");

  // 单模式直达与开关独立。
  await evaluate("promptFixture.settings.promptEnhance.rewriteEnabled=false;promptFixture.settings.promptEnhance.grillEnabled=false;promptFixture.settings.promptEnhance.favoritesEnabled=false;promptFixture.install()");
  assert.equal(await evaluate("!!document.querySelector('[data-prompt-library-trigger]')||!!document.querySelector('[data-prompt-enhance-trigger]')"), false, "all disabled hides both entries");
  await evaluate("promptFixture.settings.promptEnhance.rewriteEnabled=true;promptFixture.settings.promptEnhance.favoritesEnabled=false;promptFixture.install();document.querySelector('[data-prompt-enhance-trigger]').click()");
  await eventually(() => evaluate("promptFixture.state.phase==='result'"), "单模式直达");
  assert.equal(await evaluate("document.querySelectorAll('[data-prompt-enhance-menu]').length"), 0);
  assert.equal(await evaluate("document.querySelector('[data-prompt-enhance-trigger]').title"), "增强提示词");
  await evaluate("document.querySelector('#codex-plus-prompt-enhance-panel [aria-label=关闭]').click()");

  // 需求对齐：点选自动下一题、答完自动提交、四轮后小结。
  await evaluate("promptFixture.settings.promptEnhance.rewriteEnabled=true;promptFixture.settings.promptEnhance.grillEnabled=true;promptFixture.install();document.querySelector('[data-prompt-enhance-trigger]').click()");
  await eventually(() => evaluate("!!document.querySelector('[data-prompt-enhance-menu]')"), "双模式菜单");
  await click("需求对齐", "document.querySelector('[data-prompt-enhance-menu]')");
  await eventually(() => evaluate("promptFixture.state.phase==='questions'"), "问答");
  await shot("questions-dark-400.png");
  await call("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
  await shot("questions-dark-1200.png");
  await call("Emulation.setDeviceMetricsOverride", { width: 400, height: 800, deviceScaleFactor: 1, mobile: false });
  for (let round = 0; round < 4; round++) {
    await eventually(() => evaluate("promptFixture.state.phase==='questions'&&promptFixture.state.activeQuestion===0"), `第 ${round + 1} 轮题目`);
    await evaluate("document.querySelector('#codex-plus-prompt-enhance-panel .codex-plus-prompt-option').click()");
    await eventually(() => evaluate("promptFixture.state.activeQuestion===1"), "自动下一题");
    await evaluate("document.querySelector('#codex-plus-prompt-enhance-panel .codex-plus-prompt-option').click()");
    await eventually(() => evaluate(`promptFixture.state.history.length===${round + 1}&&promptFixture.state.phase!=='loading'`), "自动提交");
  }
  await eventually(() => evaluate("promptFixture.state.phase==='summary'"), "需求小结");
  await shot("summary-400.png");
  await click("写提示词", "document.querySelector('#codex-plus-prompt-enhance-panel')");
  await eventually(() => evaluate("promptFixture.state.phase==='result'"), "确认生成");
  assert.equal(await evaluate("document.querySelector('#codex-plus-prompt-enhance-panel').getBoundingClientRect().right<=innerWidth&&document.querySelector('#codex-plus-prompt-enhance-panel').getBoundingClientRect().left>=0"), true, "card stays inside the window");
  await evaluate("document.querySelector('#codex-plus-prompt-enhance-panel [aria-label=关闭]').click()");

  // 管理器：直接新建、保存、删除可从提示条撤销。
  await call("Page.navigate", { url: `http://127.0.0.1:${port}/manager` });
  await eventually(() => evaluate("!!document.querySelector('button[aria-label=新建]')"), "React 管理器");
  await evaluate("document.querySelector('button[aria-label=新建]').click()");
  await eventually(() => evaluate("!!document.querySelector('form input[maxlength]')"), "收藏编辑");
  await setValue('form input[maxlength="200"]', "常用提示词");
  await setValue('form textarea', "请检查边界条件"); await click("保存");
  await eventually(() => evaluate("document.querySelector('.prompt-manager-item')?.textContent.includes('常用提示词')"), "管理器保存");
  await shot("manager-400.png");
  assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, JSON.stringify(await evaluate("[...document.querySelectorAll(\"*\")].filter(x=>x.getBoundingClientRect().right>innerWidth).slice(0,8).map(x=>({tag:x.tagName,cls:x.className,right:x.getBoundingClientRect().right}))")));
  await call("Emulation.setDeviceMetricsOverride", { width: 1000, height: 760, deviceScaleFactor: 1, mobile: false });
  await shot("manager-1000.png");

  // Harness 插件：同一套交互。
  if (promptkitBundle) {
    await call("Page.navigate", { url: `http://127.0.0.1:${port}/promptkit` });
    await eventually(() => evaluate("!!document.querySelector('.pk-tools .pk-tool')"), "Harness 插件");
    await evaluate(`document.documentElement.style.cssText='--dsw-alias-bg-base:#292929;--dsw-alias-label-primary:#eee;--dsw-alias-label-secondary:#aaa;--dsw-alias-border-l2:#444;--dsw-alias-state-business-primary:#8fb6ff;--dsw-alias-interactive-bg-hover:#383838;--dsw-alias-button-info-fill:#eee;--dsw-alias-label-primary-bluish:#222'`);
    await evaluate("document.querySelector('button[aria-label=增强提示词]').click()");
    await eventually(() => evaluate("!!document.querySelector('.pk-mode-menu')"), "Harness 模式菜单");
    await evaluate("[...document.querySelectorAll('.pk-mode-menu button')].find(b=>b.textContent.includes('需求对齐')).click()");
    await eventually(() => evaluate("!!document.querySelector('.pk-question')"), "Harness 问答");
    await shot("harness-questions-dark-1000.png");
    await call("Emulation.setDeviceMetricsOverride", { width: 400, height: 800, deviceScaleFactor: 1, mobile: false });
    await shot("harness-questions-dark-400.png");
    await evaluate("document.querySelector('.pk-option').click()");
    await eventually(() => evaluate("document.querySelector('.pk-question')?.textContent==='第一版需要哪些功能？'"), "Harness 自动下一题");
    await evaluate("document.querySelector('.pk-option').click()");
    await eventually(() => evaluate("pk.calls.filter(x=>x.action==='generate').length===2"), "Harness 下一轮");
    await evaluate("document.querySelector('button[aria-label=关闭]').click()");
    await evaluate("document.querySelector('button[aria-label=增强提示词]').click()");
    await eventually(() => evaluate("!!document.querySelector('.pk-mode-menu')"), "Harness 模式菜单");
    await evaluate("[...document.querySelectorAll('.pk-mode-menu button')].find(b=>b.textContent.includes('需求对齐')).click()");
    await eventually(() => evaluate("!!document.querySelector('.pk-question')"), "Harness 恢复");
    assert.equal(await evaluate("pk.calls.filter(x=>x.action==='generate').length"), 2, "reopen keeps the workflow");
  }
  console.log(JSON.stringify({ status: "ok", output, checks: ["native-row", "quick-library", "live-search", "draft-append", "delete-undo", "mode-menu", "replace-undo", "single-mode", "auto-advance", "four-rounds", "summary", "manager-create", "400px-layout"] }));
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await call("Browser.close"); } catch {} socket.close(); }
  child.kill(); server.close();
}
