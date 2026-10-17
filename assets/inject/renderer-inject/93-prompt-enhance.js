  // 提示词增强：把输入框草稿交给后端模型改写，预览确认后才写回；取消时输入框保持原样。
  // 输入框定位与 footer 选择复用 93-dictation，两个入口挂在同一个 composer footer 上。
  window.__codexPlusPromptEnhanceRuntime?.dispose?.();
  const codexPlusPromptEnhance = {
    phase: "idle", revision: 0, target: null, text: "", error: "", nativeApiPromise: null,
    mode: "rewrite", history: [], questions: [], answers: Object.create(null), activeQuestion: 0,
    lastRequest: null, context: null, project: null, scenario: "general", generated: "", metadata: null, feedbackBusy: false,
  };
  registerCodexPlusExtensionSelector('[data-codex-plus-ext="builtin-prompt-enhance"]');

  function codexPlusPromptEnhanceEnabled() {
    return codexPlusBackendSettingsLoaded && codexPlusBackendSettings.enhancementsEnabled !== false
      && codexPlusBackendSettings.promptEnhance?.enabled === true
      && codexPlusPromptEnhanceModes().length > 0;
  }

  function codexPlusPromptEnhanceModes() {
    const config = codexPlusBackendSettings.promptEnhance || {};
    return ["rewrite", "grill"].filter((mode) => config[`${mode}Enabled`] !== false);
  }

  async function captureCodexPlusPromptTarget(footer) {
    const scope = codexPlusDictationScope(footer);
    const editor = scope && codexPlusDictationEditor(scope);
    if (!editor) return null;
    const href = window.location.href;
    const nativeApi = await loadCodexPlusPromptEnhanceNativeApi();
    if (!editor.isConnected || window.location.href !== href) return null;
    editor.focus();
    let native = null;
    try {
      const context = nativeApi?.context();
      if (context?.composerId && context.root?.contains(editor)) native = { api: nativeApi, composerId: context.composerId };
    } catch {}
    let draft = native ? codexPlusPromptEnhanceRead(editor, native) : null;
    if (!draft) { native = null; draft = codexPlusPromptEnhanceRead(editor); }
    const target = { editor, href, original: draft.text, rich: draft.rich, doc: draft.doc, native, footer };
    if (typeof codexPlusPromptEnhanceLocation === "function") target.location = codexPlusPromptEnhanceLocation(editor, native?.composerId);
    return target;
  }

  function codexPlusPromptEnhanceLeafText(node) {
    const name = node.type?.name || "";
    if (name === "hard_break" || name === "hardBreak") return "\n";
    const attrs = node.attrs || {};
    return String(attrs.label || attrs.name || attrs.path || attrs.text || "");
  }

  // 直接改 ProseMirror 时，只有段落、换行和纯文本才能整段替换；@文件、技能、附件这类节点会被一起换掉。
  function codexPlusPromptEnhanceRich(view) {
    let rich = false;
    view.state.doc.descendants((node) => {
      if (rich) return false;
      if (node.isText || ["paragraph", "hard_break", "hardBreak"].includes(node.type?.name)) return true;
      rich = true;
      return false;
    });
    return rich;
  }

  // 优先用 Codex 输入框登记的 updatePromptText：它按 Markdown 读写草稿，@文件、技能引用以链接形式往返，不会丢。
  // 压缩后的导出名每个版本都会变，只按函数源码里的特征识别。
  function loadCodexPlusPromptEnhanceNativeApi() {
    if (codexPlusPromptEnhance.nativeApiPromise) return codexPlusPromptEnhance.nativeApiPromise;
    codexPlusPromptEnhance.nativeApiPromise = loadOptionalCodexAppModule("app-initial-").then((module) => {
      const sources = Object.values(module || {}).flatMap((fn) => {
        if (typeof fn !== "function") return [];
        try {
          const source = Function.prototype.toString.call(fn);
          return source.length < 3000 ? [{ fn, source }] : [];
        } catch { return []; }
      });
      const update = sources.find(({ source }) => source.includes(".updatePromptText!=null") && source.includes(".updatePromptText(")
        && source.includes(".composerId===") && source.includes(".hasText") && !source.includes("occupied"))?.fn;
      const context = sources.find(({ source }) => source.includes("document.activeElement?.closest")
        && source.includes("[data-codex-composer-root]") && source.includes("composerId:") && source.includes("root:"))?.fn;
      return update && context ? { update, context } : null;
    }).catch(() => null);
    return codexPlusPromptEnhance.nativeApiPromise;
  }

  function codexPlusPromptEnhanceNativeText(native) {
    let text = null;
    try {
      // 回调返回 null 时 Codex 不改草稿，只借它拿到序列化后的全文。
      if (native.api.update(native.composerId, (current) => { text = String(current ?? ""); return null; }) !== true) return null;
    } catch {
      return null;
    }
    return text;
  }

  function codexPlusPromptEnhanceRead(editor, native = null) {
    if (native) {
      const text = codexPlusPromptEnhanceNativeText(native);
      return text == null ? null : { text, rich: false };
    }
    const view = codexPlusDictationView(editor);
    if (view) {
      const { doc } = view.state;
      return { text: doc.textBetween(0, doc.content.size, "\n", codexPlusPromptEnhanceLeafText), rich: codexPlusPromptEnhanceRich(view), doc };
    }
    if (editor instanceof HTMLTextAreaElement) return { text: editor.value, rich: false };
    // 认不出结构的编辑器不做整段替换，只允许插入到末尾和复制。
    return { text: editor.innerText || editor.textContent || "", rich: true, opaque: true };
  }

  function codexPlusPromptEnhanceParagraphs(schema, text) {
    const paragraph = schema?.nodes?.paragraph;
    if (!paragraph || typeof schema.text !== "function") return null;
    return text.split("\n").map((line) => paragraph.create(null, line ? schema.text(line) : null));
  }

  // replace 覆盖整段草稿，append 追加到末尾。每次写回只占一个撤销步骤：原生接口靠 isolateHistory，ProseMirror 靠单个事务。
  function codexPlusPromptEnhanceWrite(editor, text, mode, native = null) {
    const value = String(text || "").replace(/\r\n?/g, "\n").trim();
    if (!value || !editor?.isConnected || editor.matches?.(':disabled, [readonly], [contenteditable="false"]')
        || editor.closest?.('[inert], [aria-hidden="true"]')) return false;
    editor.focus();
    if (native) {
      const next = (current) => {
        const kept = String(current ?? "").replace(/\s+$/, "");
        return mode === "replace" ? value : `${kept}${kept ? "\n\n" : ""}${value}`;
      };
      try {
        return native.api.update(native.composerId, next, { isolateHistory: true }) === true;
      } catch {
        return false;
      }
    }
    const view = codexPlusDictationView(editor);
    if (view) {
      const { state } = view;
      const end = state.doc.content.size;
      const SelectionType = state.selection?.constructor;
      const atEnd = (doc) => typeof SelectionType?.atEnd === "function" ? SelectionType.atEnd(doc) : null;
      const nodes = codexPlusPromptEnhanceParagraphs(state.schema, value);
      let tr = state.tr;
      if (nodes) tr = mode === "replace" ? tr.replaceWith(0, end, nodes) : tr.insert(end, nodes);
      else if (mode === "replace") tr = tr.insertText(value, 0, end);
      else {
        const position = atEnd(state.doc)?.from ?? end;
        tr = tr.insertText(`\n${value}`, position, position);
      }
      const selection = atEnd(tr.doc);
      if (selection) tr = tr.setSelection(selection);
      view.dispatch(tr.scrollIntoView());
      return true;
    }
    if (editor instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (!setter) return false;
      const current = editor.value.replace(/\s+$/, "");
      const next = mode === "replace" ? value : `${current}${current ? "\n\n" : ""}${value}`;
      setter.call(editor, next);
      editor.setSelectionRange(next.length, next.length);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
    if (mode === "replace") return false;
    const selection = window.getSelection?.();
    if (!selection || typeof document.createRange !== "function") return false;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return document.execCommand("insertText", false, `\n\n${value}`) === true;
  }

  function codexPlusPromptEnhanceTargetAlive(target = codexPlusPromptEnhance.target) {
    if (!target?.editor?.isConnected || window.location.href !== target.href) return false;
    if (target.location && typeof codexPlusPromptEnhanceLocation === "function") {
      const current = codexPlusPromptEnhanceLocation(target.editor, target.native?.composerId);
      for (const key of ["sessionId", "hostId", "workingDirectory"]) {
        if (target.location[key] && current[key] !== target.location[key]) return false;
      }
    }
    return true;
  }

  // 返回不能整段替换的原因，空串表示可以替换。
  // 每次都重新读当前草稿：生成期间文字可能被转成同名的 @文件引用，读出来的文字没变，结构已经变了。
  function codexPlusPromptEnhanceReplaceBlocker(target = codexPlusPromptEnhance.target) {
    if (!codexPlusPromptEnhanceTargetAlive(target)) return "输入框或会话已变化，请复制结果后手动粘贴";
    const current = codexPlusPromptEnhanceRead(target.editor, target.native);
    if (!current) return "输入框或会话已变化，请复制结果后手动粘贴";
    if (current.opaque) return "这个输入框不支持整段替换，可以插入到末尾或复制";
    if (target.rich || current.rich) return "草稿里有 @文件、技能或附件，整段替换会丢掉它们，可以插入到末尾或复制";
    // ProseMirror 的 doc 不可变，有过任何事务就是新对象。原生路径没有 doc，引用变化已体现在 Markdown 文本里。
    if (current.text !== target.original || current.doc !== target.doc) return "生成期间草稿改过了，整段替换会覆盖这些改动，可以插入到末尾或复制";
    return "";
  }

  function codexPlusPromptEnhanceDraftChanged() {
    const target = codexPlusPromptEnhance.target;
    if (!target) return false;
    const current = codexPlusPromptEnhanceRead(target.editor, target.native);
    return !current || current.text !== target.original || current.doc !== target.doc || current.rich !== target.rich;
  }

  function guardCodexPlusPromptEnhance() {
    const state = codexPlusPromptEnhance;
    if (!state.target || state.phase === "idle") return false;
    if (!codexPlusPromptEnhanceEnabled() || !codexPlusPromptEnhanceModes().includes(state.mode)) {
      closeCodexPlusPromptEnhance(); return false;
    }
    if (!codexPlusPromptEnhanceTargetAlive()) {
      ++state.revision;
      Object.assign(state, { phase: "stale", error: "输入框或会话已变化，请在当前会话重新开始" });
      renderCodexPlusPromptEnhance();
      return false;
    }
    if (state.mode === "grill" && state.phase !== "result" && codexPlusPromptEnhanceDraftChanged()) {
      ++state.revision;
      Object.assign(state, { phase: "stale", error: "草稿已变化，请重新开始追问" });
      renderCodexPlusPromptEnhance();
      return false;
    }
    return true;
  }

  function codexPlusPromptEnhanceRound() {
    const state = codexPlusPromptEnhance;
    return { questions: state.questions, answers: state.questions.flatMap((question) => {
      const value = state.answers[question.id];
      const answer = value?.custom ? value.text?.trim() : question.options[value?.selected]?.label;
      return answer ? [{ questionId: question.id, answer }] : [];
    }) };
  }

  async function requestCodexPlusPromptEnhance(options = {}) {
    const state = codexPlusPromptEnhance;
    const target = state.target;
    if (!target || !guardCodexPlusPromptEnhance()) return;
    if (!codexPlusPromptEnhanceEnabled() || !codexPlusPromptEnhanceModes().includes(state.mode)) {
      showToast("本次增强模式已关闭", null); return;
    }
    if (options.regenerate) {
      const hasAnswers = state.history.length > 0 || Object.keys(state.answers).length > 0;
      if ((state.text !== state.generated || hasAnswers)
          && !window.confirm(hasAnswers ? "重新生成会替换预览内容，并清空已有追问答案。继续？" : "重新生成会替换已编辑的预览内容。继续？")) return;
      Object.assign(state, { history: [], questions: [], answers: Object.create(null) });
      if (state.mode === "grill") options.forceFinal = false;
    }
    let payload;
    if (options.retry && state.lastRequest) {
      payload = { ...state.lastRequest };
      if (state.mode === "grill" && state.questions.length) payload.history = [...state.history, codexPlusPromptEnhanceRound()];
    }
    else {
      const history = state.phase === "loading" && state.lastRequest ? state.lastRequest.history || state.history : state.history;
      const round = state.questions.length && state.phase !== "loading" ? codexPlusPromptEnhanceRound() : null;
      if (!options.forceFinal && round && round.answers.length !== round.questions.length) {
        showToast("请回答本轮问题，或点直接生成", null); return;
      }
      const nextHistory = round ? [...history, round] : history;
      payload = { prompt: target.original };
      const scenario = options.regenerate ? state.scenario : state.lastRequest?.scenario || (state.lastRequest ? "general" : state.scenario);
      if (scenario !== "general") payload.scenario = scenario;
      if (state.mode === "grill") Object.assign(payload, { mode: "grill", history: nextHistory, forceFinal: !!options.forceFinal || nextHistory.length >= 3 });
    }
    const revision = ++state.revision;
    Object.assign(state, { phase: "loading", text: "", error: "", lastRequest: payload });
    renderCodexPlusPromptEnhance();
    let result;
    try {
      if (codexPlusBackendSettings.promptEnhance?.context?.enabled && !options.retry) {
        // 元数据读取同样受本轮 revision 保护；取消后不会继续请求模型。
        let timeout;
        const project = await Promise.race([
          codexPlusPromptEnhanceProject(target),
          new Promise((resolve) => { timeout = setTimeout(() => resolve({ reason: "读取项目目录超时，已跳过上下文" }), 2500); }),
        ]).finally(() => clearTimeout(timeout));
        if (revision !== state.revision || !guardCodexPlusPromptEnhance()) return;
        state.project = project;
        if (state.project) Object.assign(payload, {
          workingDirectory: state.project.reason ? "" : state.project.workingDirectory || "",
          sessionId: state.project.sessionId || "", hostId: state.project.hostId || "",
        });
      }
      // app:// 的 CSP 不允许直接请求模型服务，经特权桥接交给 Rust，API Key 不进页面。
      result = await postJson("/prompt-enhance/generate", payload);
    } catch (error) {
      result = { status: "failed", message: error?.message };
    }
    if (revision !== state.revision || !guardCodexPlusPromptEnhance()) return;
    state.context = result?.context || null;
    if (result?.status === "ok") state.metadata = result.metadata || null;
    if (result?.status === "ok" && result.kind === "questions" && Array.isArray(result.questions) && result.questions.length) {
      Object.assign(state, { phase: "questions", history: payload.history || [], questions: result.questions, answers: Object.create(null), activeQuestion: 0 });
    } else {
      const text = result?.status === "ok" && typeof result.text === "string" ? result.text.trim() : "";
      if (text) Object.assign(state, { phase: "result", text, generated: text, metadata: result.metadata || null, history: payload.history || [] , questions: [], answers: Object.create(null) });
      else Object.assign(state, { phase: "error", error: result?.message || "提示词增强失败" });
    }
    renderCodexPlusPromptEnhance();
    if (state.phase === "questions") requestAnimationFrame(() => {
      if (state.revision === revision && state.phase === "questions") document.getElementById("prompt-enhance-tab-0")?.focus();
    });
  }

  async function startCodexPlusPromptEnhance(footer, mode = codexPlusBackendSettings.promptEnhance?.defaultMode || "rewrite") {
    const state = codexPlusPromptEnhance;
    if (!codexPlusPromptEnhanceEnabled() || state.phase === "loading") return;
    const modes = codexPlusPromptEnhanceModes();
    if (!modes.includes(mode)) mode = modes[0];
    const revision = ++state.revision;
    const target = await captureCodexPlusPromptTarget(footer);
    if (revision !== state.revision || !target) return;
    if (!target.original.trim()) { showToast("先在输入框写下需求，再点增强", null); return; }
    Object.assign(state, {
      target, mode, phase: "ready", history: [], questions: [], answers: Object.create(null), activeQuestion: 0,
      context: null, project: null, lastRequest: null, scenario: "general", generated: "", metadata: null,
    });
    await requestCodexPlusPromptEnhance();
  }

  function closeCodexPlusPromptEnhance() {
    ++codexPlusPromptEnhance.revision;
    const editor = codexPlusPromptEnhance.target?.editor;
    Object.assign(codexPlusPromptEnhance, { phase: "idle", target: null, text: "", error: "", history: [], questions: [], answers: Object.create(null), lastRequest: null, project: null, context: null });
    renderCodexPlusPromptEnhance();
    if (editor?.isConnected) editor.focus?.();
  }

  function applyCodexPlusPromptEnhance(mode, text) {
    if (codexPlusPromptEnhance.phase !== "result") return false;
    if (!String(text || "").trim()) { showToast("结果为空，没有可写入的内容", null); return false; }
    if (!codexPlusPromptEnhanceTargetAlive()) { showToast("输入框或会话已变化，请复制结果后手动粘贴", null); return false; }
    if (mode === "replace") {
      const blocker = codexPlusPromptEnhanceReplaceBlocker();
      if (blocker) { showToast(blocker, null); return false; }
    }
    const { editor, native } = codexPlusPromptEnhance.target;
    if (!codexPlusPromptEnhanceWrite(editor, text, mode, native)) {
      showToast("写入输入框失败，请复制结果后手动粘贴", null);
      return false;
    }
    closeCodexPlusPromptEnhance();
    return true;
  }

  function codexPlusPromptEnhanceButton(action, label, options = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.promptEnhanceAction = action;
    if (options.primary) button.className = "is-primary";
    if (options.disabled) button.disabled = true;
    if (options.title) button.title = options.title;
    return button;
  }

  function positionCodexPlusPromptEnhancePanel(panel) {
    const editor = codexPlusPromptEnhance.target?.editor;
    const anchor = editor?.isConnected ? editor.closest?.("[data-codex-composer-root], [data-composer-surface-variant], form") || editor : null;
    const rect = anchor?.getBoundingClientRect?.();
    const width = Math.min(Math.max(rect?.width || 480, 360), 560, window.innerWidth - 32);
    if (!rect?.width) {
      Object.assign(panel.style, { left: `${Math.max(16, window.innerWidth - width - 24)}px`, width: `${width}px`, top: "", bottom: "24px", maxHeight: "" });
      return;
    }
    const left = Math.min(Math.max(16, rect.left), Math.max(16, window.innerWidth - width - 16));
    const above = rect.top - 16;
    if (above >= 220) {
      Object.assign(panel.style, { left: `${left}px`, width: `${width}px`, top: "", bottom: `${window.innerHeight - rect.top + 8}px`, maxHeight: `${above}px` });
    } else {
      Object.assign(panel.style, { left: `${left}px`, width: `${width}px`, bottom: "", top: `${rect.bottom + 8}px`, maxHeight: `${Math.max(200, window.innerHeight - rect.bottom - 24)}px` });
    }
  }

  function codexPlusPromptEnhanceContextSummary() {
    const state = codexPlusPromptEnhance;
    if (!state.project && !state.context?.enabled) return null;
    const details = document.createElement("details");
    details.className = "codex-plus-prompt-enhance-context";
    const summary = document.createElement("summary");
    summary.textContent = "本次项目上下文";
    details.append(summary);
    if (state.project?.reason) {
      const row = document.createElement("div");
      row.textContent = state.project.reason;
      details.append(row);
    }
    const labels = { project: "项目名与分支", instructions: "项目说明", manifests: "主要清单", directory: "目录结构" };
    for (const section of state.context?.sections || []) {
      const row = document.createElement("div");
      const files = section.files?.length ? `：${section.files.join("、")}` : "";
      const skipped = section.skipped?.length ? ` · ${section.skipped.join("；")}` : "";
      row.textContent = `${labels[section.kind] || section.kind}${files}${section.truncated ? "（已截断）" : ""}${skipped}`;
      details.append(row);
    }
    if (!state.context && !state.project?.reason) {
      const row = document.createElement("div");
      row.textContent = "正在读取所选项目内容…";
      details.append(row);
    }
    return details;
  }

  function createCodexPlusPromptEnhanceQuestions() {
    const state = codexPlusPromptEnhance;
    const wrapper = document.createElement("div");
    wrapper.className = "codex-plus-prompt-enhance-questions";
    const tabs = document.createElement("div");
    tabs.className = "codex-plus-prompt-enhance-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "本轮问题");
    state.questions.forEach((question, index) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.id = `prompt-enhance-tab-${index}`;
      tab.textContent = `${index + 1}. ${question.title}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(index === state.activeQuestion));
      tab.setAttribute("aria-controls", "prompt-enhance-question");
      tab.tabIndex = index === state.activeQuestion ? 0 : -1;
      const activate = (next) => {
        state.activeQuestion = next;
        delete document.getElementById("codex-plus-prompt-enhance-panel").dataset.renderKey;
        renderCodexPlusPromptEnhance();
        document.getElementById(`prompt-enhance-tab-${next}`)?.focus();
      };
      tab.addEventListener("click", () => activate(index));
      tab.addEventListener("keydown", (event) => {
        let next = index;
        if (event.key === "ArrowRight") next = (index + 1) % state.questions.length;
        else if (event.key === "ArrowLeft") next = (index + state.questions.length - 1) % state.questions.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = state.questions.length - 1;
        else return;
        event.preventDefault(); event.stopPropagation(); activate(next);
      });
      tabs.append(tab);
    });
    wrapper.append(tabs);
    const question = state.questions[state.activeQuestion];
    if (!question) return wrapper;
    const pane = document.createElement("div");
    pane.id = "prompt-enhance-question";
    pane.setAttribute("role", "tabpanel");
    pane.setAttribute("aria-labelledby", `prompt-enhance-tab-${state.activeQuestion}`);
    const title = document.createElement("p");
    title.textContent = question.question;
    pane.append(title);
    const group = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.className = "codex-plus-prompt-enhance-answer-label";
    legend.textContent = "选择答案，或自行填写";
    group.append(legend);
    const answer = state.answers[question.id] || {};
    const customText = document.createElement("textarea");
    question.options.forEach((option, index) => {
      const label = document.createElement("label");
      label.className = "codex-plus-prompt-enhance-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = `prompt-enhance-answer-${state.activeQuestion}`;
      input.checked = !answer.custom && answer.selected === index;
      input.addEventListener("change", () => {
        state.answers[question.id] = { ...state.answers[question.id], selected: index, custom: false };
        customText.disabled = true;
      });
      const text = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = `${option.label}${index === question.recommended ? "（推荐）" : ""}`;
      text.append(strong);
      if (option.description) {
        const detail = document.createElement("small");
        detail.textContent = option.description;
        text.append(detail);
      }
      label.append(input, text);
      group.append(label);
    });
    const custom = document.createElement("label");
    custom.className = "codex-plus-prompt-enhance-option";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `prompt-enhance-answer-${state.activeQuestion}`;
    radio.checked = !!answer.custom;
    radio.addEventListener("change", () => {
      state.answers[question.id] = { ...state.answers[question.id], custom: true };
      customText.disabled = false;
      customText.focus();
    });
    const label = document.createElement("span");
    label.textContent = "自行填写";
    custom.append(radio, label);
    group.append(custom);
    customText.value = answer.text || "";
    customText.rows = 3;
    customText.maxLength = 3000;
    customText.disabled = !answer.custom;
    customText.setAttribute("aria-label", "自定义答案");
    customText.addEventListener("input", () => {
      state.answers[question.id] = { ...state.answers[question.id], custom: true, text: customText.value };
    });
    group.append(customText);
    pane.append(group);
    wrapper.append(pane);
    return wrapper;
  }

  function createCodexPlusPromptEnhancePanel() {
    const panel = document.createElement("div");
    panel.id = "codex-plus-prompt-enhance-panel";
    panel.dataset.runtime = "prompt-tools";
    panel.dataset.codexPlusExt = "builtin-prompt-enhance";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "提示词增强");
    panel.addEventListener("click", (event) => {
      const action = event.target.closest?.("[data-prompt-enhance-action]")?.dataset.promptEnhanceAction;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      const text = panel.querySelector("textarea")?.value ?? codexPlusPromptEnhance.text;
      if (action === "replace" || action === "append") applyCodexPlusPromptEnhance(action, text);
      else if (action === "retry") void requestCodexPlusPromptEnhance({ retry: true });
      else if (action === "regenerate") void requestCodexPlusPromptEnhance({ regenerate: true, forceFinal: true });
      else if (action === "favorite") void openCodexPlusPromptLibrary(codexPlusPromptEnhance.target?.footer, text);
      else if (action === "feedback") void saveCodexPlusPromptFeedback(panel);
      else if (action === "continue") void requestCodexPlusPromptEnhance();
      else if (action === "generate") void requestCodexPlusPromptEnhance({ forceFinal: true });
      else if (action === "restart") {
        const { target, mode } = codexPlusPromptEnhance;
        closeCodexPlusPromptEnhance();
        if (target?.footer?.isConnected) void startCodexPlusPromptEnhance(target.footer, mode);
        else showToast("请在当前输入框重新点击增强", null);
      }
      else if (action === "copy") {
        if (!navigator.clipboard?.writeText) { showToast("请选中结果手动复制", null); return; }
        void navigator.clipboard.writeText(text).then(() => showToast("已复制增强结果", null))
          .catch(() => showToast("复制失败，请选中结果手动复制", null));
      } else closeCodexPlusPromptEnhance();
    });
    panel.addEventListener("keydown", (event) => {
      if (codexPlusPromptEnhance.phase !== "result") return;
      if (event.key !== "Enter" || event.isComposing || !(event.ctrlKey || event.metaKey) || event.target?.tagName !== "TEXTAREA") return;
      event.preventDefault();
      event.stopPropagation();
      applyCodexPlusPromptEnhance(codexPlusPromptEnhanceReplaceBlocker() ? "append" : "replace", event.target.value);
    });
    return panel;
  }

  function renderCodexPlusPromptEnhance() {
    const state = codexPlusPromptEnhance;
    document.querySelectorAll("[data-prompt-enhance-trigger]").forEach((button) => {
      button.disabled = state.phase === "loading";
      button.setAttribute("aria-busy", String(state.phase === "loading"));
    });
    let panel = document.getElementById("codex-plus-prompt-enhance-panel");
    if (state.phase === "idle") { panel?.remove(); return; }
    if (!panel) { panel = createCodexPlusPromptEnhancePanel(); document.body.append(panel); }
    positionCodexPlusPromptEnhancePanel(panel);
    const key = `${state.revision}:${state.phase}`;
    if (panel.dataset.renderKey === key) return;
    panel.dataset.renderKey = key;
    const header = document.createElement("div");
    header.className = "codex-plus-prompt-enhance-header";
    const title = document.createElement("strong");
    title.append(codexPlusPromptEnhanceIcon(), state.mode === "grill" ? "追问" : "改写");
    const close = codexPlusPromptEnhanceButton("close", "×", { title: "取消（Esc）" });
    close.className = "codex-plus-prompt-enhance-close";
    close.setAttribute("aria-label", "取消");
    header.append(title, close);
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    const actions = document.createElement("div");
    actions.className = "codex-plus-prompt-enhance-actions";
    const children = [header, status];
    const scene = document.createElement("label");
    scene.textContent = "场景 ";
    const select = document.createElement("select");
    select.setAttribute("aria-label", "增强场景");
    for (const [value, label] of [["general", "通用"], ["feature", "新功能"], ["bugfix", "修 bug"], ["review", "代码审查"]]) {
      const option = document.createElement("option"); option.value = value; option.textContent = label; select.append(option);
    }
    select.value = state.scenario;
    select.disabled = state.phase === "loading";
    select.title = "切换后点重新生成";
    select.addEventListener("change", () => { state.scenario = select.value; });
    scene.append(select); children.push(scene);
    const context = codexPlusPromptEnhanceContextSummary();
    if (context) children.push(context);
    if (state.phase === "loading") {
      status.className = "is-loading";
      status.textContent = state.mode === "grill" ? (state.lastRequest?.forceFinal ? "正在生成提示词…" : "正在整理问题…") : "正在改写草稿…";
      const draft = document.createElement("div");
      draft.className = "codex-plus-prompt-enhance-draft";
      draft.textContent = state.target?.original || "";
      children.push(draft);
      actions.append(codexPlusPromptEnhanceButton("close", "取消"));
      if (state.mode === "grill" && !state.lastRequest?.forceFinal) actions.append(codexPlusPromptEnhanceButton("generate", "直接生成"));
    } else if (state.phase === "stale") {
      status.textContent = state.error;
      status.className = "is-warning";
      actions.append(codexPlusPromptEnhanceButton("close", "取消"), codexPlusPromptEnhanceButton("restart", "重新开始", { primary: true }));
    } else if (state.phase === "questions") {
      status.textContent = `第 ${state.history.length + 1}/3 轮 · 选择答案或自行填写`;
      actions.append(codexPlusPromptEnhanceButton("regenerate", "重新生成"));
      children.push(createCodexPlusPromptEnhanceQuestions());
      actions.append(codexPlusPromptEnhanceButton("close", "取消"), codexPlusPromptEnhanceButton("generate", "直接生成"),
        codexPlusPromptEnhanceButton("continue", state.history.length >= 2 ? "提交并生成" : "提交本轮", { primary: true }));
    } else if (state.phase === "error") {
      status.textContent = state.error;
      status.className = "is-error";
      actions.append(codexPlusPromptEnhanceButton("close", "关闭"), codexPlusPromptEnhanceButton("retry", "重试", { primary: true }));
      if (state.questions.length) {
        children.push(createCodexPlusPromptEnhanceQuestions());
        actions.append(codexPlusPromptEnhanceButton("generate", "直接生成"), codexPlusPromptEnhanceButton("continue", "提交本轮"));
      }
    } else {
      // 不能替换时直接不给替换按钮，原因写在状态行里，避免出现一个点不动的灰按钮。
      const blocker = codexPlusPromptEnhanceReplaceBlocker();
      status.textContent = blocker || "编辑后可替换或插入";
      if (blocker) status.className = "is-warning";
      const text = document.createElement("textarea");
      text.value = state.text;
      text.spellcheck = false;
      text.rows = Math.min(16, Math.max(4, state.text.split("\n").length + 1));
      text.setAttribute("aria-label", "增强后的提示词");
      text.addEventListener("input", () => { state.text = text.value; });
      children.push(text);
      const feedbackDetails = document.createElement("details");
      const feedbackSummary = document.createElement("summary"); feedbackSummary.textContent = "反馈";
      feedbackDetails.append(feedbackSummary);
      const feedback = document.createElement("div"); feedback.className = "codex-plus-prompt-feedback";
      const rating = document.createElement("select"); rating.dataset.promptFeedbackRating = "true"; rating.setAttribute("aria-label", "结果评价");
      for (const [value, label] of [["useful", "有用"], ["improve", "需改进"]]) { const option = document.createElement("option"); option.value = value; option.textContent = label; rating.append(option); }
      const note = document.createElement("input"); note.dataset.promptFeedbackNote = "true"; note.maxLength = 3000; note.placeholder = "反馈备注（可选）"; note.setAttribute("aria-label", "反馈备注");
      const save = codexPlusPromptEnhanceButton("feedback", "提交反馈"); save.disabled = state.feedbackBusy;
      feedback.append(rating, note, save); feedbackDetails.append(feedback); children.push(feedbackDetails);
      const hint = document.createElement("span");
      hint.className = "codex-plus-prompt-enhance-hint";
      hint.textContent = blocker ? "Ctrl+Enter 插入 · Esc 取消" : "Ctrl+Enter 替换 · Esc 取消";
      actions.append(
        hint,
        codexPlusPromptEnhanceButton("regenerate", "重新生成"),
        codexPlusPromptEnhanceButton("favorite", "收藏"),
        codexPlusPromptEnhanceButton("copy", "复制"),
        codexPlusPromptEnhanceButton("append", "插入到末尾", { primary: !!blocker }),
      );
      if (!blocker) actions.append(codexPlusPromptEnhanceButton("replace", "替换", { primary: true }));
      requestAnimationFrame(() => { if (text.isConnected) text.focus(); });
    }
    children.push(actions);
    panel.replaceChildren(...children);
  }

  function codexPlusPromptEnhanceIcon() {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "16"); svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.3"); svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    ["M6.5 2.5 7.6 5.9 11 7 7.6 8.1 6.5 11.5 5.4 8.1 2 7 5.4 5.9Z", "M12 9.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6Z"].forEach((d) => {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    });
    return svg;
  }

  function createCodexPlusPromptEnhanceTrigger() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "codex-plus-prompt-enhance-trigger";
    button.dataset.codexPlusExt = "builtin-prompt-enhance";
    button.dataset.promptEnhanceTrigger = "true";
    button.setAttribute("aria-label", "增强提示词");
    button.title = "提示词增强";
    button.append(codexPlusPromptEnhanceIcon());
    // 保住输入框焦点和选区，读取草稿时才是用户正在编辑的那个输入框。
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const footer = button.closest(".composer-footer, [data-composer-footer-responsive]");
      const existing = document.querySelector("[data-prompt-enhance-menu]");
      if (existing) { existing.remove(); return; }
      const menu = document.createElement("div");
      menu.dataset.promptEnhanceMenu = "true";
      menu.dataset.codexPlusExt = "builtin-prompt-enhance";
      menu.className = "codex-plus-prompt-enhance-mode-menu";
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "选择增强模式");
      const modes = codexPlusPromptEnhanceModes();
      if (modes.length === 1) { void startCodexPlusPromptEnhance(footer, modes[0]); return; }
      const defaultMode = codexPlusBackendSettings.promptEnhance?.defaultMode || "rewrite";
      modes.sort((a, b) => Number(b === defaultMode) - Number(a === defaultMode));
      for (const mode of modes) {
        const choice = codexPlusPromptEnhanceButton(mode, mode === "grill" ? "追问" : "改写");
        choice.setAttribute("role", "menuitem");
        choice.addEventListener("click", () => { menu.remove(); void startCodexPlusPromptEnhance(footer, mode); });
        menu.append(choice);
      }
      const rect = button.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 152))}px`;
      menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
      menu.addEventListener("keydown", (keyEvent) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(keyEvent.key)) return;
        keyEvent.preventDefault(); keyEvent.stopPropagation();
        const items = [...menu.querySelectorAll("button")];
        const index = items.indexOf(document.activeElement);
        const next = keyEvent.key === "Home" ? 0 : keyEvent.key === "End" ? items.length - 1
          : (index + (keyEvent.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      });
      document.body.append(menu);
      menu.querySelector("button")?.focus();
    });
    return button;
  }

  function codexPlusPromptToolsHost(footer) {
    const anchor = footer.querySelector('[data-composer-navigation-target="permissions"]')
      || footer.querySelector('[data-composer-navigation-target="add-context"]');
    const host = anchor?.parentElement?.closest('.flex, .inline-flex, [role="toolbar"]');
    // 新版 footer 是网格，直接追加按钮会生成额外一行；工具入口放进原生操作组。
    return host && footer.contains(host) ? host : footer;
  }

  function codexPlusPromptEnhanceFooters() {
    // 与语音入口同样的去重：一个输入框只挂一个按钮，优先挂在包含输入框的 footer 上。
    const hosts = new Map();
    document.querySelectorAll(".composer-footer, [data-composer-footer-responsive]").forEach((footer) => {
      if (!visibleElement(footer) || isExtensionUiNode(footer)) return;
      const scope = codexPlusDictationScope(footer);
      const editor = scope && codexPlusDictationEditor(scope);
      if (!editor) return;
      const score = codexPlusDictationFooterScore(footer, editor);
      const current = hosts.get(editor);
      if (!current || score >= current.score) hosts.set(editor, { footer, score });
    });
    const footers = new Set([...hosts.values()].map((item) => item.footer));
    return footers;
  }

  function installCodexPlusPromptEnhance() {
    const footers = codexPlusPromptEnhanceFooters();
    installCodexPlusPromptLibrary(footers);
    if (codexPlusPromptEnhance.target && codexPlusPromptEnhance.phase !== "stale") guardCodexPlusPromptEnhance();
    if (!codexPlusPromptEnhanceEnabled()) {
      if (codexPlusPromptEnhance.phase !== "idle") closeCodexPlusPromptEnhance();
      document.querySelectorAll('[data-codex-plus-ext="builtin-prompt-enhance"]').forEach((node) => node.remove());
      return;
    }
    const oldStyle = document.getElementById("codex-plus-prompt-enhance-style");
    if (oldStyle && oldStyle.dataset.runtime !== "prompt-tools") oldStyle.remove();
    if (!document.getElementById("codex-plus-prompt-enhance-style")) {
      const style = document.createElement("style");
      style.id = "codex-plus-prompt-enhance-style";
      style.dataset.runtime = "prompt-tools";
      style.dataset.codexPlusExt = "builtin-prompt-enhance";
      style.textContent = `.codex-plus-prompt-enhance-trigger{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex-shrink:0;padding:0;margin-inline:2px;border:0;border-radius:8px;background:transparent;color:var(--color-token-text-primary,currentColor);opacity:.9;cursor:pointer}
        .codex-plus-prompt-enhance-trigger:hover{background:var(--color-token-interactive-bg-secondary-hover,color-mix(in srgb,currentColor 12%,transparent));opacity:1}
        .codex-plus-prompt-enhance-trigger:disabled{opacity:.4;cursor:default;background:transparent}
        .codex-plus-prompt-enhance-trigger[aria-busy="true"] svg{animation:codex-plus-prompt-enhance-pulse 1.2s ease-in-out infinite}
        .codex-plus-prompt-enhance-trigger:focus-visible,#codex-plus-prompt-enhance-panel button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
        @keyframes codex-plus-prompt-enhance-pulse{50%{opacity:.35}}
        #codex-plus-prompt-enhance-panel{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;padding:12px 14px 14px;overflow:auto;border:1px solid var(--color-token-border-heavy,#8885);border-radius:16px;background:var(--color-token-dropdown-background,var(--color-token-main-surface-primary,#2d2d2d));color:var(--color-token-text-primary,#eee);box-shadow:0 12px 32px #0006;font-size:13px;line-height:1.5}
        .codex-plus-prompt-enhance-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
        .codex-plus-prompt-enhance-header strong{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600}
        .codex-plus-prompt-enhance-close{width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--color-token-text-tertiary,inherit);font-size:16px;line-height:1;cursor:pointer}
        .codex-plus-prompt-enhance-close:hover{background:var(--color-token-interactive-bg-secondary-hover,#fff2);color:inherit}
        #codex-plus-prompt-enhance-panel [role="status"]{color:var(--color-token-text-tertiary,inherit);font-size:12px}
        #codex-plus-prompt-enhance-panel [role="status"].is-loading{animation:codex-plus-prompt-enhance-pulse 1.2s ease-in-out infinite}
        #codex-plus-prompt-enhance-panel [role="status"].is-warning{color:var(--color-token-editor-warning-foreground,#ff8549)}
        #codex-plus-prompt-enhance-panel [role="status"].is-error{color:#e5484d;white-space:pre-wrap;word-break:break-word}
        .codex-plus-prompt-enhance-draft{max-height:96px;overflow:auto;padding:8px 10px;border-radius:10px;background:var(--color-token-bg-tertiary,#0002);color:var(--color-token-text-tertiary,inherit);white-space:pre-wrap;word-break:break-word}
        #codex-plus-prompt-enhance-panel textarea{box-sizing:border-box;width:100%;min-height:96px;max-height:50vh;resize:vertical;padding:10px 12px;border:1px solid var(--color-token-input-border,#8884);border-radius:10px;background:var(--color-token-bg-tertiary,transparent);color:inherit;font:inherit;font-size:14px;line-height:1.6;outline:none}
        #codex-plus-prompt-enhance-panel textarea:focus{border-color:var(--color-token-text-tertiary,#888)}
        .codex-plus-prompt-enhance-actions{display:flex;flex-wrap:wrap;align-items:center;gap:6px;justify-content:flex-end}
        .codex-plus-prompt-enhance-hint{margin-right:auto;color:var(--color-token-text-tertiary,inherit);font-size:12px}
        .codex-plus-prompt-enhance-actions button{height:28px;padding:0 12px;border:1px solid var(--color-token-border-heavy,#8885);border-radius:8px;background:transparent;color:inherit;cursor:pointer;white-space:nowrap}
        .codex-plus-prompt-enhance-actions button:hover{background:var(--color-token-interactive-bg-secondary-hover,#fff2)}
        .codex-plus-prompt-enhance-actions button.is-primary{background:var(--color-token-text-primary,#eee);color:var(--color-token-bg-primary,#222);border-color:transparent;font-weight:500}
        .codex-plus-prompt-enhance-actions button.is-primary:hover{opacity:.9}
        .codex-plus-prompt-enhance-actions button:disabled{opacity:.45;cursor:default}`;
      style.textContent += `
        .codex-plus-prompt-enhance-mode-menu{position:fixed;z-index:2147483001;display:flex;flex-direction:column;gap:2px;min-width:136px;padding:4px;border:1px solid var(--color-token-border-heavy,#8885);border-radius:10px;background:var(--color-token-dropdown-background,var(--color-token-main-surface-primary,#2d2d2d));color:var(--color-token-text-primary,#eee);box-shadow:0 6px 18px #0004}
        .codex-plus-prompt-enhance-mode-menu button,.codex-plus-prompt-enhance-tabs button{border:1px solid var(--color-token-border-heavy,#8885);border-radius:8px;background:transparent;color:inherit;padding:6px 10px;cursor:pointer}
        .codex-plus-prompt-enhance-mode-menu button{display:block;text-align:left;border:0;border-radius:6px;padding:7px 10px;font-size:13px;line-height:20px}
        .codex-plus-prompt-enhance-mode-menu button:hover,.codex-plus-prompt-enhance-mode-menu button:focus-visible{background:var(--color-token-interactive-bg-secondary-hover,#8883);outline:0}
        .codex-plus-prompt-enhance-tabs{display:flex;gap:6px;flex-wrap:wrap}
        .codex-plus-prompt-enhance-tabs [aria-selected="true"]{background:var(--color-token-interactive-bg-secondary-hover,#fff2);font-weight:600}
        .codex-plus-prompt-enhance-questions fieldset{margin:0;padding:0;border:0;min-width:0}
        .codex-plus-prompt-enhance-answer-label{font-size:12px;color:var(--color-token-text-tertiary,inherit);margin-bottom:6px}
        .codex-plus-prompt-enhance-option{display:flex;align-items:flex-start;gap:8px;padding:10px 8px;margin-bottom:6px;border:1px solid var(--color-token-border-heavy,#8885);border-radius:10px;cursor:pointer}
        .codex-plus-prompt-enhance-option:has(input:checked){border-color:var(--color-token-text-primary,currentColor);background:var(--color-token-interactive-bg-secondary-hover,#fff1)}
        .codex-plus-prompt-enhance-option input{flex-shrink:0;margin-top:4px;accent-color:var(--color-token-text-primary,currentColor)}
        .codex-plus-prompt-enhance-option span{min-width:0;overflow-wrap:anywhere}
        .codex-plus-prompt-enhance-option strong{font-size:13px;font-weight:500}
        .codex-plus-prompt-enhance-option small{display:block;color:var(--color-token-text-tertiary,inherit)}
        .codex-plus-prompt-enhance-context{font-size:12px;color:var(--color-token-text-tertiary,inherit);overflow-wrap:anywhere}
        #codex-plus-prompt-enhance-panel input:focus-visible{outline:2px solid currentColor;outline-offset:2px}
        #codex-plus-prompt-enhance-panel textarea:disabled{opacity:.5;min-height:60px}
        @media(prefers-reduced-motion:reduce){.codex-plus-prompt-enhance-trigger svg,#codex-plus-prompt-enhance-panel [role="status"]{animation:none!important}}
      `;
      document.head.append(style);
    }
    document.querySelectorAll("[data-prompt-enhance-trigger]").forEach((node) => {
      if (!footers.has(node.closest(".composer-footer, [data-composer-footer-responsive]"))) node.remove();
    });
    for (const footer of footers) {
      const existing = footer.querySelector("[data-prompt-enhance-trigger]");
      const host = codexPlusPromptToolsHost(footer);
      if (existing?.closest(".composer-footer, [data-composer-footer-responsive]") === footer) {
        if (existing.parentElement !== host) host.append(existing);
        continue;
      }
      const trigger = createCodexPlusPromptEnhanceTrigger();
      trigger.disabled = codexPlusPromptEnhance.phase === "loading";
      host.append(trigger);
    }
  }

  const codexPlusPromptEnhanceKeyHandler = (event) => {
    if (event.key !== "Escape" || event.isComposing) return;
    if (codexPlusPromptLibrary.panel) { event.preventDefault(); event.stopImmediatePropagation(); closeCodexPlusPromptLibrary(); return; }
    const menus = document.querySelectorAll("[data-prompt-enhance-menu]");
    if (menus.length) {
      menus.forEach((menu) => menu.remove());
      document.querySelector("[data-prompt-enhance-trigger]")?.focus();
      event.preventDefault(); event.stopImmediatePropagation();
      return;
    }
    if (codexPlusPromptEnhance.phase === "idle") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeCodexPlusPromptEnhance();
  };
  const codexPlusPromptEnhanceMenuPointer = (event) => {
    if (!event.target.closest?.("[data-prompt-enhance-menu], [data-prompt-enhance-trigger]")) {
      document.querySelectorAll("[data-prompt-enhance-menu]").forEach((menu) => menu.remove());
    }
  };
  document.addEventListener("pointerdown", codexPlusPromptEnhanceMenuPointer, true);
  const codexPlusPromptEnhanceResize = () => {
    document.querySelectorAll("[data-prompt-enhance-menu]").forEach((menu) => menu.remove());
    const panel = document.getElementById("codex-plus-prompt-enhance-panel");
    if (panel) positionCodexPlusPromptEnhancePanel(panel);
  };
  const codexPlusPromptEnhanceInput = (event) => {
    if (codexPlusPromptEnhance.mode === "grill" && codexPlusPromptEnhance.phase !== "stale"
        && codexPlusPromptEnhance.target?.editor?.contains?.(event.target)) guardCodexPlusPromptEnhance();
  };
  const codexPlusPromptEnhanceNavigation = () => { if (codexPlusPromptEnhance.phase !== "idle") guardCodexPlusPromptEnhance(); };
  window.addEventListener("popstate", codexPlusPromptEnhanceNavigation);
  window.addEventListener("hashchange", codexPlusPromptEnhanceNavigation);
  document.addEventListener("input", codexPlusPromptEnhanceInput, true);
  document.addEventListener("keydown", codexPlusPromptEnhanceKeyHandler, true);
  window.addEventListener("resize", codexPlusPromptEnhanceResize);
  const codexPlusPromptEnhanceDispose = () => {
    ++codexPlusPromptEnhance.revision;
    disposeCodexPlusPromptLibrary();
    window.removeEventListener("popstate", codexPlusPromptEnhanceNavigation);
    window.removeEventListener("hashchange", codexPlusPromptEnhanceNavigation);
    document.removeEventListener("pointerdown", codexPlusPromptEnhanceMenuPointer, true);
    document.removeEventListener("input", codexPlusPromptEnhanceInput, true);
    document.removeEventListener("keydown", codexPlusPromptEnhanceKeyHandler, true);
    window.removeEventListener("resize", codexPlusPromptEnhanceResize);
    document.querySelectorAll('[data-codex-plus-ext="builtin-prompt-enhance"]').forEach((node) => node.remove());
  };
  window.addEventListener("pagehide", codexPlusPromptEnhanceDispose, { once: true });
  window.__codexPlusPromptEnhanceRuntime = { dispose: () => {
    window.removeEventListener("pagehide", codexPlusPromptEnhanceDispose);
    codexPlusPromptEnhanceDispose();
  } };
