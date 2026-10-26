import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const start = source.indexOf("  const refreshLocalSessions = async");
const end = source.indexOf("  const requestDeleteLocalSession", start);
const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness() {
  const requests: Array<{ request: { offset: number; query: string }; resolve: (value: unknown) => void; reject: (error: unknown) => void }> = [];
  const pages: number[] = [], notices: unknown[] = [], loading: boolean[] = [];
  const revision = { current: 0 }, query = { current: "" };
  const refresh = new Function("localSessionsRevision", "localSessionsQuery", "setLocalSessionsLoading", "call", "setLocalSessions", "isSuccessStatus", "showResultNotice", "showNotice", "stringifyError", "t", js + "return refreshLocalSessions;")(
    revision, query, (value: boolean) => loading.push(value),
    (_name: string, { request }: { request: { offset: number; query: string } }) => new Promise((resolve, reject) => requests.push({ request, resolve, reject })),
    (page: { offset: number }) => pages.push(page.offset), (status: string) => status === "ok",
    (...args: unknown[]) => notices.push(args), (...args: unknown[]) => notices.push(args), String, (text: string) => text,
  );
  return { refresh, requests, pages, notices, loading, revision };
}
const page = (offset: number, count = 1) => ({ status: "ok", offset, limit: 50, sessions: Array.from({ length: count }, (_, id) => ({ id })) });

test("会话慢响应和旧错误不能覆盖新页面", async () => {
  const app = harness();
  const old = app.refresh(true, 0), next = app.refresh(true, 50, "历史");
  app.requests[1].resolve(page(50)); await next;
  app.requests[0].resolve(page(0)); await old;
  assert.deepEqual(app.pages, [50]);
  assert.equal(app.requests[1].request.query, "历史");
  const failed = app.refresh(true, 0), latest = app.refresh(true, 100);
  app.requests[3].resolve(page(100)); await latest;
  app.requests[2].reject(new Error("old failure")); await failed;
  assert.deepEqual(app.pages, [50, 100]);
  assert.equal(app.notices.length, 0);
  assert.equal(app.loading.at(-1), false);
});

test("删除后空页沿同一搜索回退，离页后的响应不提交", async () => {
  const app = harness();
  const pending = app.refresh(true, 100, "目标");
  app.requests[0].resolve(page(100, 0));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(app.requests[1].request, { offset: 50, limit: 50, query: "目标" });
  app.requests[1].resolve(page(50)); await pending;
  assert.deepEqual(app.pages, [50]);
  const stale = app.refresh(true, 0);
  ++app.revision.current;
  app.requests[2].resolve(page(0)); await stale;
  assert.deepEqual(app.pages, [50]);
});
