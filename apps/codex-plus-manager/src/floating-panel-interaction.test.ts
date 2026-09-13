import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [interaction, geometry, views, host, lifecycle, runtimeState] = await Promise.all([
  "core/interaction.js", "core/geometry.js", "core/views.js", "core/host.js",
  "runtime/lifecycle.js", "runtime/state.js",
].map(path => readFile(new URL(`../../../assets/inject/floating-panel/${path}`, import.meta.url), "utf8")));

function extract(source: string, name: string) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `找不到待测函数：${name}`);
  const rest = source.slice(start + 1);
  const next = rest.search(/^  (?:async )?function /m);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

function compile(source: string, dependencies: Record<string, unknown>, exports: string[]) {
  return new Function(...Object.keys(dependencies), `${source}\nreturn { ${exports.join(", ")} };`)(
    ...Object.values(dependencies),
  );
}

function clock() {
  let nextId = 1;
  let requests = 0;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  return {
    frames, timers,
    requests: () => requests,
    requestAnimationFrame(callback: () => void) {
      requests += 1;
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) { frames.delete(id); },
    setTimeout(callback: () => void) {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
    tick() {
      // 本帧回调新排的任务留到下一帧，且尊重回调之间发生的取消。
      for (const [id, callback] of [...frames]) {
        if (frames.delete(id)) callback();
      }
    },
  };
}

type Listener = (event: any) => void;
type ListenerOptions = boolean | { capture?: boolean; passive?: boolean };

class Events {
  listeners: Array<{ type: string; callback: Listener; capture: boolean }> = [];

  addEventListener(type: string, callback: Listener, options: ListenerOptions = false) {
    const capture = typeof options === "boolean" ? options : Boolean(options.capture);
    if (!this.listeners.some(item => item.type === type && item.callback === callback && item.capture === capture)) {
      this.listeners.push({ type, callback, capture });
    }
  }

  removeEventListener(type: string, callback: Listener, options: ListenerOptions = false) {
    const capture = typeof options === "boolean" ? options : Boolean(options.capture);
    this.listeners = this.listeners.filter(item => item.type !== type || item.callback !== callback || item.capture !== capture);
  }

  emit(type: string, values: Record<string, unknown> = {}) {
    const event = {
      type, pointerId: 7, button: 0, clientX: 100, clientY: 100,
      currentTarget: this, target: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...values,
    };
    for (const item of [...this.listeners]) {
      if (item.type === type && this.listeners.includes(item)) item.callback(event);
    }
    return event;
  }
}

class ElementStub extends Events {
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  writes: Array<[string, string]> = [];
  captures: number[] = [];
  releases: number[] = [];
  captured = new Set<number>();
  head: ElementStub | null = null;
  replacements = 0;
  markup = "原始内容";
  style = new Proxy<Record<string, any>>({
    setProperty: (key: string, value: string) => { this.style[key] = value; },
  }, {
    set: (target, key: string, value: string) => {
      this.writes.push([key, value]);
      target[key] = value;
      return true;
    },
  });

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) {
    this.attributes.delete(name);
    const key = name.replace(/^data-/, "").replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    delete this.dataset[key];
  }
  closest(_selector: string) { return null; }
  querySelector(selector: string) { return selector === ".csw-head" ? this.head : null; }
  querySelectorAll() { return []; }
  setPointerCapture(id: number) { this.captures.push(id); this.captured.add(id); }
  releasePointerCapture(id: number) {
    this.releases.push(id);
    if (this.captured.delete(id)) this.emit("lostpointercapture", { pointerId: id });
  }
  remove() {}
  set innerHTML(value: string) {
    this.markup = value;
    this.replacements += 1;
    this.head = new ElementStub();
  }
  get innerHTML() { return this.markup; }
}

type Position = { x: number; y: number };

function runtime(open = false) {
  const time = clock();
  const window = Object.assign(new Events(), time);
  const document = Object.assign(new Events(), {
    visibilityState: "visible", activeElement: null,
    querySelectorAll: () => [], getElementById: () => null,
  });
  const handle = new ElementStub();
  const panel = new ElementStub();
  panel.head = handle;
  const state: Record<string, any> = {
    runtimeActive: true, runtimeGeneration: 1, activeContext: { generation: 1 },
    open, position: { x: 400, y: 100 }, width: 404, height: 420,
    activeTab: "next", pendingRender: false, drag: null, resizeDrag: null,
    morphAnimation: null, layout: null, timer: 0, scans: 0,
    root: new ElementStub(), fab: new ElementStub(), popover: new ElementStub(),
    glass: new ElementStub(), panel, prompts: [], outlineItems: [],
  };
  let bounds = { left: 20, top: 30, right: 1220, bottom: 930, width: 1200, height: 900 };
  const calls = { bounds: 0, morph: [] as number[], fade: 0, eyes: 0, installs: 0, scans: 0 };
  const saved: Position[] = [];
  const noop = () => {};
  const dependencies: Record<string, unknown> = {
    state, window, document, Element: ElementStub, HTMLElement: ElementStub,
    isCurrentRuntime: (generation = state.runtimeGeneration) => state.runtimeActive && generation === state.runtimeGeneration,
    contentSafeBounds: () => { calls.bounds += 1; return bounds; },
    clamp: (value: number, min: number, max: number) => Math.min(max, Math.max(min, value)),
    clampPanelHeight: (value: number) => Math.min(720, Math.max(340, value)),
    POSITION_KEY: "position", STYLE_ID: "style", SCAN_DELAY_MS: 160,
    localStorage: { setItem: (_key: string, value: string) => saved.push(JSON.parse(value)) },
    prefersReducedMotion: () => false,
    applyMorphProgress: (progress: number) => calls.morph.push(progress),
    syncContentFade: () => { calls.fade += 1; },
    syncEyeTracking: () => { calls.eyes += 1; },
    installStyle: () => { calls.installs += 1; }, installFloat: noop,
    normalizeActiveTab: () => state.activeTab, captureViewScroll: () => ({}),
    usesOutlineExpression: () => false, resolveFabExpression: () => "ready",
    fabExpressionLabel: () => "就绪", stepwiseEnabled: () => true, outlineEnabled: () => false,
    refreshControlState: () => ({ blocked: false, title: "刷新" }),
    statusToneForView: () => "ready", activePaneCue: () => null, enabledViewOrder: () => [],
    escapeAttr: (value: string) => value, statusStageHtml: () => "", sourceTrackHtml: () => "",
    iconSvg: () => "", themeLabel: () => "主题", themeIcon: () => "",
    nextHtml: () => state.prompts.join(""),
    chatSurfaceReady: () => { calls.scans += 1; return false; },
    setScanStatus: () => false, chatRoot: () => null, composerCandidates: () => [], chatBusy: () => false,
  };
  for (const name of [
    "resetEyePointer", "clearPromptInteractionTimers", "cancelViewAnimation", "syncTheme", "normalizePromptState",
    "settleMorph", "viewTabHtml", "animateViewTabSelection", "animateSourceCue", "restoreViewScroll",
    "installContentFadeTracking", "onHeadFaceClick", "bindGlassPointerSurface", "toggleCodexTheme",
    "applyMaterial", "attachNextEvents", "installViewTabReorder", "cancelSourceCueAnimation",
    "cancelMorphAnimations", "removeContextTracking", "onResize", "clearStepwisePayloadMarks", "outlineClearMarks",
  ]) dependencies[name] = noop;

  // 几何常量也取当前源码，避免测试中的尺寸与运行时悄悄分叉。
  const constants = runtimeState.slice(runtimeState.indexOf("  const CHIP_WIDTH ="), runtimeState.indexOf("  const DEFAULT_FONT ="))
    + runtimeState.slice(runtimeState.indexOf("  const MIN_MORPH_MS ="), runtimeState.indexOf("  const UNFOLD_SAMPLES ="));
  const geometryNames = ["defaultPosition", "clampPosition", "persistPosition", "setPosition", "dockRightKeepHeight", "snapRightIfNear", "shellLayout", "panelDragPosition", "applyPosition"];
  const interactionNames = ["createPointerFrame", "onFabPointerDown", "dragTargetBlocked", "beginDrag", "installPanelDrag"];
  const hostNames = ["deferRender", "flushDeferredRender"];
  const lifecycleNames = ["scan", "scheduleScan", "stopRuntime"];
  const source = constants + [
    ...geometryNames.map(name => extract(geometry, name)),
    ...interactionNames.map(name => extract(interaction, name)),
    ...hostNames.map(name => extract(host, name)), extract(views, "renderFloat"),
    ...lifecycleNames.map(name => extract(lifecycle, name)),
  ].join("\n");
  const api = compile(source, dependencies, [...geometryNames, ...interactionNames, ...hostNames, "renderFloat", ...lifecycleNames]);
  api.applyPosition();
  calls.bounds = 0;
  calls.morph.length = 0;
  calls.fade = 0;
  state.popover.writes.length = 0;
  state.root.writes.length = 0;
  state.fab.writes.length = 0;
  return {
    api, state, time, window, document, handle, panel, calls, saved,
    setBounds: (value: typeof bounds) => { bounds = value; },
    begin() {
      if (open) api.installPanelDrag();
      else handle.addEventListener("pointerdown", api.onFabPointerDown);
      return handle.emit("pointerdown");
    },
    move(x: number, y: number, pointerId = 7) { return window.emit("pointermove", { clientX: x, clientY: y, pointerId }); },
    transforms: () => state.popover.writes.filter(([key]: [string, string]) => key === "transform").length,
  };
}

function pointerRuntime() {
  const time = clock();
  let current = true;
  const updates: Position[] = [];
  const { createPointerFrame } = compile(extract(interaction, "createPointerFrame"), {
    window: time, isCurrentRuntime: () => current,
  }, ["createPointerFrame"]);
  const frame = createPointerFrame((value: Position) => updates.push(value));
  return { time, updates, frame, invalidate: () => { current = false; } };
}

test("同帧高频坐标只更新最后一次，下一帧仍能继续调度", () => {
  const { time, updates, frame } = pointerRuntime();
  for (let x = 1; x <= 100; x += 1) frame.schedule({ x, y: x * 2 });
  assert.equal(time.requests(), 1);
  assert.deepEqual(updates, []);
  time.tick();
  assert.deepEqual(updates, [{ x: 100, y: 200 }]);
  frame.schedule({ x: 101, y: 202 });
  time.tick();
  assert.equal(time.requests(), 2);
  assert.deepEqual(updates, [{ x: 100, y: 200 }, { x: 101, y: 202 }]);
});

test("同步刷新消费最后坐标，原动画帧和重复刷新不会二次更新", () => {
  const { time, updates, frame } = pointerRuntime();
  frame.schedule({ x: 1, y: 2 });
  frame.schedule({ x: 3, y: 4 });
  frame.flush();
  assert.deepEqual(updates, [{ x: 3, y: 4 }]);
  assert.equal(time.frames.size, 0);
  frame.flush();
  time.tick();
  assert.equal(updates.length, 1);
});

test("取消清空待更新位置，后续刷新不会复活旧坐标且可重新调度", () => {
  const { time, updates, frame } = pointerRuntime();
  frame.schedule({ x: 1, y: 2 });
  frame.cancel();
  assert.equal(time.frames.size, 0);
  time.tick();
  frame.flush();
  assert.deepEqual(updates, []);
  frame.schedule({ x: 3, y: 4 });
  time.tick();
  assert.deepEqual(updates, [{ x: 3, y: 4 }]);
});

test("运行时失效后，动画帧与同步刷新均不更新旧实例", () => {
  const app = pointerRuntime();
  app.frame.schedule({ x: 1, y: 2 });
  app.invalidate();
  app.time.tick();
  app.frame.schedule({ x: 3, y: 4 });
  app.frame.flush();
  assert.deepEqual(app.updates, []);
  assert.equal(app.time.frames.size, 0);
});

for (const open of [false, true]) {
  const label = open ? "展开标题" : "悬浮球";
  test(`${label}实际拖拽接线过滤其他指针和轻微移动，每帧只读一次边界并更新一次`, () => {
    const app = runtime(open);
    app.begin();
    assert.equal(app.move(500, 500, 8).defaultPrevented, false);
    assert.equal(app.move(101, 101).defaultPrevented, false);
    assert.equal(app.time.frames.size, 0);
    assert.deepEqual(app.handle.captures, []);
    app.state.snapTimer = app.time.setTimeout(() => assert.fail("旧吸附计时器不应继续执行"));
    app.state.popover.dataset.snapRight = "true";
    for (let x = 110; x <= 140; x += 1) assert.equal(app.move(x, 150).defaultPrevented, true);
    assert.deepEqual(app.state.position, { x: 400, y: 100 });
    assert.equal(app.calls.bounds, 0);
    assert.equal(app.transforms(), 0);
    assert.equal(app.time.requests(), 1);
    assert.deepEqual(app.handle.captures, [7]);
    assert.equal(app.state.snapTimer, 0);
    assert.equal(app.time.timers.size, 0);
    assert.equal(app.state.popover.dataset.snapRight, undefined);
    app.time.tick();
    assert.deepEqual(app.state.position, { x: 440, y: 150 });
    assert.equal(app.calls.bounds, 1);
    assert.equal(app.transforms(), 1);
    app.move(160, 170);
    app.time.tick();
    assert.deepEqual(app.state.position, { x: 460, y: 170 });
    assert.equal(app.calls.bounds, 2);
    assert.equal(app.transforms(), 2);
  });

  test(`${label}松手同步采用 pointerup 最后坐标并只持久化一次`, () => {
    const app = runtime(open);
    app.begin();
    app.move(120, 130);
    app.window.emit("pointerup", { pointerId: 8, clientX: 900, clientY: 900 });
    assert.ok(app.state.drag);
    assert.deepEqual(app.saved, []);
    app.window.emit("pointerup", { clientX: 160, clientY: 180 });
    assert.deepEqual(app.state.position, { x: 460, y: 180 });
    assert.deepEqual(app.saved, [{ x: 460, y: 180 }]);
    assert.equal(app.transforms(), 1);
    assert.equal(app.state.drag, null);
    assert.equal(app.state.dragCleanup, null);
    assert.equal(app.handle.attributes.has("data-dragging"), false);
    assert.deepEqual(app.handle.releases, [7]);
    assert.equal(app.time.frames.size, 0);
    app.time.tick();
    assert.equal(app.transforms(), 1);
    assert.equal(open ? app.state.suppressHeadFaceClick : app.state.suppressFabClick, true);
  });
}

for (const ending of ["blur", "lostpointercapture", "pointercancel", "visibilitychange"]) {
  test(`${ending}结束拖拽时保留待处理坐标并移除全部临时监听`, () => {
    const app = runtime(true);
    app.begin();
    app.move(150, 160);
    if (ending === "lostpointercapture") {
      app.handle.emit(ending, { pointerId: 8 });
      assert.ok(app.state.drag);
      app.handle.emit(ending);
    } else if (ending === "visibilitychange") {
      app.document.emit(ending);
      assert.ok(app.state.drag);
      app.document.visibilityState = "hidden";
      app.document.emit(ending);
    } else {
      app.window.emit(ending, { clientX: 999, clientY: 999 });
    }
    assert.deepEqual(app.saved, [{ x: 450, y: 160 }]);
    assert.equal(app.state.drag, null);
    assert.equal(app.state.dragCleanup, null);
    assert.deepEqual(app.window.listeners, []);
    assert.deepEqual(app.document.listeners, []);
    assert.deepEqual(app.handle.listeners.map(item => item.type), ["pointerdown"]);
    assert.deepEqual(app.handle.releases, [7]);
    assert.equal(app.time.frames.size, 0);
    app.move(500, 600);
    app.window.emit("pointerup");
    app.window.emit("blur");
    app.handle.emit("lostpointercapture");
    app.time.tick();
    assert.deepEqual(app.state.position, { x: 450, y: 160 });
    assert.equal(app.saved.length, 1);
    assert.equal(app.transforms(), 1);
  });
}

test("直接清理拖拽会取消尚未执行的移动且不持久化", () => {
  const app = runtime();
  app.begin();
  app.move(150, 160);
  app.state.dragCleanup();
  assert.equal(app.time.frames.size, 0);
  assert.equal(app.state.drag, null);
  assert.equal(app.state.dragCleanup, null);
  app.time.tick();
  app.move(500, 600);
  assert.deepEqual(app.state.position, { x: 400, y: 100 });
  assert.equal(app.transforms(), 0);
  assert.deepEqual(app.saved, []);
  assert.deepEqual(app.window.listeners, []);
  assert.deepEqual(app.document.listeners, []);
});

test("直接取消后不残留拖拽状态，延后渲染和扫描可以继续", () => {
  const app = runtime(true);
  app.begin();
  app.move(150, 160);
  app.state.prompts = ["取消后的最新内容"];
  app.api.renderFloat();
  assert.equal(app.state.pendingRender, true);
  assert.equal(app.panel.replacements, 0);
  app.state.dragCleanup();
  // cleanup 只负责取消；由调用方决定何时补渲染，避免停止运行时又重建界面。
  assert.equal(app.state.drag, null);
  assert.equal(app.api.flushDeferredRender(), true);
  assert.equal(app.state.pendingRender, false);
  assert.equal(app.panel.replacements, 1);
  assert.ok(app.panel.innerHTML.includes("取消后的最新内容"));
  assert.equal(app.api.flushDeferredRender(), false);
  app.api.scan();
  assert.equal(app.state.scans, 1);
  assert.equal(app.calls.scans, 1);
  assert.equal(app.time.timers.size, 0);
  assert.deepEqual(app.saved, []);
});

test("旧拖拽的清理回调再次执行不会清除新拖拽或取消新帧", () => {
  const app = runtime(true);
  app.begin();
  const oldCleanup = app.state.dragCleanup;
  app.move(150, 160);
  app.handle.emit("pointerdown", { pointerId: 8 });
  const nextDrag = app.state.drag;
  const nextCleanup = app.state.dragCleanup;
  assert.equal(nextDrag.pointerId, 8);
  app.move(170, 180, 8);
  oldCleanup();
  assert.equal(app.state.drag, nextDrag);
  assert.equal(app.state.dragCleanup, nextCleanup);
  assert.equal(app.time.frames.size, 1);
  app.time.tick();
  assert.deepEqual(app.state.position, { x: 470, y: 180 });
  app.window.emit("pointerup", { pointerId: 8, clientX: 190, clientY: 200 });
  assert.deepEqual(app.saved, [{ x: 490, y: 200 }]);
  assert.equal(app.state.drag, null);
});

test("松手吸附完成后才清理拖拽，向上展开的面板不会中途翻转方向", () => {
  const app = runtime(true);
  app.api.setPosition({ x: 400, y: 750 });
  assert.equal(app.state.layout.opensDown, false);
  app.begin();
  app.move(900, -200);
  // 此处松手位置已足够向下展开，但本次拖拽仍应保留向上的展开方向。
  app.window.emit("pointerup", { clientX: 900, clientY: -200 });
  assert.deepEqual(app.saved, [{ x: 1136, y: 450 }]);
  assert.equal(app.state.layout.opensDown, false);
  assert.equal(app.state.layout.top, 76);
  assert.equal(app.state.layout.height, 420);
  assert.equal(app.state.drag, null);
  assert.equal(app.state.dragCleanup, null);
  assert.equal(app.time.frames.size, 0);
});

test("标题安装重复调用只绑定一次拖拽，未达到阈值的点击不保存位置", () => {
  const app = runtime(true);
  app.api.installPanelDrag();
  app.api.installPanelDrag();
  assert.equal(app.handle.listeners.length, 1);
  app.begin();
  app.move(101, 101);
  app.window.emit("pointerup", { clientX: 102, clientY: 102 });
  assert.deepEqual(app.saved, []);
  assert.equal(app.state.suppressHeadFaceClick, false);
  assert.equal(app.transforms(), 0);
  assert.equal(app.state.drag, null);
});

test("拖拽期间多次渲染保留标题和最新数据，松手后只补渲染一次", () => {
  const app = runtime(true);
  app.begin();
  app.move(120, 130);
  for (const text of ["过时内容", "最新内容"]) {
    app.state.prompts = [text];
    app.api.renderFloat({ allowDuringTransition: true });
    assert.equal(app.api.flushDeferredRender(), false);
  }
  assert.equal(app.panel.head, app.handle);
  assert.equal(app.panel.replacements, 0);
  assert.equal(app.state.pendingRender, true);
  assert.equal(app.calls.installs, 0);
  app.window.emit("pointerup", { clientX: 150, clientY: 160 });
  assert.equal(app.panel.replacements, 1);
  assert.notEqual(app.panel.head, app.handle);
  assert.ok(app.panel.innerHTML.includes("最新内容"));
  assert.ok(!app.panel.innerHTML.includes("过时内容"));
  assert.equal(app.state.pendingRender, false);
  assert.equal(app.calls.eyes, 1);
  assert.equal(app.api.flushDeferredRender(), false);
  assert.equal(app.panel.replacements, 1);
});

test("仅按下后收到失焦也会补渲染，不吞掉未移动时的延后内容", () => {
  const app = runtime(true);
  app.begin();
  app.api.renderFloat();
  app.window.emit("blur");
  assert.equal(app.panel.replacements, 1);
  assert.equal(app.state.pendingRender, false);
  assert.equal(app.state.drag, null);
  assert.deepEqual(app.saved, []);
});

test("缩放期间强制渲染仍延后，缩放结束且过渡完成才消费待渲染标记", () => {
  const app = runtime(true);
  app.state.resizeDrag = {};
  app.api.renderFloat({ allowDuringTransition: true });
  assert.equal(app.panel.replacements, 0);
  assert.equal(app.state.pendingRender, true);
  assert.equal(app.api.flushDeferredRender(), false);
  app.state.resizeDrag = null;
  for (const field of ["viewTransitioning", "morphAnimation"]) {
    app.state[field] = true;
    assert.equal(app.api.flushDeferredRender(), false);
    assert.equal(app.state.pendingRender, true);
    app.state[field] = false;
  }
  assert.equal(app.api.flushDeferredRender(), true);
  assert.equal(app.panel.replacements, 1);
  assert.equal(app.state.pendingRender, false);
  assert.equal(app.api.flushDeferredRender(), false);
});

for (const field of ["drag", "resizeDrag"]) {
  test(`${field === "drag" ? "拖拽" : "缩放"}期间扫描只重新排期，结束后执行一次且忽略过期计时器`, () => {
    const app = runtime();
    app.state[field] = {};
    app.api.scheduleScan();
    const firstId = app.state.timer;
    const first = app.time.timers.get(firstId)!;
    app.time.timers.delete(firstId);
    first();
    assert.equal(app.state.scans, 0);
    assert.equal(app.calls.installs, 0);
    assert.equal(app.calls.scans, 0);
    assert.notEqual(app.state.timer, firstId);
    assert.equal(app.time.timers.size, 1);
    const nextId = app.state.timer;
    first();
    assert.equal(app.state.timer, nextId);
    assert.equal(app.time.timers.size, 1);
    app.state[field] = null;
    const next = app.time.timers.get(nextId)!;
    app.time.timers.delete(nextId);
    next();
    assert.equal(app.state.timer, 0);
    assert.equal(app.state.scans, 1);
    assert.equal(app.calls.installs, 1);
    assert.equal(app.calls.scans, 1);
    assert.equal(app.time.timers.size, 0);
  });
}

test("停止运行时取消拖拽和材质指针的待执行帧，旧回调不再写界面", () => {
  const app = runtime();
  let glassUpdates = 0;
  app.state.glassPointerFrame = app.api.createPointerFrame(() => { glassUpdates += 1; });
  app.state.glassPointerFrame.schedule({ x: 1, y: 2 });
  app.begin();
  app.move(150, 160);
  const popover = app.state.popover;
  const generation = app.state.runtimeGeneration;
  app.api.stopRuntime();
  assert.equal(app.state.runtimeActive, false);
  assert.equal(app.state.runtimeGeneration, generation + 1);
  assert.equal(app.state.glassPointerFrame, null);
  assert.equal(app.state.drag, null);
  assert.equal(app.time.frames.size, 0);
  assert.deepEqual(app.window.listeners, []);
  app.time.tick();
  app.api.scan(generation);
  assert.equal(glassUpdates, 0);
  assert.equal(popover.writes.length, 0);
  assert.deepEqual(app.saved, []);
});

test("几何定位、默认布局和右侧吸附各轮只读取一次边界", () => {
  const app = runtime();
  app.api.setPosition({ x: -100, y: -100 }, true);
  assert.equal(app.calls.bounds, 1);
  assert.deepEqual(app.state.position, { x: 20, y: 30 });
  assert.deepEqual(app.saved, [{ x: 20, y: 30 }]);
  app.state.position = null;
  const layout = app.api.shellLayout();
  assert.equal(app.calls.bounds, 2);
  assert.deepEqual(layout.anchor, { x: 1136, y: 74 });
  app.state.position = { x: 1110, y: 100 };
  assert.equal(app.api.snapRightIfNear(true), true);
  assert.equal(app.calls.bounds, 3);
  assert.deepEqual(app.state.position, { x: 1136, y: 100 });
  assert.deepEqual(app.saved[1], { x: 1136, y: 100 });
  app.state.position = { x: 400, y: 200 };
  assert.equal(app.api.snapRightIfNear(), false);
  assert.equal(app.calls.bounds, 4);
  app.api.dockRightKeepHeight(false);
  assert.equal(app.calls.bounds, 5);
  assert.deepEqual(app.state.position, { x: 1136, y: 200 });
});

const geometrySignatures: Array<{
  name: string;
  boundsIndex: number;
  args: (app: ReturnType<typeof runtime>) => unknown[];
}> = [
  { name: "defaultPosition", boundsIndex: 0, args: () => [] },
  { name: "clampPosition", boundsIndex: 1, args: () => [{ x: 2000, y: 2000 }] },
  { name: "setPosition", boundsIndex: 2, args: () => [{ x: 2000, y: 2000 }] },
  { name: "dockRightKeepHeight", boundsIndex: 1, args: () => [] },
  { name: "snapRightIfNear", boundsIndex: 2, args: () => [] },
  { name: "shellLayout", boundsIndex: 0, args: () => [] },
  {
    name: "panelDragPosition", boundsIndex: 3,
    args: app => [{
      originLayout: app.state.layout, originPanelLeft: 240, originPanelTop: 100, lockedOpensDown: true,
    }, 2000, 2000],
  },
  { name: "applyPosition", boundsIndex: 0, args: () => [] },
];

for (const signature of geometrySignatures) {
  test(`${signature.name}省略边界与显式 undefined 保持旧调用语义，传入边界不额外读取`, () => {
    const results = ["省略", "undefined", "显式边界"].map(mode => {
      const app = runtime();
      const bounds = app.state.layout.bounds;
      app.state.position = { x: 1110, y: 100 };
      const args = signature.args(app);
      if (mode !== "省略") {
        while (args.length <= signature.boundsIndex) args.push(undefined);
        if (mode === "显式边界") {
          args[signature.boundsIndex] = bounds;
          // 使实时边界与传入快照不同，避免实现忽略快照仍碰巧算出同一位置。
          app.setBounds({ left: 0, top: 0, right: 500, bottom: 500, width: 500, height: 500 });
        }
      }
      const result = app.api[signature.name](...args);
      assert.equal(app.calls.bounds, mode === "显式边界" ? 0 : 1);
      return {
        result, position: app.state.position, layout: app.state.layout, saved: app.saved,
        writes: app.state.popover.writes, morph: app.calls.morph, fade: app.calls.fade,
        timers: app.time.timers.size,
      };
    });
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
    assert.equal(results[0].timers, 0);
    assert.equal(results[0].saved.length, signature.name === "dockRightKeepHeight" ? 1 : 0);
  });
}

test("新增边界参数不改变 setPosition、靠右和吸附原有的保存及动画开关", () => {
  const app = runtime();
  const bounds = app.state.layout.bounds;
  app.api.setPosition({ x: 410, y: 110 }, false, bounds);
  assert.deepEqual(app.saved, []);
  app.api.setPosition({ x: 420, y: 120 }, true, bounds);
  assert.deepEqual(app.saved, [{ x: 420, y: 120 }]);
  app.api.dockRightKeepHeight(false, bounds);
  assert.deepEqual(app.state.position, { x: 1136, y: 120 });
  assert.equal(app.saved.length, 1);
  app.api.snapRightIfNear(false, true, bounds);
  assert.equal(app.saved.length, 1);
  assert.equal(app.state.popover.dataset.snapRight, "true");
  assert.equal(app.time.timers.size, 1);
  const timer = app.state.snapTimer;
  app.time.timers.get(timer)!();
  app.time.timers.delete(timer);
  assert.equal(app.state.popover.dataset.snapRight, undefined);
  app.api.snapRightIfNear(true, false, bounds);
  assert.deepEqual(app.saved, [{ x: 420, y: 120 }, { x: 1136, y: 120 }]);
  assert.equal(app.time.timers.size, 0);
  assert.equal(app.calls.bounds, 0);
});

test("拖到吸附范围的一帧沿用同一边界且不会重复应用位置", () => {
  const app = runtime();
  app.begin();
  app.move(810, 120);
  app.time.tick();
  assert.deepEqual(app.state.position, { x: 1136, y: 120 });
  assert.equal(app.calls.bounds, 1);
  assert.equal(app.transforms(), 1);
  assert.deepEqual(app.saved, []);
  app.window.emit("pointerup", { clientX: 810, clientY: 120 });
  assert.deepEqual(app.saved, [{ x: 1136, y: 120 }]);
});

test("平移只更新 transform，尺寸或内部锚点变化才重做形变和内容渐隐", () => {
  const app = runtime(true);
  app.api.setPosition({ x: 430, y: 120 });
  app.api.setPosition({ x: 460, y: 140 });
  assert.equal(app.state.popover.style.transform, "translate(300px, 140px)");
  assert.deepEqual(app.state.popover.writes, [
    ["transform", "translate(270px, 120px)"], ["transform", "translate(300px, 140px)"],
  ]);
  assert.deepEqual(app.state.root.writes, []);
  assert.deepEqual(app.state.fab.writes, []);
  assert.deepEqual(app.calls.morph, []);
  assert.equal(app.calls.fade, 0);
  app.state.width = 444;
  app.api.applyPosition();
  assert.equal(app.state.popover.style.width, "444px");
  assert.deepEqual(app.calls.morph, [1]);
  assert.equal(app.calls.fade, 1);
  app.api.setPosition({ x: 20, y: 140 });
  assert.equal(app.state.fab.style.left, "0px");
  assert.deepEqual(app.calls.morph, [1, 1]);
  assert.equal(app.calls.fade, 2);
});

test("每轮重新读取变化后的边界并更新压缩状态，进行中的形变不被覆盖", () => {
  const app = runtime(true);
  app.api.setPosition({ x: 400, y: 100 });
  assert.equal(app.calls.bounds, 1);
  app.setBounds({ left: 20, top: 30, right: 1220, bottom: 300, width: 1200, height: 270 });
  app.state.morphAnimation = {};
  app.api.applyPosition();
  assert.equal(app.calls.bounds, 2);
  assert.equal(app.state.layout.height, 200);
  assert.equal(app.state.popover.dataset.compressed, "true");
  assert.equal(app.state.popover.style.height, "200px");
  assert.deepEqual(app.calls.morph, []);
  assert.equal(app.calls.fade, 1);
});
