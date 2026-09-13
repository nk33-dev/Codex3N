import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const deleteLocalSessions = async");
const end = source.indexOf("  const refreshLiveContextEntries", start);
const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(results: Array<{status: string; message?: string} | null>, confirmed = true) {
  const notices: Array<{ message: string; status: string }> = [];
  let requests = 0, refreshes = 0;
  const run = new Function("run", "requestDeleteLocalSession", "confirmSessionDelete", "showNotice", "t", "tf", "isSuccessStatus", "truncateSessionDeletePreview", "refreshLocalSessions", "localSessions", js + "; return deleteLocalSessions;")(
    (task: () => unknown) => task(), async () => results[requests++], async () => confirmed,
    (_title: string, message: string, status: string) => notices.push({ message, status }),
    (text: string) => text, (text: string, args: unknown[]) => text.replace(/\{(\d+)\}/g, (_match, index) => String(args[index])),
    (status: string) => status === "ok" || status === "accepted", (text: string) => text,
    async () => { refreshes++; }, { offset: 50 },
  );
  return { run, notices, requests: () => requests, refreshes: () => refreshes };
}

test("批删按外层状态统计，去重且只刷新一次", async () => {
  const app = harness([{ status: "ok" }, { status: "ok" }]);
  await app.run([{ id: "one" }, { id: "one" }, { id: "two" }]);
  assert.equal(app.requests(), 2);
  assert.equal(app.refreshes(), 1);
  assert.match(app.notices[0].message, /已删除 2 个会话/);
});

test("部分失败保留原因，不把 partial 认作全部成功", async () => {
  const app = harness([{ status: "ok" }, { status: "failed", message: "文件被占用" }]);
  await app.run([{ id: "one" }, { id: "two" }]);
  assert.match(app.notices[0].message, /已删除 1 个，失败 1 个/);
  assert.match(app.notices[0].message, /文件被占用/);
  assert.equal(app.notices[0].status, "failed");
});

test("取消批删不会发送请求", async () => {
  const app = harness([], false);
  await app.run([{ id: "one" }]);
  assert.equal(app.requests(), 0);
});

test("增强开关统一保留未保存状态，不再自动保存导致栏闪烁", () => {
  const screen = source.slice(source.indexOf("function EnhanceScreen("), source.indexOf("function DreamSkinScreen("));
  assert.doesNotMatch(screen, /saveSettingsValue|setPersistedEnhanceFlag/);
  assert.match(screen, /dirty \? \(/);
  assert.match(screen, /actions.saveSettings\(\)/);
});

test("悬浮球保留微笑表情，错误不再绘制双 X", async () => {
  const style = await readFile(new URL("../../../assets/inject/floating-panel/core/appearance.js", import.meta.url), "utf8");
  const error = style.slice(style.indexOf('[data-expression="error"] .csw-fab-eye {'), style.indexOf('[data-expression="curious"] .csw-fab-eye {'));
  assert.doesNotMatch(error, /rotate|::before|::after/);
  const view = await readFile(new URL("../../../assets/inject/floating-panel/core/views.js", import.meta.url), "utf8");
  assert.match(view, /csw-fab-happy-arc/);
});
