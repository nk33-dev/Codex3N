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
const output = await mkdtemp(path.join(tmpdir(), "codex3n-compaction-ui-"));
const entry = path.join(output, "entry.tsx");
await writeFile(entry, `
import {createRoot} from ${JSON.stringify(path.join(manager, "node_modules/react-dom/client.js"))};
import {ProviderWindowsDialog} from ${JSON.stringify(path.join(manager, "src/ProviderWindowsDialog.tsx"))};
window.fixture={saved:[],errors:[]};
window.addEventListener("error",e=>fixture.errors.push(e.message));
createRoot(document.getElementById("app")).render(<ProviderWindowsDialog busy={false}
entry={{id:"fixture",name:"系统默认",baseUrl:"http://127.0.0.1",models:["gpt-6.1-sol","claude-opus-5-5","provider/model-with-a-long-name-for-layout"],modelWindows:{"gpt-6.1-sol":1000000},
compaction:{percent:"80%",modelOverridesEnabled:false,modelPercents:{"gpt-6.1-sol":"75%"}}}}
onCancel={()=>{}} onSave={(windows,fallback,compaction)=>fixture.saved.push({windows,fallback,compaction})}/>);`);
const bundle = await build({ entryPoints: [entry], outdir: output, bundle: true, write: false, format: "esm", jsx: "automatic", platform: "browser",
  nodePaths: [path.join(manager, "node_modules")], alias: { "@": path.join(manager, "src") } });
const css = (await Promise.all((await readdir(path.join(manager, "dist/assets"))).filter(name => name.endsWith(".css")).map(name => readFile(path.join(manager, "dist/assets", name), "utf8")))).join("\n")
  + (bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text || "");
const server = createServer((request, response) => {
  if (request.url === "/bundle.js") { response.setHeader("content-type", "application/javascript"); response.end(bundle.outputFiles.find(file => file.path.endsWith(".js")).text); return; }
  if (request.url === "/style.css") { response.setHeader("content-type", "text/css"); response.end(css); return; }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>body{margin:0}*{animation:none!important;transition:none!important}</style><div id="app"></div><script type="module" src="/bundle.js"></script></html>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = spawn(process.env.CODEX_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${path.join(output, "browser")}`, "about:blank"],
  { windowsHide: true, stdio: "ignore" });
const delay = () => new Promise(resolve => setTimeout(resolve, 100));
async function until(check, label) { for (let n = 0; n < 100; n++) { if (await check()) return; await delay(); } throw Error(`等待超时：${label}`); }
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
const input = (selector, value) => evaluate(`{
  const input=document.querySelector(${JSON.stringify(selector)});
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,${JSON.stringify(value)});
  input.dispatchEvent(new Event("input",{bubbles:true}));}`);
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
  await call("Page.navigate", { url: `http://127.0.0.1:${server.address().port}` });
  await until(() => evaluate("!!document.querySelector('.pf-modal')"), "上下文弹窗");
  assert.equal(await evaluate("document.querySelectorAll('input[aria-label$=\"的自动压缩比例\"]').length"), 0);
  await evaluate("document.querySelector('input[type=checkbox]').click()");
  await until(() => evaluate("!!document.querySelector('input[aria-label=\"gpt-6.1-sol 的自动压缩比例\"]')"), "模型覆盖");
  assert.equal(await evaluate("document.querySelector('input[aria-label=\"gpt-6.1-sol 的自动压缩比例\"]').value"), "75%");
  assert.equal(await evaluate("document.querySelector('input[aria-label=\"claude-opus-5-5 的自动压缩比例\"]').placeholder"), "80%");
  await input('input[aria-label="gpt-6.1-sol 的自动压缩比例"]', "75.123456");
  await evaluate("document.querySelector('input[type=checkbox]').click()");
  await evaluate("document.querySelector('input[type=checkbox]').click()");
  await until(() => evaluate("document.querySelector('input[aria-label=\"gpt-6.1-sol 的自动压缩比例\"]').value==='75.123456'"), "覆盖值保留");
  await input(".pf-compact-default input", "101%");
  await until(() => evaluate("document.querySelector('button[type=submit]').disabled"), "非法比例");
  await input(".pf-compact-default input", "85%");
  await until(() => evaluate("!document.querySelector('button[type=submit]').disabled"), "合法比例");
  await evaluate("document.querySelector('button[type=submit]').click()");
  await until(() => evaluate("fixture.saved.length===1"), "保存");
  const saved = await evaluate("fixture.saved[0]");
  assert.equal(saved.compaction.percent, "85%");
  assert.equal(saved.compaction.modelPercents["gpt-6.1-sol"], "75.123456%");
  assert.equal(saved.compaction.modelOverridesEnabled, true);
  for (const [width, light] of [[1280, false], [400, true], [400, false]]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 850, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.classList.toggle("light",${light})`);
    assert.equal(await evaluate("document.documentElement.scrollWidth<=innerWidth"), true);
    assert.equal(await evaluate("[...document.querySelectorAll('.pf-modal input')].every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})"), true);
    const screenshot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(output, `compaction-${width}-${light ? "light" : "dark"}.png`), Buffer.from(screenshot.data, "base64"));
  }
  assert.deepEqual(await evaluate("fixture.errors"), []);
  console.log(JSON.stringify({ status: "ok", output, viewports: [1280, 400], saved }));
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await call("Browser.close"); } catch {}
    socket.close();
  }
  for (const item of pending.values()) clearTimeout(item.timer);
  server.close();
  if (browser.exitCode === null) await new Promise(resolve => { browser.once("exit", resolve); setTimeout(resolve, 5000).unref(); });
}
