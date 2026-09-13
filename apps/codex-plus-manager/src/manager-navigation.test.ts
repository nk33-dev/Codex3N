import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

const app = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
const source = app.slice(app.indexOf("  const consumePendingManagerNavigation ="), app.indexOf("  const launch = async"));
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  let resolve!: (value: unknown) => void;
  const response = new Promise((done) => { resolve = done; });
  const revision = { current: 0 };
  const visited: string[] = [];
  const navigate = { current: async (page: string) => { visited.push(page); } };
  const consume = new Function("invoke", "navigationRevision", "navigateRef", "setPendingSettingsSection", "logDiagnostic", "stringifyError",
    `${compiled}\nreturn consumePendingManagerNavigation;`,
  )(() => response, revision, navigate, () => {}, assert.fail, String) as (initial?: boolean) => Promise<boolean>;
  return { consume, resolve, revision, navigate, visited };
}

test("启动导航响应晚于用户切页时不抢回页面", async () => {
  const h = harness();
  const pending = h.consume(true);
  h.revision.current++;
  h.resolve({ page: "settings", section: "stepwise" });
  assert.equal(await pending, false);
  assert.deepEqual(h.visited, []);
});

test("待处理导航使用最新回调，保留当前皮肤草稿离页保护", async () => {
  const h = harness();
  const pending = h.consume();
  h.navigate.current = async (page) => { h.visited.push(`guard:${page}`); };
  h.resolve({ page: "relay" });
  assert.equal(await pending, true);
  assert.deepEqual(h.visited, ["guard:relay"]);
});

test("没有待处理导航时不刷新设置或切换页面", async () => {
  const h = harness();
  const pending = h.consume();
  h.resolve(null);
  assert.equal(await pending, false);
  assert.deepEqual(h.visited, []);
});
