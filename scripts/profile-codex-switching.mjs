import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "9229" },
    group: { type: "string" },
    category: { type: "string" },
    temperature: { type: "string" },
    "official-version": { type: "string" },
    output: { type: "string" },
    compare: { type: "string", multiple: true },
  },
});

function p95(samples) {
  const sorted = samples.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null;
}

if (values.compare) {
  const reports = await Promise.all(values.compare.map(async (file) => JSON.parse(await readFile(file, "utf8"))));
  const groups = new Map();
  for (const report of reports) {
    if (report.sample?.schema !== 1 || !["official", "baseline", "optimized"].includes(report.group)
        || !["short", "long", "tool-heavy"].includes(report.category) || !["cold", "warm"].includes(report.temperature)) {
      throw new Error("对照报告格式无效");
    }
    const key = JSON.stringify([report.group, report.category, report.temperature, report.sample.versions]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(report);
  }
  for (const batch of groups.values()) {
    const report = batch[0];
    const switches = batch.flatMap((item) => item.sample.switches);
    const samples = switches.filter((item) => item.status === "visible");
    const hasTiming = batch.every((item) => item.sample.capabilities.injectionTiming);
    console.log(JSON.stringify({
      group: report.group, category: report.category, temperature: report.temperature, versions: report.sample.versions,
      batches: batch.length,
      confirmedSwitches: samples.length,
      incompleteSwitches: switches.length - samples.length,
      contentVisibleP95Ms: p95(samples.map((item) => item.contentVisibleMs)),
      durationMs: batch.reduce((sum, item) => sum + item.sample.durationMs, 0),
      injectionMs: hasTiming ? batch.reduce((total, item) => total
        + ["scanLightweight", "scanDeferred", "layout", "floatingScan"].reduce((sum, name) => sum + (item.sample.spans[name]?.totalMs || 0), 0), 0) : null,
      longTasks: {
        count: batch.reduce((sum, item) => sum + item.sample.longTasks.count, 0),
        totalMs: batch.reduce((sum, item) => sum + item.sample.longTasks.totalMs, 0),
        maxMs: Math.max(...batch.map((item) => item.sample.longTasks.maxMs)),
      },
      missing: [...new Set(batch.flatMap((item) => item.sample.missing))],
      enoughSamples: samples.length >= 20,
    }));
  }
  if (new Set(reports.map((report) => report.sample.versions.official)).size !== 1) {
    console.error("官方版本不同，结果不能作为同版本对照。");
    process.exitCode = 1;
  }
} else {
  if (!["official", "baseline", "optimized"].includes(values.group)
      || !["short", "long", "tool-heavy"].includes(values.category)
      || !["cold", "warm"].includes(values.temperature)
      || !/^\d[\d.]*$/.test(values["official-version"] || "") || !values.output) {
    throw new Error("需要 --group official|baseline|optimized --category short|long|tool-heavy --temperature cold|warm --official-version <版本> --output <JSON 文件>");
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("调试端口无效");
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  const targets = await response.json();
  const candidates = targets.filter((target) => target.type === "page"
    && /^app:\/\/-\/index\.html(?:[?#]|$)/.test(target.url) && !/[?&]initialRoute=/.test(target.url));
  if (candidates.length !== 1) throw new Error("需要唯一的主应用页面；请确认对应实例的调试端口");
  const wsUrl = new URL(candidates[0].webSocketDebuggerUrl);
  if (wsUrl.protocol !== "ws:" || wsUrl.hostname !== "127.0.0.1" || Number(wsUrl.port) !== port) throw new Error("调试地址不属于指定环回端口");
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let serial = 0;
  const failPending = () => { for (const { reject } of pending.values()) reject(new Error("调试连接已关闭")); pending.clear(); };
  socket.addEventListener("close", failPending);
  socket.addEventListener("error", failPending);
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error("CDP 请求失败"));
    else request.resolve(message.result);
  });
  const openTimeout = setTimeout(() => socket.close(), 5000);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
      socket.addEventListener("close", () => reject(new Error("调试连接未建立")), { once: true });
    });
    clearTimeout(openTimeout);
    async function evaluate(expression) {
      const id = ++serial;
      const timeout = setTimeout(() => {
        const request = pending.get(id);
        pending.delete(id);
        request?.reject(new Error("诊断请求超时"));
      }, 5000);
      try {
        const result = await new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
        });
        if (result.exceptionDetails) throw new Error("页面诊断能力不可用");
        return result.result.value;
      } finally { clearTimeout(timeout); }
    }
    const fragment = await readFile(new URL("../assets/inject/renderer-inject/02-performance.js", import.meta.url), "utf8");
    const pkg = JSON.parse(await readFile(new URL("../apps/codex-plus-manager/package.json", import.meta.url), "utf8"));
    const official = values["official-version"];
    const installed = await evaluate("window.__CODEX_PLUS_VERSION__ || null");
    if (values.group === "official" && installed) throw new Error("official 对照页面仍有项目注入，请完全退出后直接启动官方应用");
    if (values.group !== "official" && !installed) throw new Error("项目对照页面未检测到注入");
    await evaluate(`(() => {
      ${fragment}
      if (!window.__codexPlusPerf) window.__codexPlusPerf = createCodexPlusPerformanceDiagnostics({
        officialVersion: () => ${JSON.stringify(official)}, repositoryVersion: ${JSON.stringify(pkg.version)}
      });
      window.__codexPlusPerf.start(60000);
      return true;
    })()`);
    console.log("采样已开始，60 秒内手动切换会话；程序不会点击、发送消息或读取正文。");
    await new Promise((resolve) => setTimeout(resolve, 60500));
    const sample = await evaluate("window.__codexPlusPerf.stop()");
    if (!sample) throw new Error("页面重载导致采样丢失，请重新采样");
    sample.versions.official = official;
    sample.versions.repository = pkg.version;
    await writeFile(values.output, `${JSON.stringify({ group: values.group, category: values.category, temperature: values.temperature, sample }, null, 2)}\n`, "utf8");
    console.log(`已保存 ${sample.switches.length} 次切换记录：${values.output}`);
  } finally {
    clearTimeout(openTimeout);
    failPending();
    socket.close();
  }
}
