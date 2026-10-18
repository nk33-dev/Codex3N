const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const dictationSource = readFileSync(`${__dirname}/renderer-inject/93-dictation.js`, "utf8");
const contextSource = readFileSync(`${__dirname}/renderer-inject/93-prompt-enhance-context.js`, "utf8");
const librarySource = readFileSync(`${__dirname}/renderer-inject/93-prompt-library.js`, "utf8");
const source = readFileSync(`${__dirname}/renderer-inject/93-prompt-enhance.js`, "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));

// 极简 ProseMirror 文档：只模拟提示词增强用到的读、替换、追加与选区。
function proseMirror(lines, extra = []) {
  const textNode = text => ({ isText: true, type: { name: "text" }, text });
  const paragraph = text => ({ type: { name: "paragraph" }, children: text ? [textNode(text)] : [] });
  const doc = blocks => ({
    blocks,
    get content() { return { size: blocks.length * 2 }; },
    textBetween() { return blocks.map(block => block.children.map(child => child.text ?? child.attrs?.label ?? "").join("")).join("\n"); },
    descendants(visit) { for (const block of blocks) if (visit(block) !== false) for (const child of block.children) visit(child); },
  });
  const schema = {
    nodes: { paragraph: { create: (_, child) => ({ type: { name: "paragraph" }, children: child ? [child] : [] }) } },
    text: textNode,
  };
  const selection = { constructor: { atEnd: current => ({ from: current.content.size, atEnd: true }) } };
  const view = { isDestroyed: false, dispatched: [], state: { doc: doc(lines.map(paragraph)), schema, selection } };
  if (extra.length) view.state.doc.blocks[0].children.push(...extra);
  Object.defineProperty(view.state, "tr", { get() {
    const tr = {
      doc: view.state.doc, steps: [],
      replaceWith(from, to, nodes) { tr.steps.push(["replaceWith", from, to]); tr.doc = doc(nodes); return tr; },
      insert(at, nodes) { tr.steps.push(["insert", at]); tr.doc = doc([...tr.doc.blocks, ...nodes]); return tr; },
      insertText(text) { tr.steps.push(["insertText", text]); return tr; },
      setSelection(value) { tr.selection = value; return tr; },
      scrollIntoView() { return tr; },
    };
    return tr;
  } });
  view.dispatch = tr => { view.dispatched.push(tr); view.state.doc = tr.doc; };
  return view;
}

function fixture({ editorKind = "prosemirror", lines = ["修一下登录页"], extra = [], respond } = {}) {
  const requests = [], cancellations = [], toasts = [], events = [], appended = [], responseResolvers = [];
  let resolveResponse;
  class Textarea {
    constructor(value) { this._value = value; this.dataset = {}; this.isConnected = true; }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    setSelectionRange(from, to) { this.selectionStart = from; this.selectionEnd = to; }
    focus() { document.activeElement = this; }
    dispatchEvent(event) { events.push(event.type); }
    closest() { return null; }
    matches() { return false; }
  }
  let editor;
  if (editorKind === "textarea") editor = new Textarea(lines.join("\n"));
  else {
    editor = { isConnected: true, dataset: {}, focus() { document.activeElement = editor; }, closest: () => null, matches: () => false };
    const view = proseMirror(lines, extra);
    view.dom = editor;
    editor.pmViewDesc = { view };
  }
  const document = {
    body: { append: node => appended.push(node) }, head: { append() {} }, activeElement: null,
    querySelectorAll: () => [], getElementById: () => null,
    addEventListener() {}, removeEventListener() {},
    createElement: () => ({ dataset: {}, style: {}, append() {}, setAttribute() {}, addEventListener() {}, replaceChildren() {} }),
    execCommand: () => { throw Error("prompt enhance must use a native transaction or controlled textarea"); },
  };
  const window = { location: { href: "app://-/thread/one" }, innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
  const context = vm.createContext({
    window, document, navigator: {}, HTMLTextAreaElement: Textarea, Event, console, crypto: { randomUUID: () => "id" },
    requestAnimationFrame: () => {}, setInterval, clearInterval, setTimeout, clearTimeout,
    registerCodexPlusExtensionSelector() {}, visibleElement: () => true, isExtensionUiNode: () => false,
    codexPlusBackendSettingsLoaded: true,
    codexPlusBackendSettings: { promptEnhance: { enabled: true }, dictation: { enabled: false } },
    showToast: message => toasts.push(message), loadOptionalCodexAppModule: async () => ({}),
    postJson: async (path, payload) => {
      if (path === "/prompt-enhance/cancel") { cancellations.push(payload); return { status: "ok" }; }
      requests.push({ path, payload });
      if (respond) return respond(payload);
      return new Promise(resolve => { resolveResponse = resolve; responseResolvers.push(resolve); });
    },
  });
  vm.runInContext(`${dictationSource}\n${contextSource}\n${source}\n${librarySource}\n globalThis.testApi = {
    state: codexPlusPromptEnhance, read: codexPlusPromptEnhanceRead, write: codexPlusPromptEnhanceWrite,
    start: startCodexPlusPromptEnhance, apply: applyCodexPlusPromptEnhance, close: closeCodexPlusPromptEnhance,
    forget: () => codexPlusPromptWorkflows.clear(),
    blocker: codexPlusPromptEnhanceReplaceBlocker, enabled: codexPlusPromptEnhanceEnabled,
    request: requestCodexPlusPromptEnhance, guard: guardCodexPlusPromptEnhance,
    position: positionCodexPlusPromptCard,
    render: renderCodexPlusPromptEnhance, toolsHost: codexPlusPromptToolsHost,
    updateTrigger: updateCodexPlusPromptEnhanceTrigger,
    keydown: codexPlusPromptEnhanceKeyHandler,
    modes: codexPlusPromptEnhanceModes, library: codexPlusPromptLibrary, useFavorite: useCodexPlusPromptFavorite,
    round: codexPlusPromptEnhanceRound, location: codexPlusPromptEnhanceLocation, project: codexPlusPromptEnhanceProject,
    mergeQuestions: codexPlusPromptMergeQuestions, pick: pickCodexPlusPromptEnhanceAnswer,
  };`, context);
  context.renderCodexPlusPromptEnhance = () => {};
  // 跳过 DOM 布局查询，直接把 footer 映射到测试输入框。
  context.codexPlusDictationScope = () => ({});
  context.codexPlusDictationEditor = () => editor;
  return { ...context.testApi, context, editor, requests, cancellations, toasts, events, responseResolvers, resolve: value => resolveResponse(value) };
}

(async () => {
  const layout = fixture();
  const panel = { style: {} };
  let rect = { left: 180, top: 600, bottom: 760, width: 840 };
  layout.context.codexPlusPromptCardScope = () => ({ getBoundingClientRect: () => rect });
  layout.position(panel);
  assert.equal(panel.style.bottom, "208px", "短内容也通过底边贴住输入框");
  assert.equal(panel.style.top, "auto");
  assert.equal(panel.style.width, "840px");
  rect = { left: 10, top: 30, bottom: 140, width: 1000 };
  layout.position(panel);
  assert.equal(panel.style.top, "148px", "上方空间不足时放在下方");
  assert.equal(panel.style.bottom, "auto");
  layout.context.window.innerWidth = 220;
  layout.context.window.innerHeight = 240;
  rect = { left: -40, top: 10, bottom: 230, width: 500 };
  layout.position(panel);
  assert.equal(panel.style.width, "204px", "窄窗口不强制最小宽度");
  assert.equal(panel.style.bottom, "8px", "长草稿场景保持操作区可见");
  assert.ok(parseFloat(panel.style.maxHeight) <= 224);
  layout.context.window.innerWidth = 1200;
  layout.context.window.innerHeight = 800;
  layout.context.codexPlusWindowZoom = () => 1.25;
  rect = { left: 100, top: 600, bottom: 760, width: 1000 };
  layout.position(panel);
  assert.equal(panel.style.zoom, "1.25");
  assert.equal(panel.style.width, "800px");
  assert.equal(panel.style.bottom, "168px", "缩放后仍保持同宽与边缘间距");
  Object.assign(layout.state, { phase: "questions", activeQuestion: 0, questions: [{ id: "only", options: [{ label: "A" }, { label: "B" }] }] });
  layout.keydown({ key: "ArrowRight", target: { closest: () => null }, preventDefault() {} });
  assert.equal(layout.requests.length, 0, "末题方向键不能隐式跳过并提交");
  layout.state.questions.push({ id: "second", options: [{ label: "A" }, { label: "B" }] });
  layout.keydown({ key: "ArrowRight", target: { closest: () => null }, preventDefault() {} });
  assert.equal(layout.state.activeQuestion, 1);
  assert.equal(Object.keys(layout.state.answers).length, 0, "翻页不能替用户决定答案");
  const multiQuestion = { id: "roles", title: "角色", question: "需要哪些角色？", multiSelect: true, options: [{ label: "管理员" }, { label: "读者" }], recommended: 1 };
  const queue = layout.mergeQuestions([], [multiQuestion, { ...multiQuestion, id: "scope", multiSelect: false }]);
  assert.equal(queue.questions[0].options[0].label, "读者", "推荐项始终排在第一位");
  Object.assign(layout.state, { phase: "questions", ...queue, history: [] });
  layout.pick("读者");
  layout.pick("管理员");
  assert.equal(layout.state.activeQuestion, 0, "多选确认之前保持当前题目");
  assert.deepEqual(JSON.parse(layout.state.answers.roles), ["读者", "管理员"]);
  layout.pick(layout.state.answers.roles, true);
  assert.equal(layout.state.activeQuestion, 1);
  const continued = layout.mergeQuestions([layout.round()], [{ ...multiQuestion, id: "rules" }]);
  assert.equal(continued.answers.roles, layout.state.answers.roles);
  assert.equal(continued.questions.length, 3, "补问保留累计问卷");
  const preferenceChange = fixture({ respond: () => ({ status: "ok", kind: "final", text: "具体方案" }) });
  await preferenceChange.start({});
  preferenceChange.context.codexPlusBackendSettings.promptEnhance.detail = "detailed";
  assert.equal(preferenceChange.guard(), false);
  assert.equal(preferenceChange.state.phase, "idle", "深度变化后关闭旧策略生成的流程");

  const read = fixture({ lines: ["第一行", "", "第三行"] });
  const firstRead = read.read(read.editor);
  assert.deepEqual({ text: firstRead.text, rich: firstRead.rich }, { text: "第一行\n\n第三行", rich: false });
  const rich = fixture({ extra: [{ type: { name: "mention" }, attrs: { label: "@App.tsx" } }] });
  assert.equal(rich.read(rich.editor).rich, true, "@file chips or attachments must block whole-draft replacement");

  // 确认替换：只发草稿、不碰输入框，确认时一次事务整段替换。
  const flow = fixture({ lines: ["修一下登录页"] });
  const pending = flow.start({});
  await flush();
  assert.equal(flow.requests[0].payload.prompt, "修一下登录页");
  assert.equal(flow.requests[0].path, "/prompt-enhance/generate");
  assert.equal(flow.state.phase, "loading");
  assert.equal(flow.editor.pmViewDesc.view.dispatched.length, 0, "the draft stays untouched while generating");
  flow.resolve({ status: "ok", text: "目标：修复登录页\n要求：保留现有样式" });
  await pending;
  assert.equal(flow.state.phase, "result");
  assert.equal(flow.blocker(), "");
  assert.equal(flow.apply("replace", flow.state.text), true);
  const view = flow.editor.pmViewDesc.view;
  assert.equal(view.dispatched.length, 1, "replacement is a single undoable transaction");
  assert.deepEqual(JSON.parse(JSON.stringify(view.dispatched[0].steps)), [["replaceWith", 0, 2]]);
  assert.equal(view.state.doc.textBetween(), "目标：修复登录页\n要求：保留现有样式");
  assert.equal(view.dispatched[0].selection.atEnd, true, "caret ends after the inserted prompt");
  assert.equal(flow.state.phase, "idle");

  // 取消：不写回，迟到的结果也不再生效。
  const cancel = fixture();
  const cancelled = cancel.start({});
  await flush();
  cancel.close();
  assert.equal(cancel.cancellations.length, 1);
  cancel.resolve({ status: "ok", text: "迟到的结果" });
  await cancelled;
  assert.equal(cancel.state.phase, "idle");
  assert.equal(cancel.editor.pmViewDesc.view.dispatched.length, 0, "cancel leaves the draft unchanged");

  // 生成期间用户改了草稿：锁定流程，拒绝整段替换，只允许追加。
  const edited = fixture({ lines: ["原稿"] });
  const editedPending = edited.start({});
  await flush();
  edited.editor.pmViewDesc.view.state.doc.blocks[0].children[0].text = "原稿加了一句";
  edited.resolve({ status: "ok", text: "增强稿" });
  await editedPending;
  assert.equal(edited.state.locked, true, "draft edits lock the open workflow");
  assert.match(edited.blocker(), /草稿改过了/);
  assert.equal(edited.apply("replace", "增强稿"), false);
  assert.equal(edited.editor.pmViewDesc.view.dispatched.length, 0);
  assert.equal(edited.apply("append", "增强稿"), true);
  assert.deepEqual(JSON.parse(JSON.stringify(edited.editor.pmViewDesc.view.dispatched[0].steps)), [["insert", 2]]);
  assert.equal(edited.editor.pmViewDesc.view.state.doc.textBetween(), "原稿加了一句\n增强稿");

  // 含 @文件 的草稿同样只能追加。
  const richFlow = fixture({ extra: [{ type: { name: "mention" }, attrs: { label: "@App.tsx" } }], respond: () => ({ status: "ok", text: "增强稿" }) });
  await richFlow.start({});
  assert.match(richFlow.blocker(), /@文件/);
  assert.equal(richFlow.apply("replace", "增强稿"), false);

  // 生成期间把同名文字转成 @文件引用：纯文本投影不变，但结构变了，必须拒绝整段替换。
  const converted = fixture({ lines: ["看看 @App.tsx"] });
  const convertedPending = converted.start({});
  await flush();
  converted.editor.pmViewDesc.view.state.doc.blocks[0].children = [
    { isText: true, type: { name: "text" }, text: "看看 " },
    { type: { name: "atMention" }, attrs: { label: "@App.tsx", path: "/repo/App.tsx" } },
  ];
  converted.resolve({ status: "ok", text: "增强稿" });
  await convertedPending;
  assert.equal(converted.read(converted.editor).text, "看看 @App.tsx", "the projected text is unchanged");
  assert.match(converted.blocker(), /@文件/);
  assert.equal(converted.apply("replace", "增强稿"), false);
  assert.equal(converted.editor.pmViewDesc.view.dispatched.length, 0, "a mention added during generation must survive");

  // 任何事务都会换成新文档；即使文字相同也视为改稿。
  const swapped = fixture({ lines: ["原稿"] });
  const swappedPending = swapped.start({});
  await flush();
  const swapView = swapped.editor.pmViewDesc.view;
  swapView.dispatch(swapView.state.tr.replaceWith(0, 2, [swapView.state.schema.nodes.paragraph.create(null, swapView.state.schema.text("原稿"))]));
  swapped.resolve({ status: "ok", text: "增强稿" });
  await swappedPending;
  assert.match(swapped.blocker(), /草稿改过了/);
  assert.equal(swapped.apply("replace", "增强稿"), false);

  // Codex 原生接口：以 Markdown 读写草稿，@文件 以链接形式保留，写回交给 Codex 解析并独立成撤销组。
  const native = fixture({ lines: ["ignored"], respond: () => ({ status: "ok", text: "增强稿 [@App.tsx](file:///repo/App.tsx/)" }) });
  vm.runInContext(`
    var nativeDraft = "看看 [@App.tsx](file:///repo/App.tsx/)", nativeCalls = [];
    var LB = new Map([[{ isConnected: true }, { composerId: "composer-1", hasText: () => nativeDraft.trim() !== "",
      updatePromptText: (fn, options) => { const next = fn(nativeDraft); nativeCalls.push({ next, options }); if (next != null) nativeDraft = next; return next == null ? null : {}; } }]]);
    function uHi(e,t,n){for(let[r,i]of LB)if(i.composerId===e&&r.isConnected&&i.updatePromptText!=null)return i.updatePromptText(e=>t(e,i.hasText?.()??e.trim()!==""),n),true;return false}
    function wHi(){let e=document.activeElement?.closest("[data-codex-composer-root]");return {composerId:"composer-1",root:{contains:()=>true}}}
    loadOptionalCodexAppModule = async () => ({ renamedUpdate: uHi, renamedContext: wHi });
  `, native.context);
  await native.start({});
  assert.equal(native.requests[0].payload.prompt, "看看 [@App.tsx](file:///repo/App.tsx/)", "mentions are sent as markdown links");
  assert.equal(native.blocker(), "");
  assert.equal(native.apply("replace", "增强稿 [@App.tsx](file:///repo/App.tsx/)"), true);
  assert.equal(native.context.nativeDraft, "增强稿 [@App.tsx](file:///repo/App.tsx/)");
  assert.equal(native.context.nativeCalls.filter(call => call.options).at(-1).options.isolateHistory, true, "replacement is its own undo step");
  assert.equal(native.editor.pmViewDesc.view.dispatched.length, 0, "native path does not touch ProseMirror directly");

  const nativeEdited = fixture({ respond: () => ({ status: "ok", text: "增强稿" }) });
  vm.runInContext(`
    var nativeDraft = "原稿";
    var LB = new Map([[{ isConnected: true }, { composerId: "c", hasText: () => true, updatePromptText: (fn) => { const next = fn(nativeDraft); if (next != null) nativeDraft = next; return {}; } }]]);
    function uHi(e,t,n){for(let[r,i]of LB)if(i.composerId===e&&r.isConnected&&i.updatePromptText!=null)return i.updatePromptText(e=>t(e,i.hasText?.()??e.trim()!==""),n),true;return false}
    function wHi(){let e=document.activeElement?.closest("[data-codex-composer-root]");return {composerId:"c",root:{contains:()=>true}}}
    loadOptionalCodexAppModule = async () => ({ uHi, wHi });
  `, nativeEdited.context);
  await nativeEdited.start({});
  nativeEdited.context.nativeDraft = "原稿 [@App.tsx](file:///repo/App.tsx/)";
  assert.match(nativeEdited.blocker(), /草稿改过了/);
  assert.equal(nativeEdited.apply("append", "增强稿"), true);
  assert.equal(nativeEdited.context.nativeDraft, "原稿 [@App.tsx](file:///repo/App.tsx/)\n\n增强稿", "append keeps existing references");

  // 切换会话后不能写进别的会话。
  const moved = fixture({ respond: () => ({ status: "ok", text: "增强稿" }) });
  await moved.start({});
  moved.context.window.location.href = "app://-/thread/two";
  assert.equal(moved.apply("append", "增强稿"), false);
  assert.equal(moved.editor.pmViewDesc.view.dispatched.length, 0);

  // 失败结果展示错误、不写回。
  const failure = fixture({ respond: () => ({ status: "failed", message: "提示词增强未配置 API Key" }) });
  await failure.start({});
  assert.equal(failure.state.phase, "error");
  assert.equal(failure.state.error, "提示词增强未配置 API Key");

  // 空草稿不发请求。
  const empty = fixture({ lines: ["  "] });
  await empty.start({});
  assert.equal(empty.requests.length, 0);
  assert.equal(empty.toasts.length, 1);

  // textarea 兼容路径：受控 setter + input 事件。
  const textarea = fixture({ editorKind: "textarea", lines: ["旧稿"], respond: () => ({ status: "ok", text: "新稿" }) });
  await textarea.start({});
  assert.equal(textarea.apply("replace", "新稿"), true);
  assert.equal(textarea.editor.value, "新稿");
  assert.deepEqual(textarea.events, ["input"]);
  assert.equal(textarea.write(textarea.editor, "补充", "append"), true);
  assert.equal(textarea.editor.value, "新稿\n\n补充");

  // 关闭开关后入口不可用。
  const disabled = fixture();
  disabled.context.codexPlusBackendSettings.promptEnhance.enabled = false;
  assert.equal(disabled.enabled(), false);
  await disabled.start({});
  assert.equal(disabled.requests.length, 0);
  disabled.context.codexPlusBackendSettings.promptEnhance.enabled = true;
  disabled.context.codexPlusBackendSettings.enhancementsEnabled = false;
  assert.equal(disabled.enabled(), false, "the master enhancement switch pauses prompt enhance");

  const question = (id = "goal") => ({ id, title: "目标", question: "覆盖哪些功能？",
    options: [{ label: "管理图书", description: "先完成图书增删改查" }, { label: "包含借阅", description: "同时处理借还流程" }], recommended: 0 });
  // 需求对齐允许空草稿，先问「你想做什么？」，用户填写后才请求。
  const intro = fixture({ lines: ["  "], respond: () => ({ status: "ok", kind: "questions", questions: [question()] }) });
  await intro.start({}, "grill");
  assert.equal(intro.state.phase, "idle");
  assert.equal(intro.requests.length, 0);
  assert.equal(intro.toasts.length, 1, "两种入口都要求草稿有内容");
  const grill = fixture({ respond: payload => payload.forceFinal ? { status: "ok", kind: "final", text: "最终提示词" }
    : { status: "ok", kind: "questions", questions: [question()] } });
  await grill.start({}, "grill");
  assert.equal(grill.state.phase, "questions");
  assert.equal(grill.state.history.length, 0);
  assert.equal(grill.round().answers.length, 0, "recommendations are not silently accepted");
  grill.state.answers.goal = "管理图书";
  await grill.request();
  assert.equal(grill.state.history.length, 1);
  assert.equal(grill.state.answers.goal, "管理图书", "同一决策补问时保留已填答案");
  grill.state.answers.goal = "图书管理和导出";
  await grill.request();
  assert.equal(grill.state.history.length, 1);
  assert.equal(grill.requests[2].payload.history[0].answers[0].answer, "图书管理和导出");
  grill.state.answers.goal = "包含借阅";
  await grill.request();
  assert.equal(grill.requests[3].payload.forceFinal, false);
  assert.equal(grill.requests[3].payload.history.length, 1, "累计问卷只发送一份当前答案快照");
  assert.equal(grill.state.phase, "questions");
  grill.state.answers.goal = "包含借阅";
  await grill.request({ forceFinal: true });
  assert.equal(grill.state.phase, "result");
  assert.equal(grill.state.text, "最终提示词");

  let failOnce = true;
  const retry = fixture({ respond: payload => payload.history?.length && failOnce
    ? (failOnce = false, { status: "failed", message: "超时" })
    : { status: "ok", kind: "questions", questions: [question()] } });
  await retry.start({}, "grill");
  retry.state.answers.goal = "已填写的答案";
  await retry.request();
  assert.equal(retry.state.phase, "error");
  assert.equal(retry.state.answers.goal, "已填写的答案");
  await retry.request({ retry: true });
  assert.deepEqual(JSON.parse(JSON.stringify(retry.requests[1].payload)), JSON.parse(JSON.stringify(retry.requests[2].payload)));
  assert.equal(retry.state.history.length, 1, "retry does not append the round twice");

  const direct = fixture({ respond: payload => payload.forceFinal ? { status: "ok", text: "直接结果" }
    : { status: "ok", kind: "questions", questions: [question("one"), question("two")] } });
  await direct.start({}, "grill");
  direct.state.answers.one = "包含借阅";
  await direct.request({ forceFinal: true });
  assert.equal(direct.state.phase, "result");
  assert.equal(direct.requests[1].payload.history[0].answers.length, 1, "direct generation uses only confirmed answers");

  const changed = fixture();
  const changing = changed.start({}, "grill");
  await flush();
  changed.editor.pmViewDesc.view.state.doc.blocks[0].children[0].text = "新草稿";
  changed.resolve({ status: "ok", kind: "questions", questions: [question()] });
  await changing;
  assert.equal(changed.state.locked, true);
  const changeRevision = changed.state.revision;
  await changed.request({ forceFinal: true });
  assert.equal(changed.requests.length, 1, "changed drafts pause the old interview");
  assert.ok(changed.state.revision >= changeRevision);
  changed.close();
  changed.forget();
  const restarted = changed.start({}, "grill");
  await flush();
  assert.equal(changed.requests[1].payload.prompt, "新草稿");
  assert.equal(changed.requests[1].payload.history.length, 0);
  changed.resolve({ status: "ok", text: "结果" });
  await restarted;

  const late = fixture();
  const lateRun = late.start({}, "grill");
  await flush();
  late.context.window.location.href = "app://-/thread/another";
  late.resolve({ status: "ok", kind: "questions", questions: [question()] });
  await lateRun;
  assert.equal(late.state.phase, "idle");
  assert.equal(late.state.questions.length, 0);

  const superseded = fixture();
  const supersededStart = superseded.start({}, "grill");
  await flush();
  const oldResponse = superseded.responseResolvers[0];
  // 直接生成在旧请求返回前递增 revision，只采用最后一次请求。
  const directWhileLoading = superseded.request({ forceFinal: true });
  await flush();
  assert.equal(superseded.requests[1].payload.forceFinal, true);
  superseded.resolve({ status: "ok", text: "直接生成结果" });
  await directWhileLoading;
  oldResponse({ status: "ok", kind: "questions", questions: [question()] });
  await supersededStart;
  assert.equal(superseded.state.text, "直接生成结果");
  assert.equal(superseded.state.phase, "result");
  assert.equal(superseded.state.history.length, 0);

  const specialId = fixture({ respond: () => ({ status: "ok", kind: "questions", questions: [question("__proto__")] }) });
  await specialId.start({}, "grill");
  assert.equal(specialId.round().answers.length, 0);
  specialId.state.answers["__proto__"] = "包含借阅";
  assert.equal(specialId.round().answers[0].answer, "包含借阅");

  const withContext = fixture({ respond: () => ({ status: "ok", text: "结果", context: { enabled: true, sections: [] } }) });
  withContext.context.codexPlusBackendSettings.promptEnhance.context = { enabled: true, project: true };
  withContext.editor.__reactFiber$test = { memoizedProps: { conversationId: "thread-one", hostId: "local", cwd: "/workspace/project" },
    memoizedState: { memoizedState: { current: { get() {}, value: { routeKind: "local-thread", conversationId: "thread-one", hostId: "local" } } } } };
  await withContext.start({});
  assert.equal(withContext.requests[0].payload.workingDirectory, "/workspace/project");
  assert.equal(withContext.requests[0].payload.sessionId, "thread-one");
  assert.equal(withContext.requests[0].payload.hostId, "local");
  withContext.editor.__reactFiber$test.memoizedProps.cwd = "/workspace/different";
  assert.equal(withContext.apply("append", "结果"), false, "same-URL project changes cannot receive an old result");

  const remote = fixture({ respond: () => ({ status: "ok", text: "结果" }) });
  remote.context.codexPlusBackendSettings.promptEnhance.context = { enabled: true, project: true };
  remote.editor.__reactFiber$test = { memoizedProps: { conversationId: "remote", hostId: "ssh:test", cwd: "/workspace/private" },
    memoizedState: { memoizedState: { current: { get() {}, value: { routeKind: "local-thread", conversationId: "remote", hostId: "ssh:test" } } } } };
  await remote.start({});
  assert.equal(remote.requests[0].payload.workingDirectory, "");
  assert.match(remote.state.project.reason, /远程/);

  const blank = fixture();
  blank.editor.__reactFiber$test = { memoizedProps: { composerId: "composer-new", hostId: "local", cwd: "/workspace/new-project" } };
  assert.equal(blank.location(blank.editor, "composer-new").workingDirectory, "/workspace/new-project");
  assert.equal(blank.location(blank.editor, "unrelated").workingDirectory, undefined);

  const home = fixture();
  home.editor.__reactFiber$test = { memoizedState: { memoizedState: { current: { get() {}, value: {
    routeKind: "home", projectContext: { hostId: "local", projectId: "/workspace/home-project" },
  } } } } };
  assert.equal(home.location(home.editor).workingDirectory, "/workspace/home-project");
  home.editor.__reactFiber$test.memoizedState.memoizedState.current.value.projectContext.projectId = "project-opaque-id";
  assert.equal(home.location(home.editor).workingDirectory, undefined, "opaque project IDs cannot become filesystem paths");

  const metadata = fixture();
  metadata.context.codexPlusBackendSettings.promptEnhance.context = { enabled: true, project: true };
  metadata.editor.__reactFiber$test = { memoizedProps: { conversationId: "thread-one", hostId: "local" },
    memoizedState: { memoizedState: { current: { get() {}, value: { routeKind: "local-thread", conversationId: "thread-one", hostId: "local" } } } } };
  const metaCalls = [];
  metadata.context.nativeHostClient = host => ({ sendRequest: async (method, params) => {
    metaCalls.push({ host, method, params }); return { thread: { id: "thread-one", cwd: "/workspace/metadata" } };
  } });
  const project = await metadata.project({ editor: metadata.editor, href: metadata.context.window.location.href });
  assert.equal(project.workingDirectory, "/workspace/metadata");
  assert.equal(metaCalls[0].params.includeTurns, false);
  assert.equal(metaCalls[0].host, "local");

  const switches = fixture({ respond: () => ({ status: "ok", text: "结果" }) });
  switches.context.codexPlusBackendSettings.promptEnhance.rewriteEnabled = false;
  await switches.start({});
  assert.equal(switches.state.mode, "grill", "disabled defaults fall back to the available mode");
  assert.equal(switches.requests[0].payload.mode, "grill");
  switches.context.codexPlusBackendSettings.promptEnhance.grillEnabled = false;
  assert.equal(switches.enabled(), false);
  await switches.request(); assert.equal(switches.requests.length, 1);

  const scene = fixture({ respond: () => ({ status: "ok", text: "结果", metadata: { mode: "grill", scenario: "general", model: "test", systemPrompt: "规则" } }) });
  await scene.start({}, "grill");
  scene.state.history = [{ questions: [question()], answers: [{ questionId: "goal", answer: "答案" }] }];
  scene.state.text = "编辑过的结果";
  await scene.request({ forceFinal: true, rounds: scene.state.history });
  assert.equal(scene.requests[1].payload.scenario, "general", "场景已从界面下线，固定使用通用规则");
  assert.equal(scene.requests[1].payload.history.length, 1);
  assert.equal(scene.requests[1].payload.forceFinal, true);

  const favorites = fixture({ lines: ["草稿"], respond: () => ({ status: "ok" }) });
  favorites.library.target = { editor: favorites.editor, href: favorites.context.window.location.href, original: "草稿", rich: false, doc: favorites.editor.pmViewDesc.view.state.doc };
  const item = { id: "saved", body: "收藏正文" };
  let copied = "";
  favorites.context.navigator.clipboard = { writeText: async text => { copied = text; } };
  await favorites.useFavorite(item, "copy");
  assert.equal(copied, "收藏正文");
  assert.equal(favorites.requests.length, 0, "复制不算使用，不更新时间也不写输入框");
  favorites.editor.pmViewDesc.view.state.doc.blocks[0].children[0].text = "新草稿";
  await favorites.useFavorite(item, "replace");
  assert.equal(favorites.editor.pmViewDesc.view.dispatched.length, 0, "favorites cannot replace changed drafts");
  assert.equal(favorites.requests.length, 0, "rejected writes do not count as recent use");
  favorites.context.window.location.href = "app://-/thread/other";
  await favorites.useFavorite(item, "append");
  assert.equal(favorites.editor.pmViewDesc.view.dispatched.length, 0, "favorites cannot append to another session");

  assert.equal(source.includes('action === "feedback"'), false);
  const resumed = fixture({ respond: () => ({ status: "ok", text: "生成结果" }) });
  await resumed.start({});
  resumed.state.text = "编辑结果"; resumed.close();
  await resumed.start({});
  assert.equal(resumed.state.text, "编辑结果");
  assert.equal(resumed.requests.length, 1, "reopening does not generate again");

  const improved = fixture();
  const initial = improved.start({});
  await flush(); improved.resolve({ status: "ok", text: "图书管理与借还" }); await initial;
  improved.state.text = "图书管理与借还，手动加了 ISBN 搜索";
  const edit = improved.request({ forceFinal: true, supplementOnly: true, addition: "只管理个人藏书，加 CSV 导出" });
  await flush();
  await improved.request({ addition: "重复点击" });
  assert.equal(improved.requests.length, 2, "生成中不能重复提交");
  const payload = improved.requests[1].payload;
  assert.equal(payload.currentText, "图书管理与借还，手动加了 ISBN 搜索");
  assert.equal(payload.messages.at(-1).text, "只管理个人藏书，加 CSV 导出");
  assert.equal(payload.messages.at(-2).text, payload.currentText);
  improved.resolve({ status: "ok", text: "个人藏书与 ISBN 搜索，CSV 导出" }); await edit;
  assert.equal(improved.state.text, "个人藏书与 ISBN 搜索，CSV 导出");
  assert.equal(improved.editor.pmViewDesc.view.dispatched.length, 0, "改进只更新结果，不自动写回草稿");
  const failedEdit = improved.request({ addition: "支持标签" });
  await flush(); improved.resolve({ status: "failed", message: "网络失败" }); await failedEdit;
  assert.equal(improved.state.phase, "result", "改进失败仍显示可编辑的旧结果");
  assert.equal(improved.state.supplement, "支持标签");
  const retryEdit = improved.request({ retry: true });
  await flush();
  assert.equal(improved.requests.at(-1).payload.messages.at(-1).text, "支持标签");
  assert.equal(improved.requests.at(-1).payload.messages.filter(m => m.text === "支持标签").length, 1);
  improved.resolve({ status: "ok", text: "个人藏书与 ISBN 搜索，CSV 导出" }); await retryEdit;
  assert.match(improved.state.error, /模型未改动/);
  assert.equal(improved.state.supplement, "支持标签", "无改动时保留本轮要求供调整");

  // DOM 替身只提供节点和事件，运行生产渲染函数与提交处理器。
  class Element {
    constructor(tag = "div") { this.tag = tag; this.dataset = {}; this.style = {}; this.children = []; this.events = {}; this.attributes = {}; this.disabled = false; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
    remove() { if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1); this.parentElement = null; }
    replaceChildren(...nodes) { for (const node of [...this.children]) node.remove(); this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = value; }
    appendChild(node) { this.append(node); }
    addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
    emit(name, props = {}) {
      const event = { target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...props };
      for (const fn of this.events[name] || []) fn(event);
      return event;
    }
    get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
    after(node) { const parent = this.parentElement; node.remove(); node.parentElement = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    matches(selector) {
      return selector.split(", ").some(part => {
        if (part.startsWith(".")) return (this.className || "").split(" ").includes(part.slice(1));
        if (part.startsWith("[data-")) {
          const match = part.match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/);
          const key = match?.[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          return key && key in this.dataset && (match[2] === undefined || this.dataset[key] === match[2]);
        }
        return this.tag === part;
      });
    }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const dom = fixture({ editorKind: "textarea", lines: ["图书管理"] });
  dom.context.document.createElement = tag => new Element(tag);
  dom.context.codexPlusPromptIcon = () => new Element("svg");
  const card = new Element();
  dom.context.codexPlusPromptEnhancePanel = () => card;
  dom.context.positionCodexPlusPromptCard = () => {};
  dom.context.codexPlusPromptEnhanceContextCaption = () => null;
  dom.context.renderCodexPlusPromptEnhance = dom.render;
  const domStart = dom.start({});
  await flush(); dom.resolve({ status: "ok", text: "图书借阅" }); await domStart;
  let follow = card.querySelector(".codex-plus-prompt-follow");
  let submit = card.querySelector(".codex-plus-prompt-follow-row").children[1];
  assert.equal(submit.disabled, true);
  follow.value = "增加导出"; follow.emit("input");
  assert.equal(submit.disabled, false);
  follow.emit("keydown", { key: "Enter", isComposing: true });
  assert.equal(dom.requests.length, 1, "中文选字回车不能提交");
  submit.emit("click"); await flush();
  assert.equal(dom.requests[1].payload.messages.at(-1).text, "增加导出");
  dom.resolve({ status: "ok", text: "图书借阅和导出" }); await flush();
  assert.equal(card.querySelector("textarea").value, "图书借阅和导出");
  follow = card.querySelector(".codex-plus-prompt-follow");
  follow.value = "去掉借阅"; follow.emit("input");
  const enter = follow.emit("keydown", { key: "Enter" }); await flush();
  assert.equal(enter.stopped, true, "回车不能传到宿主发送处理器");
  assert.equal(dom.requests[2].payload.currentText, "图书借阅和导出");
  dom.resolve({ status: "ok", text: "藏书管理和导出" }); await flush();
  assert.equal(card.querySelector("textarea").value, "藏书管理和导出");

  const trigger = new Element("button");
  dom.editor.value = " \n "; dom.updateTrigger(trigger, {});
  assert.equal(trigger.disabled, true, "纯空白草稿禁用入口");
  dom.editor.value = "图书"; dom.updateTrigger(trigger, {});
  assert.equal(trigger.disabled, false);

  const footer = new Element();
  const toolbar = new Element(); toolbar.className = "flex";
  const wrapper = new Element();
  const permissions = new Element("button"); permissions.dataset.composerNavigationTarget = "permissions";
  wrapper.append(permissions); toolbar.append(wrapper); footer.append(toolbar);
  const group = dom.toolsHost(footer);
  const favorite = new Element("button"); group.append(favorite, trigger);
  assert.equal(wrapper.nextElementSibling, group);
  toolbar.append(wrapper);
  assert.equal(dom.toolsHost(footer), group);
  assert.equal(wrapper.nextElementSibling, group, "权限入口被挪动后恢复相邻位置");
  const replacement = new Element(); replacement.className = "flex";
  replacement.append(wrapper); footer.append(replacement);
  for (let i = 0; i < 5; i++) dom.toolsHost(footer);
  assert.equal(group.parentElement, replacement, "布局重建后复用原工具组");
  assert.equal(footer.querySelectorAll("[data-prompt-tools]").length, 1);
  assert.deepEqual(group.children, [favorite, trigger]);
  const toggle = dom.context.createCodexPlusPromptEnhanceTrigger();
  toggle.emit("pointerdown");
  toggle.emit("click", { stopPropagation() {} });
  assert.equal(dom.state.phase, "idle", "再次点击增强入口关闭当前卡片");

  console.log("prompt enhance read, preview, replace, append, cancel and stale-draft contracts passed");
})().catch(error => { console.error(error); process.exit(1); });
