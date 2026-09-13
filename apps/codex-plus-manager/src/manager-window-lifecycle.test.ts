import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import { createVisibleRefresh } from "./manager-lifecycle.ts";

const source = (await readFile(new URL("./use-manager-lifecycle.ts", import.meta.url), "utf8"))
  .replace(/^import .*;\r?$/gm, "")
  .replace("export function", "function");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(readVisible: () => Promise<boolean> = async () => true) {
  const effects: Array<() => () => void> = [];
  const events = new Map<string, (event: { payload: boolean }) => void>();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const win = new EventTarget();
  let pendingCalls = 0;
  let visible = false;
  const useLifecycle = new Function("useEffect", "useRef", "useState", "listen", "getCurrentWindow", "createVisibleRefresh", "document", "window",
    `${compiled}\nreturn useManagerLifecycle;`,
  )(
    (effect: () => () => void) => effects.push(effect),
    (current: unknown) => ({ current }),
    () => [false, (next: boolean) => { visible = next; }],
    async (name: string, callback: (event: { payload: boolean }) => void) => {
      events.set(name, callback);
      return () => events.delete(name);
    },
    () => ({ isVisible: readVisible, isMinimized: async () => false }),
    createVisibleRefresh, doc, win,
  );
  useLifecycle({
    ready: true, weixinActive: false,
    refreshPending: async () => { pendingCalls++; },
    refreshWeixin: async () => {},
    onError: (error: unknown) => assert.fail(String(error)),
  });
  const cleanups = effects.map((effect) => effect());
  return {
    events, doc, win,
    pendingCalls: () => pendingCalls,
    visible: () => visible,
    emit: (name: string, payload: boolean) => events.get(name)?.({ payload }),
    dispose: () => cleanups.forEach((cleanup) => cleanup()),
  };
}

test("隐藏事件后收到导航通知不会重启刷新，恢复显示时补读", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  t.after(h.dispose);
  await setImmediate();
  assert.equal(h.pendingCalls(), 1);
  h.emit("manager-visibility-changed", false);
  h.emit("manager-navigation-requested", true);
  t.mock.timers.tick(90_000);
  assert.equal(h.visible(), false);
  assert.equal(h.pendingCalls(), 1);
  h.emit("manager-visibility-changed", true);
  await setImmediate();
  assert.equal(h.pendingCalls(), 2);
});

test("启动可见性查询的旧响应不能覆盖后到的隐藏事件", async (t) => {
  let resolve!: (visible: boolean) => void;
  const h = harness(() => new Promise<boolean>((done) => { resolve = done; }));
  t.after(h.dispose);
  await setImmediate();
  h.emit("manager-visibility-changed", false);
  resolve(true);
  await setImmediate();
  assert.equal(h.visible(), false);
  assert.equal(h.pendingCalls(), 0);
});

test("文档隐藏暂停刷新，组件销毁后移除原生与浏览器事件", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness();
  await setImmediate();
  h.doc.visibilityState = "hidden";
  h.doc.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(90_000);
  assert.equal(h.pendingCalls(), 1);
  h.doc.visibilityState = "visible";
  h.doc.dispatchEvent(new Event("visibilitychange"));
  await setImmediate();
  assert.equal(h.pendingCalls(), 2);
  h.dispose();
  assert.equal(h.events.size, 0);
  h.win.dispatchEvent(new Event("focus"));
  t.mock.timers.tick(90_000);
  assert.equal(h.pendingCalls(), 2);
});

test("监听注册尚未完成就销毁时也能清理监听且不发请求", async () => {
  const h = harness();
  h.dispose();
  await setImmediate();
  assert.equal(h.events.size, 0);
  assert.equal(h.pendingCalls(), 0);
});
