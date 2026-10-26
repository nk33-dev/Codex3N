import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = await mkdtemp(path.join(tmpdir(), "codex3n-recovery-ui-"));
const fragment = (name) => readFile(path.join(root, "assets/inject/renderer-inject", name), "utf8");
const source = await fragment("40-backend-settings.js");
const styleSource = await fragment("10-style.js");
const cssStart = styleSource.indexOf("style.textContent = `") + "style.textContent = `".length;
const css = styleSource.slice(cssStart, styleSource.indexOf("`;", cssStart))
  .replace(/\$\{([^}]+)\}/g, (_, name) => name === "codexPlusPageClass" ? "codex-plus-page" : "fixture-unused");
const rowStart = source.lastIndexOf('<div class="codex-plus-row">', source.indexOf('data-codex-backend-description role="status"'));
const row = source.slice(rowStart, source.indexOf('<div class="codex-plus-row">', rowStart + 1))
  .replace("${codexPlusDiscoveryIcons.refresh}", source.match(/refresh: '([^']+)'/)[1]);
assert.ok(row.includes("data-codex-backend-reconnect"));
const code = source.slice(source.indexOf("  window.__codexPlusBackendCleanup?.();"), source.indexOf("  function userScriptStatusLabel("));
const html = `<!doctype html><meta charset="utf-8"><style>${css}
body{margin:0;padding:24px;background:#181818;color:#e4e4e4;font:14px system-ui;letter-spacing:0}
main{max-width:900px;margin:0 auto;--codex-plus-text:#e4e4e4;--codex-plus-text-secondary:#a1a1aa;--codex-plus-border:#3a3a3a;--codex-plus-bg-secondary:#232323;--codex-plus-bg-hover:#303030;--codex-plus-focus:#3485ff;--codex-plus-warning:#e9b85d;--codex-plus-success:#46bd94;--codex-plus-danger:#f87171}
</style><main><h1 style="font-size:24px">Codex++</h1><div class="codex-plus-settings"><section class="codex-plus-settings-section"><h2 class="codex-plus-settings-section-title">常规</h2><div class="codex-plus-settings-card">${row}</div></section></div></main>
<script>
let codexPlusVersion="",codexPlusSidebarNavId="fixture-nav";
window.fixture={connected:false,calls:0,delay:500};
window.__CODEX_PLUS_RECOVERY__={baseUrl:"http://127.0.0.1:1",token:"fixture",instance:"fixture"};
function refreshCodexServiceTierControls(){} function syncOfficialUsagePolicy(){} function sendCodexPlusDiagnostic(){}
async function syncBackendSettingsFromHeartbeat(){return window.fixture.connected}
async function postJson(){return window.fixture.connected?{status:"ok"}:{status:"failed"}}
window.fetch=async(url)=>{if(url.endsWith("/status"))return{ok:true};window.fixture.calls++;await new Promise(resolve=>setTimeout(resolve,window.fixture.delay));window.fixture.connected=true;return{ok:true,json:async()=>({status:"ok"})}};
${code}
window.fixture.check=()=>checkBackendStatus(false);
window.fixture.render=()=>renderBackendStatus();
document.querySelector("[data-codex-backend-reconnect]").addEventListener("click",()=>window.__codexPlusReconnectBackend());
window.fixture.render();
</script>`;
const fixturePath = path.join(output, "connection.html");
await writeFile(fixturePath, html);
const browser = process.env.CODEX_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const child = spawn(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${path.join(output, "browser")}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
let socket;
const pending = new Map();
let sequence = 0;
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = Number((await readFile(path.join(output, "browser/DevToolsActivePort"), "utf8")).split("\n")[0]);
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(port, "isolated browser did not start");
  const pages = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const item = pending.get(message.id);
    if (!item) return;
    clearTimeout(item.timer); pending.delete(message.id);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  };
  await call("Page.enable");
  await call("Page.bringToFront");
  await call("Page.navigate", { url: `file:///${fixturePath.replaceAll("\\", "/")}` });
  for (let i = 0; i < 50; i++) {
    if (await evaluate("!!window.fixture")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const width of [1146, 400]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.fixture.connected=false;window.fixture.calls=0;window.fixture.delay=500;codexPlusRecoveryRetryAt=0;codexPlusRecoveryFailures=0;codexPlusBackendFailureCount=3;window.fixture.check()");
    await evaluate('document.querySelector("[data-codex-backend-reconnect]").focus()');
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate('document.querySelector("[data-codex-backend-reconnect]").disabled'), true);
    assert.equal(await evaluate('document.querySelector("[data-codex-backend-status]").textContent'), "正在重连");
    await evaluate('document.querySelector("[data-codex-backend-reconnect]").click()');
    await new Promise(resolve => setTimeout(resolve, 650));
    assert.equal(await evaluate("window.fixture.calls"), 1);
    assert.equal(await evaluate('document.querySelector("[data-codex-backend-status]").textContent'), "已连接");
    const geometry = await evaluate(`(()=>{const row=document.querySelector(".codex-plus-row"),button=document.querySelector("[data-codex-backend-reconnect]"),text=row.firstElementChild;const r=row.getBoundingClientRect(),b=button.getBoundingClientRect(),t=text.getBoundingClientRect();return{fits:row.scrollWidth<=row.clientWidth,inside:b.right<=innerWidth,overlap:t.right>b.left,keyboard:document.activeElement===button}})()`);
    assert.deepEqual(geometry, { fits: true, inside: true, overlap: false, keyboard: true });
    const screenshot = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(output, `connected-${width}.png`), Buffer.from(screenshot.data, "base64"));
    await evaluate("window.fixture.connected=false;codexPlusBackendFailureCount=3;window.fixture.check()");
    const failed = await call("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(output, `failed-${width}.png`), Buffer.from(failed.data, "base64"));
  }
  console.log(JSON.stringify({ status: "ok", output, viewports: [1146, 400], keyboard: true, singleFlight: true }));
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    try { await call("Browser.close"); } catch {}
    socket.close();
  }
  pending.forEach(item => clearTimeout(item.timer));
  if (child.exitCode === null) {
    await new Promise(resolve => { child.once("exit", resolve); setTimeout(resolve, 5000).unref(); });
  }
}
