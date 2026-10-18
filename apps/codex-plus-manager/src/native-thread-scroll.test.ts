import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { readRendererInjectSource } from "./inject-fragments.ts";

const renderer = await readRendererInjectSource();
const syntax = ts.createSourceFile("renderer.js", renderer, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
let declaration: ts.FunctionDeclaration | undefined;
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "releaseThreadScrollControl") declaration = node;
  ts.forEachChild(node, visit);
}
visit(syntax);
assert.ok(declaration);
const source = declaration.getText(syntax);

function eventTarget() {
  const listeners = new Map<string, Set<Function>>();
  return {
    listeners,
    addEventListener(type: string, callback: Function) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(callback);
    },
    removeEventListener(type: string, callback: Function) { listeners.get(type)?.delete(callback); },
    count() { return [...listeners.values()].reduce((total, callbacks) => total + callbacks.size, 0); },
  };
}

function fixture(legacy = false) {
  const timers = new Map<number, () => void>();
  let serial = 0;
  const setTimeout = (callback: () => void) => { timers.set(++serial, callback); return serial; };
  const clearTimeout = (id: number) => timers.delete(id);
  const window: any = eventTarget(), document = eventTarget();
  const history: any = {};
  const calls: string[] = [];
  class Element {}
  const methods = [
    [Element.prototype, "scrollTo", "elementScrollTo", "codexThreadScrollGuardedScrollTo"],
    [Element.prototype, "scroll", "elementScroll", "codexThreadScrollGuardedScroll"],
    [Element.prototype, "scrollBy", "elementScrollBy", "codexThreadScrollGuardedScrollBy"],
    [Element.prototype, "scrollIntoView", "scrollIntoView", "codexThreadScrollGuardedScrollIntoView"],
    [window, "scrollTo", "windowScrollTo", "codexThreadScrollGuardedWindowScrollTo"],
    [window, "scroll", "windowScroll", "codexThreadScrollGuardedWindowScroll"],
    [window, "scrollBy", "windowScrollBy", "codexThreadScrollGuardedWindowScrollBy"],
    [history, "pushState", "history_pushState", "codexThreadScrollPatchedHistory"],
    [history, "replaceState", "history_replaceState", "codexThreadScrollPatchedHistory"],
  ] as const;
  const originals: Record<string, Function> = {};
  for (const [owner, method, key, name] of methods) {
    const original = () => calls.push(key);
    originals[key] = original;
    (owner as any)[method] = legacy
      ? Object.defineProperty(function () {
        if (window.__codexThreadScrollHandlers?.shouldBlockAutobottom()) return;
        original();
      }, "name", { value: name })
      : original;
  }
  const scroller = eventTarget();
  if (legacy) {
    window.__codexThreadScrollOriginals = originals;
    window.__codexThreadScrollHandlers = { shouldBlockAutobottom: () => true };
    const listener = () => calls.push("saved");
    window.__codexThreadScrollRuntime = { activeScroller: scroller, scrollListener: listener, restoreLock: { targetTop: -1012 } };
    window.addEventListener("scroll", listener);
    scroller.addEventListener("scroll", listener);
    for (const [owner, type, key] of [
      [document, "wheel", "WheelIntent"], [document, "touchmove", "TouchIntent"],
      [document, "keydown", "KeyIntent"], [document, "pointerdown", "PointerIntent"],
      [document, "pointerdown", "Navigation"], [document, "click", "ClickNavigation"],
      [document, "keydown", "Keyboard"], [document, "visibilitychange", "Visibility"],
      [window, "popstate", "PopState"], [window, "hashchange", "HashChange"],
    ] as const) {
      window[`__codexThreadScroll${key}Handler`] = listener;
      owner.addEventListener(type, listener);
    }
    window.__codexThreadScrollSaveTimer = setTimeout(listener);
    window.__codexThreadScrollRestoreTimers = [setTimeout(listener)];
    window.__codexThreadScrollSyncTimers = [setTimeout(listener)];
  }
  const release = new Function("window", "document", "Element", "history", "clearTimeout", "setTimeout",
    `${source}; return releaseThreadScrollControl;`)(window, document, Element, history, clearTimeout, setTimeout);
  function drain() {
    for (let attempt = 0; timers.size && attempt < 10; attempt++) {
      for (const [id, callback] of [...timers]) if (timers.delete(id)) callback();
    }
    assert.equal(timers.size, 0);
  }
  return { window, document, scroller, methods, originals, release, calls, timers, setTimeout, drain };
}

test("原生滚动在冷启动和重复注入后保持原方法", () => {
  const app = fixture();
  app.release(); app.release();
  for (const [owner, method, key] of app.methods) assert.equal((owner as any)[method], app.originals[key]);
  assert.equal(app.timers.size, 0);
  assert.equal(app.window.count() + app.document.count(), 0);
});

test("热更新解除旧滚动锁、监听和恢复任务，忽略旧负坐标", () => {
  const app = fixture(true);
  app.window.__codexThreadScrollEntries = { thread: { top: -1012 } };
  app.release(); app.release(); app.drain();
  assert.equal(app.window.count() + app.document.count() + app.scroller.count(), 0);
  assert.equal(app.window.__codexThreadScrollHandlers, undefined);
  assert.equal(app.window.__codexThreadScrollRuntime, undefined);
  for (const [owner, method, key] of app.methods) {
    assert.equal((owner as any)[method], app.originals[key]);
    (owner as any)[method]();
  }
  assert.equal(app.calls.length, app.methods.length);
  assert.equal(app.calls.includes("saved"), false);
});

test("其他组件包裹过的方法保持原样，内层旧拦截退出", () => {
  const app = fixture(true);
  const [owner, method] = app.methods[0];
  const old = (owner as any)[method];
  const thirdParty = () => old();
  (owner as any)[method] = thirdParty;
  app.release();
  assert.equal((owner as any)[method], thirdParty);
  thirdParty();
  assert.deepEqual(app.calls, ["elementScrollTo"]);
});

test("热更新清理尚未执行的旧零延时同步任务", () => {
  const app = fixture(true);
  app.window.__codexThreadScrollSyncPending = true;
  app.setTimeout(() => {
    const listener = () => app.calls.push("late restore");
    app.scroller.addEventListener("scroll", listener);
    app.window.__codexThreadScrollRuntime = { activeScroller: app.scroller, scrollListener: listener };
    app.window.__codexThreadScrollRestoreTimers = [app.setTimeout(listener)];
    app.window.__codexThreadScrollSyncPending = false;
  });
  app.release(); app.drain();
  assert.equal(app.scroller.count(), 0);
  assert.deepEqual(app.calls, []);
});
