import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

if (process.platform !== "win32") throw Error("此探针只验证 Windows WebView2");
const source = process.argv[2];
if (!source) throw Error("需要显式指定待验证的管理器 exe");
const output = await mkdtemp(path.join(tmpdir(), "codex3n-lightweight-live-"));
const state = path.join(output, "state"), home = path.join(output, "codex-home");
await mkdir(state); await mkdir(home);
const executable = path.join(output, "lightweight-probe.exe");
await copyFile(path.resolve(source), executable);
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const guard = await freePort(), helper = await freePort(), debug = await freePort();
const codex = await freePort();
await writeFile(path.join(state, ".state-imported"), "isolated probe");
await writeFile(path.join(state, "ui-preferences.imported"), "isolated probe");
await writeFile(path.join(state, "settings.json"), JSON.stringify({ schemaVersion: 1, relayProfilesEnabled: false }));
await writeFile(path.join(state, "latest-status.json"), JSON.stringify({
  status: "stopped", message: "isolated probe", started_at_ms: 0, debug_port: codex, helper_port: helper,
}));
await writeFile(path.join(state, "gateway.json"), JSON.stringify({
  version: 4, lightweightOnClose: true, restoreOnExit: false, trayPanel: false,
  bindings: { codex: { enabled: true, token: "cpx-gw-isolated-probe", restore: { appliedPort: helper } } },
}));
const env = { ...process.env, CODEX_PLUS_STATE_DIR: state, CODEX_HOME: home, CODEX_PLUS_MULTI_INSTANCE: "1",
  CODEX_PLUS_MANAGER_GUARD_PORT: String(guard), CODEX_PLUS_LAUNCHER_GUARD_PORT: String(await freePort()),
  CODEX_PLUS_PROTOCOL_PROXY_PORT: String(helper),
  CODEX_PLUS_MANAGER_TEST_DEBUG_PORT: String(debug),
};
let child, socket, serial = 0;
const pending = new Map();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(check, label, attempts = 150) {
  for (let n = 0; n < attempts; n++) {
    if (child?.exitCode !== null) throw Error(`管理器提前退出：${child?.exitCode}`);
    if (await check()) return;
    await delay(100);
  }
  throw Error(`等待超时：${label}`);
}
const launch = () => { child = spawn(executable, [], { env, windowsHide: true, stdio: "ignore" }); };
const pages = () => fetch(`http://127.0.0.1:${debug}/json/list`).then(r => r.json()).catch(() => []);
const mainPage = async () => (await pages()).find(page => page.type === "page" && !page.url.includes("#"));
const gateway = () => fetch(`http://127.0.0.1:${helper}/gw/codex/v1/models`, {
  headers: { Authorization: "Bearer cpx-gw-isolated-probe" },
}).then(r => r.status === 200).catch(() => false);
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} 超时`)); }, 10000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(expression) {
  const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function openMain() {
  await writeFile(path.join(state, `window-activation-${guard}.request`), String(Date.now()));
  await until(async () => Boolean(await mainPage()), "主窗口重建");
  socket = new WebSocket((await mainPage()).webSocketDebuggerUrl);
  socket.onmessage = event => {
    const message = JSON.parse(event.data), item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    message.error ? item.reject(Error(message.error.message)) : item.resolve(message.result);
  };
  await new Promise(resolve => { socket.onopen = resolve; });
  await until(() => evaluate("!!window.__TAURI_INTERNALS__?.invoke"), "IPC 就绪");
}
const invoke = (name, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`);
async function exit() {
  const stopped = new Promise(resolve => child.once("exit", resolve));
  await invoke("manager_exit_app").catch(() => {});
  await Promise.race([stopped, delay(15000)]);
  assert.notEqual(child.exitCode, null, "退出命令应停止测试进程");
  socket?.close();
}
try {
  console.log(JSON.stringify({ output, helperPort: helper, debugPort: debug, codexPort: codex }));
  launch();
  await until(gateway, "后台网关");
  await delay(1500);
  assert.equal(await mainPage(), undefined, "轻量启动不应创建主窗口");
  await openMain();
  assert.equal(await invoke("lightweight_mode_enabled"), true);
  await invoke("set_lightweight_mode_enabled", { enabled: false });
  await invoke("manager_hide_to_tray");
  await delay(3500);
  assert.ok(await mainPage(), "轻量关闭时隐藏窗口不应释放 WebView");
  await invoke("set_lightweight_mode_enabled", { enabled: true });
  await until(async () => !(await mainPage()), "开启后释放窗口");
  assert.equal(await gateway(), true, "释放界面后网关仍在线");
  await openMain();
  assert.equal(await invoke("lightweight_mode_enabled"), true);
  await exit();
  launch();
  await until(gateway, "重启后的后台网关");
  await delay(1500);
  assert.equal(await mainPage(), undefined);
  await openMain();
  await invoke("set_lightweight_mode_enabled", { enabled: false });
  await exit();
  launch();
  await until(async () => Boolean(await mainPage()), "关闭轻量模式后的正常启动");
  await openMain();
  assert.equal(await invoke("lightweight_mode_enabled"), false);
  const saved = JSON.parse(await readFile(path.join(state, "gateway.json"), "utf8"));
  assert.equal(saved.lightweightOnClose, false);
  await exit();
  console.log(JSON.stringify({ status: "ok", output, backgroundStartup: true, gatewayAfterRelease: true, windowRecreation: true, restartPersistence: true }));
} finally {
  socket?.close();
  for (const item of pending.values()) clearTimeout(item.timer);
  if (child?.exitCode === null) {
    child.kill();
    await new Promise(resolve => { child.once("exit", resolve); setTimeout(resolve, 5000).unref(); });
  }
}
