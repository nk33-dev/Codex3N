import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const [rootArg, portArg] = process.argv.slice(2);
const root = await realpath(rootArg);
const temp = await realpath(tmpdir());
assert.ok(root.startsWith(temp + path.sep), "probe requires an isolated temporary directory");
const port = Number(portArg);
const settings = JSON.parse(await readFile(path.join(root, "state/settings.json"), "utf8"));
const status = JSON.parse(await readFile(path.join(root, "state/latest-status.json"), "utf8"));
assert.equal(status.debug_port, port);
assert.ok(settings.codexExtraArgs.includes(`--user-data-dir=${path.join(root, "electron")}`));
const targets = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
const pages = targets.filter(t => t.type === "page" && t.url.startsWith("app://-/"));
assert.equal(pages.length, 1);
const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
const pending = new Map();
let sequence = 0;
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const item = pending.get(message.id);
  if (!item) return;
  clearTimeout(item.timer); pending.delete(message.id);
  if (message.error) item.reject(new Error(JSON.stringify(message.error)));
  else item.resolve(message.result);
};
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const value = await call("Runtime.evaluate", { expression, returnByValue: true });
  assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails));
  return value.result.value;
};
const waitFor = async (predicate, timeout = 75000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("recovery did not become ready before the deadline");
};
let verified = false;
try {
  await waitFor(() => evaluate("window.__codexPlusBackendStatus?.status==='ok' && typeof window.__codexPlusReconnectBackend==='function' && typeof window.__codexPlusRecoveryBridge==='function'"), 45000);
  await new Promise(resolve => setTimeout(resolve, 10000));
  await waitFor(() => evaluate("window.__codexPlusBackendStatus?.status==='ok'"), 15000);
  verified = true;
  const config = await evaluate("window.__CODEX_PLUS_RECOVERY__");
  assert.match(config.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(config.token.length >= 64);
  assert.equal((await fetch(`${config.baseUrl}/reconnect`, { method: "POST", body: "{}" })).status, 403);
  assert.equal((await fetch(`${config.baseUrl}/reconnect`, {
    method: "POST", headers: { Authorization: `Bearer ${config.token}`, Origin: "https://example.com" }, body: "{}",
  })).status, 403);
  const baseline = await evaluate("({generation:window.__codexPlusBackendGeneration,timeOrigin:performance.timeOrigin})");
  await evaluate("window.__codexPlusRecoveryProbeSentinel='preserved';window.__codexSessionDeleteBridge=undefined;void window.__codexPlusReconnectBackend();true");
  const manualAt = Date.now();
  await waitFor(() => evaluate(`window.__codexPlusBackendGeneration>${baseline.generation} && window.__codexPlusBackendStatus?.status==='ok'`));
  const manualMs = Date.now() - manualAt;
  const manualGeneration = await evaluate("window.__codexPlusBackendGeneration");
  await evaluate("window.__codexSessionDeleteBridge=()=>new Promise(()=>{});true");
  const autoAt = Date.now();
  await waitFor(() => evaluate(`window.__codexPlusBackendGeneration>${manualGeneration} && window.__codexPlusBackendStatus?.status==='ok'`));
  const automaticMs = Date.now() - autoAt;
  assert.equal(await evaluate("window.__codexPlusRecoveryProbeSentinel"), "preserved");
  assert.equal(await evaluate("performance.timeOrigin"), baseline.timeOrigin);
  const after = await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json());
  assert.ok(after.some(t => t.id === pages[0].id), "native page was replaced");
  const result = {
    status: "ok", port, manualMs, automaticMs, samePage: true,
    reloaded: false, unauthorizedRejected: true, nativeOriginEnforced: true,
  };
  console.log(JSON.stringify(result));
} finally {
  if (verified && socket.readyState === WebSocket.OPEN) {
    try { await call("Browser.close"); } catch {}
  }
  socket.close();
  pending.forEach(item => clearTimeout(item.timer));
}
