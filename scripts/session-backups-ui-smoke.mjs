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
const output = await mkdtemp(path.join(tmpdir(), "codex3n-backups-ui-"));
const api = path.join(output, "api.js");
const dialog = path.join(output, "dialog.js");
await writeFile(api, "export const invoke=(command,args)=>window.fixture.invoke(command,args);");
await writeFile(dialog, `import {appConfirm} from ${JSON.stringify(path.join(manager, "src/app-dialog.tsx"))};export const confirm=(message,options)=>appConfirm(message,{title:options.title,confirmText:options.okLabel,cancelText:options.cancelLabel,danger:true});`);
const entry = path.join(output, "entry.tsx");
await writeFile(entry, `import {createRoot} from ${JSON.stringify(path.join(manager, "node_modules/react-dom/client.js"))};
import {SessionBackups} from ${JSON.stringify(path.join(manager, "src/SessionBackups.tsx"))};
import {ClaudeSessionsScreen} from ${JSON.stringify(path.join(manager, "src/screens/ClaudeSessionsScreen.tsx"))};
import {AppDialogHost} from ${JSON.stringify(path.join(manager, "src/app-dialog.tsx"))};
createRoot(document.getElementById("app")).render(<><AppDialogHost/>{location.search.includes("claude")?<ClaudeSessionsScreen/>:<div className="mg-page mg-session-page"><SessionBackups/></div>}</>);`);
const bundle = await build({ entryPoints: [entry], outdir: output, bundle: true, write: false, format: "esm", jsx: "automatic", platform: "browser",
  nodePaths: [path.join(manager, "node_modules")], alias: { "@": path.join(manager, "src"), "@tauri-apps/api/core": api, "@tauri-apps/plugin-dialog": dialog },
});
const css = (await Promise.all((await readdir(path.join(manager, "dist/assets"))).filter(name => name.endsWith(".css")).map(name => readFile(path.join(manager, "dist/assets", name), "utf8")))).join("\n")
  + (bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text || "");
const fixture = `window.fixture={calls:[],fail:false,backups:[{token:"123-fixture",sessionId:"fixture-session",title:"用于验证长标题换行的会话备份及完整的项目说明",cwd:"D:/isolated-fixture/project",createdAtMs:Date.now(),complete:true,restored:false,fileCount:3}]};
fixture.invoke=async(command,args={})=>{
fixture.calls.push({command,args});
if(command==="list_claude_sessions")return{status:"ok",sessions:[],offset:0,limit:50,totalCount:0,hasMore:false,warnings:[]};
if(command.startsWith("list_"))return{status:"ok",backups:fixture.backups,warnings:[]};
if(fixture.fail)return{status:"failed",message:"测试清理失败，备份保留"};
if(command.startsWith("delete_"))fixture.backups=fixture.backups.filter(x=>x.token!==args.token);
return{status:"ok",removed:0};};`;
const server = createServer((request, response) => {
  if (request.url === "/bundle.js") { response.setHeader("content-type", "application/javascript"); response.end(bundle.outputFiles.find(file => file.path.endsWith(".js")).text); return; }
  if (request.url === "/style.css") { response.setHeader("content-type", "text/css"); response.end(css); return; }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>
*{animation:none!important;transition:none!important}body{margin:0}header.fixture-head{min-height:54px;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.fixture-head strong{font-size:16px}[data-topbar-actions]{display:flex;gap:8px;flex-wrap:wrap}#app{height:calc(100vh - 78px);min-width:0}.mg-page{height:100%}
</style><div class="shell" style="display:block;height:100vh"><header class="fixture-head"><strong>Codex3N · 删除备份</strong><div data-topbar-actions></div></header><main id="app"></main></div><script>${fixture}</script><script type="module" src="/bundle.js"></script>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = spawn(process.env.CODEX_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${path.join(output, "browser")}`, "about:blank"],
  { windowsHide: true, stdio: "ignore" });
const delay = () => new Promise(resolve => setTimeout(resolve, 100));
async function until(check, label) { for (let n = 0; n < 150; n++) { if (await check()) return; await delay(); } throw Error(`等待超时：${label}`); }
let socket, serial = 0;
const pending = new Map();
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} 超时`)); }, 15000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
const click = text => evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)})?.click()`);
try {
  let port;
  await until(async () => { try { port = Number((await readFile(path.join(output, "browser/DevToolsActivePort"), "utf8")).split("\n")[0]); return port; } catch { return false; } }, "浏览器");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === "page").webSocketDebuggerUrl);
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data), item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result);
  });
  await new Promise(resolve => socket.addEventListener("open", resolve, { once: true }));
  for (const agent of ["codex", "claude"]) {
    for (const width of [1280, 400]) {
      await call("Emulation.setDeviceMetricsOverride", { width, height: 850, deviceScaleFactor: 1, mobile: false });
      await call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/?${agent}` });
      await until(() => evaluate("!!document.querySelector('.mg-page')"), "会话页");
      if (agent === "claude") await click("删除备份");
      await until(() => evaluate("!!document.querySelector('.claude-backup-row')"), "备份列表");
      assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true, `${agent} ${width} 溢出`);
      await writeFile(path.join(output, `${agent}-${width}.png`), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
      await evaluate("document.querySelector('button[aria-label=\"删除备份\"]').click()");
      await until(() => evaluate("!!document.querySelector('[role=dialog]')"), "删除确认");
      await click("取消");
      assert.equal(await evaluate("fixture.calls.some(x=>x.command.startsWith('delete_'))"), false);
      await click("清理过期备份");
      await until(() => evaluate("!!document.querySelector('[role=dialog]')"), "清理确认");
      assert.equal(await evaluate("document.querySelector('[role=dialog]').textContent.includes('最新 20 份')"), true);
      await writeFile(path.join(output, `${agent}-${width}-confirm.png`), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
      await evaluate("fixture.fail=true");
      await evaluate("document.querySelector('[role=dialog] .app-dialog-actions button:last-child').click()");
      await until(() => evaluate("document.body.textContent.includes('测试清理失败')"), "失败提示");
      assert.equal(await evaluate("fixture.backups.length"), 1);
    }
  }
  console.log(`备份界面与取消、失败状态通过；截图：${output}`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await call("Browser.close"); } catch {} }
  socket?.close();
  if (browser.exitCode === null) {
    await Promise.race([new Promise(resolve => browser.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (browser.exitCode === null) browser.kill();
  }
  await new Promise(resolve => server.close(resolve));
}
