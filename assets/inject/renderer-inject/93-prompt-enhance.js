  // 提示词增强：把输入框草稿交给后端模型改写，预览确认后才写回；取消时输入框保持原样。
  // 入口与常用提示词共用 composer footer；卡片浮在输入框上方，宽度与输入框一致。
  window.__codexPlusPromptEnhanceRuntime?.dispose?.();
  const codexPlusPromptEnhance = {
    phase: "idle", revision: 0, target: null, text: "", generated: "", error: "", nativeApiPromise: null,
    mode: "rewrite", history: [], questions: [], answers: Object.create(null), activeQuestion: 0,
    lastRequest: null, context: null, project: null, metadata: null,
    messages: [], supplement: "", resumePhase: "ready", cacheKey: "", locked: false, panel: null,
    intro: "", busyText: "", started: false, other: null,
  };
  const codexPlusPromptWorkflows = new Map();
  registerCodexPlusExtensionSelector('[data-codex-plus-ext="builtin-prompt-enhance"]');

  function codexPlusPromptEnhanceMasterEnabled() {
    return codexPlusBackendSettingsLoaded && codexPlusBackendSettings.enhancementsEnabled !== false
      && codexPlusBackendSettings.promptEnhance?.enabled === true;
  }

  function codexPlusPromptFavoritesEnabled() {
    return codexPlusPromptEnhanceMasterEnabled()
      && codexPlusBackendSettings.promptEnhance?.favoritesEnabled !== false;
  }

  function codexPlusPromptEnhanceEnabled() {
    return codexPlusPromptEnhanceMasterEnabled() && codexPlusPromptEnhanceModes().length > 0;
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
      closeCodexPlusPromptEnhance();
      return false;
    }
    const locked = codexPlusPromptEnhanceDraftChanged();
    if (locked !== state.locked) {
      state.locked = locked;
      if (locked && state.phase === "loading") {
        // 草稿变了就别等旧请求了；保留上一次已经拿到的内容，只允许按新内容重来。
        cancelCodexPlusPromptEnhanceRequest();
        ++state.revision;
        state.phase = state.resumePhase === "loading" ? "ready" : state.resumePhase;
      }
      renderCodexPlusPromptEnhance();
    }
    return true;
  }

  function codexPlusPromptEnhanceAnswer(question) {
    const value = codexPlusPromptEnhance.answers[question.id];
    return typeof value === "string" ? value.trim() : "";
  }

  function codexPlusPromptEnhanceRound() {
    const state = codexPlusPromptEnhance;
    return { questions: state.questions, answers: state.questions.flatMap((question) => {
      const answer = codexPlusPromptEnhanceAnswer(question);
      return answer ? [{ questionId: question.id, answer }] : [];
    }) };
  }

  async function requestCodexPlusPromptEnhance(options = {}) {
    const state = codexPlusPromptEnhance;
    const target = state.target;
    if (!target || !guardCodexPlusPromptEnhance()) return;
    if (state.locked && !options.start) return;
    if (!codexPlusPromptEnhanceEnabled() || !codexPlusPromptEnhanceModes().includes(state.mode)) {
      showToast("本次增强模式已关闭", null); return;
    }
    let payload;
    if (options.retry && state.lastRequest) {
      payload = { ...state.lastRequest, requestId: crypto.randomUUID() };
    } else {
      const start = !!options.start;
      const addition = options.addition ?? "";
      const current = options.answers ?? state.answers;
      let rounds = start ? [] : (options.rounds ?? state.history);
      if (!start && options.rounds === undefined && state.phase === "questions" && state.questions.length) {
        const confirmed = state.questions
          .map((question) => ({ questionId: question.id, answer: codexPlusPromptEnhanceAnswer(question) }))
          .filter((answer) => answer.answer);
        if (!options.supplementOnly || confirmed.length)
          rounds = [...rounds, { questions: state.questions, answers: confirmed }];
      }
      const messages = start || options.rounds ? [] : [
        ...state.messages,
        ...(options.supplementOnly && state.questions[state.activeQuestion]
          ? [{ role: "assistant", text: JSON.stringify(state.questions[state.activeQuestion]), round: rounds.length }]
          : []),
        ...(["result", "summary"].includes(state.phase)
          ? [{ role: "assistant", text: state.text, round: rounds.length }]
          : []),
        ...(addition.trim() ? [{ role: "user", text: addition.trim(), round: rounds.length }] : []),
      ];
      // 输入框为空时，需求对齐先问「你想做什么？」，用户填写后才调用模型。
      const prompt = (target.original || "").trim() || String(options.intro ?? state.intro ?? "").trim();
      if (!prompt) { showToast("先在输入框里写点内容", null); return; }
      payload = {
        prompt,
        mode: state.mode,
        scenario: "general",
        history: rounds,
        forceFinal: !!options.forceFinal,
        messages,
        currentText: start || options.rounds ? "" : state.text,
        requestId: crypto.randomUUID(),
      };
    }
    const revision = ++state.revision;
    cancelCodexPlusPromptEnhanceRequest();
    state.resumePhase = state.phase === "loading" ? state.resumePhase : state.phase;
    state.busyText = state.mode === "rewrite"
      ? (state.phase === "result" && payload.messages?.some((message) => message.role === "user") ? "正在按你的意见修改…" : "正在改写…")
      : (payload.forceFinal
        ? (state.phase === "result" ? "正在按你的意见修改…" : "正在写提示词…")
        : "正在想问题…");
    state.phase = "loading";
    state.error = "";
    state.lastRequest = payload;
    state.supplement = "";
    state.other = null;
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
    state.context = result?.context || state.context;
    if (result?.status !== "ok") {
      state.phase = "error";
      state.error = result?.message || "提示词增强失败";
      renderCodexPlusPromptEnhance();
      return;
    }
    state.messages = payload.messages || [];
    state.metadata = result.metadata || null;
    state.started = true;
    if (result.kind === "questions" && Array.isArray(result.questions) && result.questions.length) {
      Object.assign(state, {
        phase: "questions", history: payload.history || [], questions: result.questions,
        answers: Object.create(null), activeQuestion: 0, other: null, text: "", generated: "",
      });
    } else {
      const text = typeof result.text === "string" ? result.text.trim() : "";
      if (!text) {
        state.phase = "error";
        state.error = "模型没有返回内容，请重试";
      } else {
        Object.assign(state, {
          phase: state.mode === "rewrite" || result.kind === "final" || payload.forceFinal ? "result" : "summary",
          text, generated: text, history: payload.history || [],
          questions: [], answers: Object.create(null), activeQuestion: 0, other: null,
        });
      }
    }
    renderCodexPlusPromptEnhance();
  }

  async function startCodexPlusPromptEnhance(footer, mode = codexPlusBackendSettings.promptEnhance?.defaultMode || "rewrite", options = {}) {
    const state = codexPlusPromptEnhance;
    if (!codexPlusPromptEnhanceEnabled()) return;
    if (state.phase !== "idle") closeCodexPlusPromptEnhance();
    closeCodexPlusPromptLibrary(false);
    const modes = codexPlusPromptEnhanceModes();
    if (!modes.includes(mode)) mode = modes[0];
    if (!mode) return;
    const revision = ++state.revision;
    const target = await captureCodexPlusPromptTarget(footer);
    if (revision !== state.revision || !target) return;
    if (!target.original.trim() && mode === "rewrite") { showToast("先在输入框里写点内容", null); return; }
    const cacheKey = JSON.stringify([target.href, target.location?.sessionId || "", target.location?.hostId || "", target.location?.workingDirectory || "", mode]);
    const saved = options.fresh ? null : codexPlusPromptWorkflows.get(cacheKey);
    if (saved) {
      Object.assign(state, saved, {
        revision, cacheKey, panel: state.panel,
        target: { ...target, original: saved.target.original, doc: saved.target.doc, rich: saved.target.rich },
      });
      state.locked = codexPlusPromptEnhanceLocked();
      renderCodexPlusPromptEnhance();
      return;
    }
    codexPlusPromptWorkflows.delete(cacheKey);
    Object.assign(state, {
      target, mode, revision, cacheKey, phase: target.original.trim() ? "loading" : "intro",
      history: [], questions: [], answers: Object.create(null), activeQuestion: 0, other: null,
      context: null, project: null, lastRequest: null, generated: "", metadata: null,
      messages: [], supplement: "", text: "", intro: "", locked: false, error: "",
      started: !target.original.trim(), resumePhase: "ready",
    });
    renderCodexPlusPromptEnhance();
    if (state.phase === "loading") await requestCodexPlusPromptEnhance({ start: true });
  }

  function codexPlusPromptEnhanceLocked() {
    const state = codexPlusPromptEnhance;
    if (!state.target || state.phase === "idle") return false;
    return codexPlusPromptEnhanceDraftChanged();
  }

  function cancelCodexPlusPromptEnhanceRequest() {
    const state = codexPlusPromptEnhance;
    if (state.phase === "loading" && state.lastRequest?.requestId) {
      void postJson("/prompt-enhance/cancel", { requestId: state.lastRequest.requestId }).catch(() => {});
    }
  }

  function closeCodexPlusPromptEnhance() {
    const state = codexPlusPromptEnhance;
    cancelCodexPlusPromptEnhanceRequest();
    if (state.target && state.cacheKey) {
      codexPlusPromptWorkflows.set(state.cacheKey, {
        ...state, panel: null,
        phase: state.phase === "loading" ? state.resumePhase : state.phase,
      });
    }
    ++state.revision;
    const editor = state.target?.editor;
    Object.assign(state, {
      phase: "idle", target: null, text: "", error: "", history: [], questions: [],
      answers: Object.create(null), lastRequest: null, project: null, context: null,
      locked: false, intro: "", messages: [], supplement: "", generated: "", started: false, other: null,
    });
    renderCodexPlusPromptEnhance();
    if (editor?.isConnected) editor.focus?.();
  }

  // 写回后的提示：替换可以撤销，撤销要求输入框仍然是写回后的内容。
  function codexPlusPromptEnhanceNotifyWrite(target, mode, before) {
    if (mode === "append") { showToast("已追加到输入框", null); return; }
    const current = codexPlusPromptEnhanceRead(target.editor, target.native);
    const after = current?.text ?? "";
    showToast("已替换输入框内容", { action: {
      label: "撤销",
      run: () => {
        if (!codexPlusPromptEnhanceTargetAlive(target)) { showToast("输入框或会话已变化，无法撤销", null); return; }
        const live = codexPlusPromptEnhanceRead(target.editor, target.native);
        if (!live || live.text !== after) { showToast("输入框已改动，无法撤销", null); return; }
        if (!codexPlusPromptEnhanceWrite(target.editor, before, "replace", target.native))
          showToast("无法撤销，请手动恢复", null);
      },
    } });
  }

  function applyCodexPlusPromptEnhance(mode, text) {
    const state = codexPlusPromptEnhance;
    if (state.phase !== "result") return false;
    if (!String(text || "").trim()) { showToast("结果为空，没有可写入的内容", null); return false; }
    if (!codexPlusPromptEnhanceTargetAlive()) { showToast("输入框或会话已变化，请复制结果后手动粘贴", null); return false; }
    if (mode === "replace") {
      const blocker = codexPlusPromptEnhanceReplaceBlocker();
      if (blocker) { showToast(blocker, null); return false; }
    }
    const { editor, native } = state.target;
    const target = state.target;
    if (!codexPlusPromptEnhanceWrite(editor, text, mode, native)) {
      showToast("写入输入框失败，请复制结果后手动粘贴", null);
      return false;
    }
    closeCodexPlusPromptEnhance();
    codexPlusPromptEnhanceNotifyWrite(target, mode, target.original);
    return true;
  }

  // —— 渲染 ——

  const codexPlusPromptIconPaths = {
    sparkles: ["M6.5 2.5 7.6 5.9 11 7 7.6 8.1 6.5 11.5 5.4 8.1 2 7 5.4 5.9Z", "M12 9.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6Z"],
    bookmark: ["M4 2h8v12l-4-3-4 3V2Z"],
    rotate: ["M3 3v4h4", "M3.7 7A6 6 0 1 1 3 10.5"],
    copy: ["M5 5V3h8v9h-2", "M3 5h8v9H3z"],
    pencil: ["M3 13l1-3 7-7 2 2-7 7-3 1Z"],
    trash: ["M3 4h10", "M5 4V2h6v2", "M4 4l1 10h6l1-10"],
    swap: ["M3 6h9", "M9 3l3 3-3 3", "M13 10H4", "M7 13l-3-3 3-3"],
    grip: ["M6 3h.01", "M10 3h.01", "M6 8h.01", "M10 8h.01", "M6 13h.01", "M10 13h.01"],
  };

  function codexPlusPromptIcon(name) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "16"); svg.setAttribute("height", "16");
    svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.3");
    svg.setAttribute("stroke-linecap", name === "grip" ? "round" : "butt");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of codexPlusPromptIconPaths[name] || []) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      svg.appendChild(path);
    }
    return svg;
  }

  function codexPlusPromptNode(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function codexPlusPromptButton(label, action, options = {}) {
    const button = codexPlusPromptNode("button", `codex-plus-prompt-action${options.primary ? " is-primary" : ""}`, label);
    button.type = "button";
    button.dataset.promptEnhanceAction = action;
    if (options.title) button.title = options.title;
    if (options.disabled) button.disabled = true;
    return button;
  }

  function codexPlusPromptIconButton(name, label, action, options = {}) {
    const button = codexPlusPromptNode("button", "codex-plus-prompt-icon");
    button.type = "button";
    button.dataset.promptEnhanceAction = action;
    button.title = options.title || label;
    button.setAttribute("aria-label", label);
    if (options.disabled) button.disabled = true;
    button.append(codexPlusPromptIcon(name));
    return button;
  }

  // Codex3N 的输入卡片贴在 composer 上方；空间不足时落到下面。宽度跟随输入框。
  function codexPlusPromptCardScope() {
    const target = codexPlusPromptEnhance.target || codexPlusPromptLibrary.target;
    const footer = target?.footer;
    const scope = footer && codexPlusDictationScope(footer);
    return scope || footer?.parentElement || null;
  }

  function positionCodexPlusPromptCard(panel) {
    const rect = codexPlusPromptCardScope()?.getBoundingClientRect?.();
    const zoom = typeof codexPlusWindowZoom === "function" ? codexPlusWindowZoom() : 1;
    const margin = 8;
    const viewportWidth = window.innerWidth / zoom;
    const viewportHeight = window.innerHeight / zoom;
    const left = rect ? Math.max(margin, rect.left / zoom) : margin;
    const width = rect
      ? Math.min(rect.width / zoom, viewportWidth - left - margin)
      : Math.min(560, viewportWidth - margin * 2);
    const above = rect ? rect.top / zoom - margin : viewportHeight - margin;
    let maxHeight = Math.min(viewportHeight * 0.62, above);
    let top = above - maxHeight;
    if (maxHeight < 220 && rect) {
      top = rect.bottom / zoom + margin;
      maxHeight = Math.min(viewportHeight * 0.62, viewportHeight - top - margin);
    }
    Object.assign(panel.style, {
      left: `${left}px`,
      top: `${Math.max(margin, top)}px`,
      width: `${Math.max(240, width)}px`,
      maxHeight: `${Math.max(160, maxHeight)}px`,
    });
  }

  // 旧入口保留这个名字，收藏库也用它。
  function positionCodexPlusPromptEnhancePanel(panel) {
    positionCodexPlusPromptCard(panel);
  }

  function codexPlusPromptEnhanceContextCaption() {
    const state = codexPlusPromptEnhance;
    const files = state.context?.sections?.flatMap((section) => section.files || []) || [];
    if (!files.length) return null;
    const row = codexPlusPromptNode("p", "codex-plus-prompt-caption", `参考了 ${files.join("、")}`);
    row.title = (state.context?.sections || []).map((section) =>
      `${section.kind}：${(section.files || []).join("、")}${section.truncated ? "（已截断）" : ""}`).join("\n");
    return row;
  }

  function codexPlusPromptEnhancePanel() {
    let panel = codexPlusPromptEnhance.panel;
    if (panel?.isConnected) return panel;
    panel = document.getElementById("codex-plus-prompt-enhance-panel") || document.createElement("div");
    panel.id = "codex-plus-prompt-enhance-panel";
    panel.dataset.runtime = "prompt-tools";
    panel.dataset.codexPlusExt = "builtin-prompt-enhance";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "提示词增强");
    if (!panel.dataset.bound) {
      panel.dataset.bound = "true";
      panel.addEventListener("click", (event) => {
        const action = event.target.closest?.("[data-prompt-enhance-action]")?.dataset.promptEnhanceAction;
        if (!action) return;
        event.preventDefault();
        event.stopPropagation();
        const state = codexPlusPromptEnhance;
        if (action === "close") closeCodexPlusPromptEnhance();
        else if (action === "retry") void requestCodexPlusPromptEnhance({ retry: true });
        else if (action === "restart") {
          const { target, mode } = state;
          if (target?.footer?.isConnected) void startCodexPlusPromptEnhance(target.footer, mode, { fresh: true });
          else showToast("请在当前输入框重新点击增强", null);
        } else if (action === "regenerate") {
          if (state.locked) return;
          void requestCodexPlusPromptEnhance({ forceFinal: state.mode === "grill", rounds: state.history });
        } else if (action === "copy") {
          if (!navigator.clipboard?.writeText) { showToast("请选中结果手动复制", null); return; }
          void navigator.clipboard.writeText(state.text).then(() => showToast("已复制结果", null))
            .catch(() => showToast("复制失败，请选中结果手动复制", null));
        } else if (action === "save") {
          const project = state.project && !state.project.reason && state.project.workingDirectory
            ? { hostId: state.project.hostId, workingDirectory: state.project.workingDirectory } : null;
          void postJson("/prompt-enhance/library/add", { body: state.text, project }).then((result) => {
            if (result?.status !== "ok") throw new Error(result?.message || "保存失败");
            const id = result.favorite?.id;
            showToast("已存为常用", id ? { action: { label: "编辑", run: () => {
              const footer = state.target?.footer;
              if (footer?.isConnected) void openCodexPlusPromptLibrary(footer, { editId: id });
            } } } : null);
          }).catch((error) => showToast(error?.message || "保存失败，请重试", null));
        } else if (action === "append" || action === "replace") applyCodexPlusPromptEnhance(action, state.text);
        else if (action === "direct") void requestCodexPlusPromptEnhance({ forceFinal: true });
        else if (action === "write") void requestCodexPlusPromptEnhance({ forceFinal: true });
        else if (action === "ask-more") void requestCodexPlusPromptEnhance({ supplementOnly: true, addition: "还有没问清楚的地方，请继续提问。" });
        else if (action === "change-answers") changeCodexPlusPromptEnhanceAnswers();
        else if (action === "prev") {
          if (state.activeQuestion > 0) { state.activeQuestion -= 1; state.other = null; renderCodexPlusPromptEnhance(); }
        } else if (action === "next") advanceCodexPlusPromptEnhance();
        else if (action === "rephrase") void requestCodexPlusPromptEnhance({
          supplementOnly: true, addition: "这道题没看懂，请用具体例子重新解释，让选项的区别更清楚。",
        });
      });
      panel.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        const nodes = [...panel.querySelectorAll("button:not(:disabled),input,textarea,select,summary")].filter((node) => node.checkVisibility());
        if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === nodes.at(-1)) { event.preventDefault(); nodes[0]?.focus(); }
      });
    }
    codexPlusPromptEnhance.panel = panel;
    if (!panel.isConnected) document.body.append(panel);
    return panel;
  }

  function pickCodexPlusPromptEnhanceAnswer(answer) {
    const state = codexPlusPromptEnhance;
    const question = state.questions[state.activeQuestion];
    if (!question || state.locked || state.phase !== "questions") return;
    state.answers[question.id] = answer;
    state.other = null;
    if (state.activeQuestion < state.questions.length - 1) {
      state.activeQuestion += 1;
      renderCodexPlusPromptEnhance();
    } else void requestCodexPlusPromptEnhance({ answers: { ...state.answers } });
  }

  // ›：已回答就前进，未回答就交给模型决定。
  function advanceCodexPlusPromptEnhance() {
    const state = codexPlusPromptEnhance;
    const question = state.questions[state.activeQuestion];
    if (!question || state.locked) return;
    pickCodexPlusPromptEnhanceAnswer(codexPlusPromptEnhanceAnswer(question) || "没想好，你看着定");
  }

  function changeCodexPlusPromptEnhanceAnswers() {
    const state = codexPlusPromptEnhance;
    const index = state.history.length - 1;
    const round = state.history[index];
    if (!round || state.locked) return;
    state.history = state.history.slice(0, index);
    state.messages = state.messages.filter((message) => (message.round ?? 0) <= index);
    state.questions = round.questions;
    state.answers = Object.fromEntries(round.answers.map((answer) => [answer.questionId, answer.answer]));
    state.activeQuestion = 0;
    state.other = null;
    state.text = "";
    state.generated = "";
    state.phase = "questions";
    state.error = "";
    renderCodexPlusPromptEnhance();
  }

  function createCodexPlusPromptEnhanceQuestions() {
    const state = codexPlusPromptEnhance;
    const wrapper = codexPlusPromptNode("div", "codex-plus-prompt-questions");
    const question = state.questions[state.activeQuestion];
    if (!question) return wrapper;
    const heading = codexPlusPromptNode("div", "codex-plus-prompt-question-heading");
    heading.append(codexPlusPromptNode("h3", "codex-plus-prompt-question", question.question));
    heading.append(codexPlusPromptIconButton("rotate", "换个问题", "rephrase", { disabled: state.locked }));
    wrapper.append(heading);
    const group = codexPlusPromptNode("div", "codex-plus-prompt-options");
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", question.question);
    const current = codexPlusPromptEnhanceAnswer(question);
    question.options.forEach((option, index) => {
      const selected = current === option.label;
      const button = codexPlusPromptNode("button", `codex-plus-prompt-option${selected ? " is-selected" : ""}`);
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(selected));
      button.disabled = state.locked;
      button.append(codexPlusPromptNode("span", "codex-plus-prompt-option-number", String(index + 1)));
      const text = codexPlusPromptNode("span", "codex-plus-prompt-option-text");
      text.append(codexPlusPromptNode("strong", "", option.label));
      if (index === question.recommended) text.append(codexPlusPromptNode("span", "codex-plus-prompt-badge", "推荐"));
      if (option.description) text.append(codexPlusPromptNode("small", "", option.description));
      button.append(text);
      button.addEventListener("click", () => pickCodexPlusPromptEnhanceAnswer(option.label));
      group.append(button);
    });
    const custom = current && !question.options.some((option) => option.label === current) && current !== "没想好，你看着定"
      ? current : "";
    if (state.other !== null) {
      const row = codexPlusPromptNode("div", "codex-plus-prompt-option codex-plus-prompt-option-editing");
      row.append(codexPlusPromptNode("span", "codex-plus-prompt-option-number", String(question.options.length + 1)));
      const input = document.createElement("input");
      input.className = "codex-plus-prompt-input";
      input.maxLength = 3000;
      input.value = state.other;
      input.placeholder = "写下你的想法，回车确认";
      input.setAttribute("aria-label", "其他");
      input.disabled = state.locked;
      input.addEventListener("input", () => { state.other = input.value; });
      input.addEventListener("blur", () => { if (!input.value.trim()) { state.other = null; renderCodexPlusPromptEnhance(); } });
      input.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        if (event.key === "Enter" && input.value.trim()) {
          event.preventDefault();
          pickCodexPlusPromptEnhanceAnswer(input.value.trim());
        } else if (event.key === "Escape") {
          // 只收起输入框，不关闭卡片。
          event.preventDefault();
          event.stopPropagation();
          state.other = null;
          renderCodexPlusPromptEnhance();
        }
      });
      row.append(input);
      group.append(row);
      requestAnimationFrame(() => { if (input.isConnected) input.focus(); });
    } else {
      const button = codexPlusPromptNode("button", "codex-plus-prompt-option");
      button.type = "button";
      button.setAttribute("role", "radio");
      button.setAttribute("aria-checked", String(!!custom));
      button.disabled = state.locked;
      button.append(codexPlusPromptNode("span", "codex-plus-prompt-option-number", String(question.options.length + 1)));
      button.append(codexPlusPromptNode("span", "codex-plus-prompt-option-text", custom || "其他…"));
      button.addEventListener("click", () => { state.other = custom; renderCodexPlusPromptEnhance(); });
      group.append(button);
    }
    wrapper.append(group);
    const answered = [
      ...state.history.flatMap((round) => round.questions.map((item) => ({
        question: item.question,
        answer: round.answers.find((answer) => answer.questionId === item.id)?.answer || "",
      }))),
      ...state.questions.slice(0, state.activeQuestion).map((item) => ({
        question: item.question,
        answer: codexPlusPromptEnhanceAnswer(item),
      })),
    ].filter((item) => item.answer);
    if (answered.length) {
      const list = codexPlusPromptNode("ul", "codex-plus-prompt-answered");
      for (const item of answered) {
        const row = codexPlusPromptNode("li", "");
        row.append(codexPlusPromptNode("span", "", `✓ ${item.question}`), codexPlusPromptNode("span", "", item.answer));
        list.append(row);
      }
      wrapper.append(list);
    }
    return wrapper;
  }

  function renderCodexPlusPromptEnhance() {
    const state = codexPlusPromptEnhance;
    document.querySelectorAll("[data-prompt-enhance-trigger]").forEach((button) => {
      button.setAttribute("aria-busy", String(state.phase === "loading"));
      button.dataset.active = String(state.phase !== "idle");
    });
    const panel = state.panel || document.getElementById("codex-plus-prompt-enhance-panel");
    if (state.phase === "idle") {
      panel?.remove();
      state.panel = null;
      return;
    }
    const card = codexPlusPromptEnhancePanel();
    positionCodexPlusPromptCard(card);
    const key = `${state.revision}:${state.phase}:${state.activeQuestion}:${state.locked}:${state.other !== null}:${state.error}`;
    if (card.dataset.renderKey === key) return;
    card.dataset.renderKey = key;
    const children = [];
    const header = codexPlusPromptNode("header", "codex-plus-prompt-head");
    const title = codexPlusPromptNode("h2", "", state.mode === "grill" ? "需求对齐" : "增强提示词");
    const meta = codexPlusPromptNode("span", "codex-plus-prompt-meta", state.phase === "questions"
      ? `第 ${state.history.length + 1} 轮`
      : state.phase === "summary" ? "需求已经够清楚了"
        : state.phase === "result" ? "可以直接修改" : "");
    const close = codexPlusPromptIconButton("trash", "关闭", "close");
    close.replaceChildren(codexPlusPromptNode("span", "codex-plus-prompt-close", "×"));
    close.className = "codex-plus-prompt-icon codex-plus-prompt-close-button";
    header.append(title, meta, codexPlusPromptNode("span", "codex-plus-prompt-grow"), close);
    children.push(header);
    if (state.locked) {
      const banner = codexPlusPromptNode("div", "codex-plus-prompt-stale");
      banner.setAttribute("role", "status");
      banner.append(codexPlusPromptNode("span", "", "输入框内容改过了"));
      const restart = codexPlusPromptNode("button", "codex-plus-prompt-link", "按新内容重来");
      restart.type = "button";
      restart.dataset.promptEnhanceAction = "restart";
      banner.append(restart);
      children.push(banner);
    }
    const body = codexPlusPromptNode("div", "codex-plus-prompt-body");
    if (state.phase === "loading") {
      const loading = codexPlusPromptNode("p", "codex-plus-prompt-status is-loading", state.busyText || "正在处理…");
      loading.setAttribute("role", "status");
      body.append(loading);
      if (state.target?.original) body.append(codexPlusPromptNode("div", "codex-plus-prompt-draft", state.target.original));
    } else if (state.phase === "intro") {
      body.append(codexPlusPromptNode("h3", "codex-plus-prompt-question", "你想做什么？"));
      const input = document.createElement("input");
      input.className = "codex-plus-prompt-input";
      input.maxLength = 20000;
      input.placeholder = "用一句话说说，回车确认";
      input.setAttribute("aria-label", "你想做什么？");
      input.addEventListener("keydown", (event) => {
        if (event.isComposing || event.key !== "Enter") return;
        const value = input.value.trim();
        if (!value) return;
        event.preventDefault();
        state.intro = value;
        void requestCodexPlusPromptEnhance({ intro: value });
      });
      body.append(input);
      requestAnimationFrame(() => { if (input.isConnected) input.focus(); });
    } else if (state.phase === "questions") {
      body.append(createCodexPlusPromptEnhanceQuestions());
    } else if (state.phase === "summary") {
      const hint = codexPlusPromptNode("p", "codex-plus-prompt-caption", "确认没问题就写提示词，有遗漏可以接着问。");
      body.append(hint, codexPlusPromptNode("div", "codex-plus-prompt-summary", state.text));
    } else if (state.phase === "result") {
      const text = document.createElement("textarea");
      text.className = "codex-plus-prompt-input codex-plus-prompt-result";
      text.rows = 10;
      text.spellcheck = false;
      text.value = state.text;
      text.setAttribute("aria-label", "结果");
      text.addEventListener("input", () => { state.text = text.value; });
      body.append(text);
      const follow = document.createElement("input");
      follow.className = "codex-plus-prompt-input codex-plus-prompt-follow";
      follow.maxLength = 3000;
      follow.placeholder = "还想改哪里？回车继续";
      follow.setAttribute("aria-label", "还想改哪里？回车继续");
      follow.value = state.supplement;
      follow.disabled = state.locked;
      follow.addEventListener("input", () => { state.supplement = follow.value; });
      follow.addEventListener("keydown", (event) => {
        if (event.isComposing || event.key !== "Enter") return;
        const addition = follow.value.trim();
        if (!addition) return;
        event.preventDefault();
        state.supplement = addition;
        void requestCodexPlusPromptEnhance({ forceFinal: true, supplementOnly: true, addition });
      });
      body.append(follow);
      const context = codexPlusPromptEnhanceContextCaption();
      if (context) body.append(context);
    } else if (state.phase === "error") {
      body.append(codexPlusPromptNode("p", "codex-plus-prompt-caption", "填写过的答案和结果都还在，可以直接重试。"));
    } else if (state.phase === "ready") {
      body.append(codexPlusPromptNode("p", "codex-plus-prompt-caption", "流程已暂停。"));
    }
    children.push(body);
    if (state.error) {
      const error = codexPlusPromptNode("div", "codex-plus-prompt-error-bar", state.error);
      error.setAttribute("role", "alert");
      const retry = codexPlusPromptNode("button", "codex-plus-prompt-link", "重试");
      retry.type = "button";
      retry.dataset.promptEnhanceAction = "retry";
      error.append(retry);
      children.push(error);
    }
    const footer = codexPlusPromptNode("footer", "codex-plus-prompt-foot");
    if (state.phase === "loading") {
      footer.append(codexPlusPromptNode("span", "codex-plus-prompt-grow"), codexPlusPromptButton("取消", "close"));
    } else if (state.phase === "intro") {
      footer.append(codexPlusPromptNode("span", "codex-plus-prompt-grow"), codexPlusPromptButton("取消", "close"));
    } else if (state.phase === "questions") {
      const pager = codexPlusPromptNode("span", "codex-plus-prompt-pager");
      pager.append(codexPlusPromptIconButton("rotate", "上一题", "prev", { disabled: state.activeQuestion === 0 || state.locked }));
      pager.append(codexPlusPromptNode("span", "", `${state.activeQuestion + 1} / ${state.questions.length}`));
      pager.append(codexPlusPromptIconButton("rotate", "下一题", "next", { disabled: state.locked }));
      footer.append(pager, codexPlusPromptNode("span", "codex-plus-prompt-grow"));
      footer.append(codexPlusPromptButton("不问了，直接写", "direct", { disabled: state.locked }));
    } else if (state.phase === "summary") {
      if (state.history.length) {
        const back = codexPlusPromptNode("button", "codex-plus-prompt-link", "‹ 改答案");
        back.type = "button";
        back.dataset.promptEnhanceAction = "change-answers";
        back.disabled = state.locked;
        footer.append(back);
      }
      footer.append(codexPlusPromptNode("span", "codex-plus-prompt-grow"));
      footer.append(codexPlusPromptButton("接着问", "ask-more", { disabled: state.locked }));
      footer.append(codexPlusPromptButton("写提示词", "write", { primary: true, disabled: state.locked }));
    } else if (state.phase === "result") {
      const blocker = codexPlusPromptEnhanceReplaceBlocker();
      footer.append(codexPlusPromptIconButton("rotate", "重新生成", "regenerate", { disabled: state.locked }));
      footer.append(codexPlusPromptIconButton("copy", "复制", "copy", { disabled: !state.text.trim() }));
      footer.append(codexPlusPromptIconButton("bookmark", "存为常用", "save", { disabled: !state.text.trim() }));
      footer.append(codexPlusPromptNode("span", "codex-plus-prompt-grow"));
      footer.append(codexPlusPromptButton("追加", "append", { disabled: !state.text.trim() }));
      footer.append(codexPlusPromptButton("替换", "replace", {
        primary: true,
        disabled: !state.text.trim() || state.locked || !!blocker,
        title: blocker || undefined,
      }));
    } else if (state.phase === "error") {
      footer.append(codexPlusPromptNode("span", "codex-plus-prompt-grow"), codexPlusPromptButton("关闭", "close"));
      if (state.lastRequest) footer.append(codexPlusPromptButton("重试", "retry", { primary: true }));
    } else {
      footer.append(codexPlusPromptNode("span", "codex-plus-prompt-grow"),
        codexPlusPromptButton("继续", "retry", { primary: true, disabled: !state.lastRequest }));
    }
    children.push(footer);
    card.replaceChildren(...children);
  }

  function codexPlusPromptEnhanceIcon() {
    return codexPlusPromptIcon("sparkles");
  }

  function codexPlusPromptEnhanceTriggerLabel() {
    const modes = codexPlusPromptEnhanceModes();
    if (modes.length === 1) return modes[0] === "grill" ? "需求对齐" : "增强提示词";
    return "增强提示词";
  }

  function createCodexPlusPromptEnhanceTrigger() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "codex-plus-prompt-enhance-trigger";
    button.dataset.codexPlusExt = "builtin-prompt-enhance";
    button.dataset.promptEnhanceTrigger = "true";
    button.setAttribute("aria-label", codexPlusPromptEnhanceTriggerLabel());
    button.title = codexPlusPromptEnhanceTriggerLabel();
    button.append(codexPlusPromptEnhanceIcon());
    // 保住输入框焦点和选区，读取草稿时才是用户正在编辑的那个输入框。
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (codexPlusPromptEnhance.phase !== "idle") codexPlusPromptEnhance.suppressTriggerClick = true;
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (codexPlusPromptEnhance.suppressTriggerClick) {
        codexPlusPromptEnhance.suppressTriggerClick = false;
        return;
      }
      const footer = button.closest(".composer-footer, [data-composer-footer-responsive]");
      const existing = document.querySelector("[data-prompt-enhance-menu]");
      if (existing) { existing.remove(); return; }
      const modes = codexPlusPromptEnhanceModes();
      const single = modes.length === 1 ? modes[0] : null;
      if (single) {
        const empty = !codexPlusPromptEnhanceDraftOf(footer);
        if (single === "rewrite" && empty) { showToast("先在输入框里写点内容", null); return; }
        void startCodexPlusPromptEnhance(footer, single);
        return;
      }
      if (!modes.length) return;
      const menu = document.createElement("div");
      menu.dataset.promptEnhanceMenu = "true";
      menu.dataset.codexPlusExt = "builtin-prompt-enhance";
      menu.className = "codex-plus-prompt-mode-menu";
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "选择增强模式");
      const defaultMode = codexPlusBackendSettings.promptEnhance?.defaultMode || "rewrite";
      modes.sort((a, b) => Number(b === defaultMode) - Number(a === defaultMode));
      const empty = !codexPlusPromptEnhanceDraftOf(footer);
      for (const mode of modes) {
        const blocked = mode === "rewrite" && empty;
        const choice = codexPlusPromptButton(mode === "grill" ? "需求对齐" : "增强提示词", "", {
          disabled: blocked, title: blocked ? "先在输入框里写点内容" : undefined,
        });
        delete choice.dataset.promptEnhanceAction;
        choice.setAttribute("role", "menuitem");
        if (blocked) choice.setAttribute("aria-disabled", "true");
        choice.addEventListener("click", () => {
          if (blocked) return;
          menu.remove();
          void startCodexPlusPromptEnhance(footer, mode);
        });
        menu.append(choice);
      }
      const rect = button.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 152))}px`;
      menu.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
      menu.addEventListener("keydown", (keyEvent) => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(keyEvent.key)) return;
        keyEvent.preventDefault(); keyEvent.stopPropagation();
        const items = [...menu.querySelectorAll("button:not(:disabled)")];
        const index = items.indexOf(document.activeElement);
        const next = keyEvent.key === "Home" ? 0 : keyEvent.key === "End" ? items.length - 1
          : (index + (keyEvent.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      });
      document.body.append(menu);
      menu.querySelector("button:not(:disabled)")?.focus();
    });
    return button;
  }

  function codexPlusPromptEnhanceDraftOf(footer) {
    const scope = footer && codexPlusDictationScope(footer);
    const editor = scope && codexPlusDictationEditor(scope);
    const draft = editor ? codexPlusPromptEnhanceRead(editor) : null;
    return draft?.text || "";
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

  function codexPlusPromptEnhanceStyle() {
    let style = document.getElementById("codex-plus-prompt-enhance-style");
    if (style?.dataset.runtime === "prompt-tools") return style;
    style?.remove();
    style = document.createElement("style");
    style.id = "codex-plus-prompt-enhance-style";
    style.dataset.runtime = "prompt-tools";
    style.dataset.codexPlusExt = "builtin-prompt-enhance";
    style.textContent = `
      .codex-plus-prompt-enhance-trigger,.codex-plus-prompt-library-trigger{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex-shrink:0;padding:0;margin-inline:2px;border:0;border-radius:8px;background:transparent;color:var(--color-token-text-primary,currentColor);opacity:.9;cursor:pointer}
      .codex-plus-prompt-enhance-trigger:hover,.codex-plus-prompt-library-trigger:hover{background:var(--color-token-interactive-bg-secondary-hover,color-mix(in srgb,currentColor 12%,transparent));opacity:1}
      .codex-plus-prompt-enhance-trigger[data-active="true"],.codex-plus-prompt-library-trigger[data-active="true"]{background:var(--color-token-interactive-bg-secondary-hover,color-mix(in srgb,currentColor 12%,transparent))}
      .codex-plus-prompt-enhance-trigger:focus-visible,.codex-plus-prompt-library-trigger:focus-visible{outline:2px solid currentColor;outline-offset:2px}
      #codex-plus-prompt-enhance-panel,#codex-plus-prompt-library{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;padding:12px 14px;overflow:hidden;border:1px solid var(--color-token-border-heavy,#8885);border-radius:14px;background:var(--color-token-dropdown-background,var(--color-token-main-surface-primary,#2d2d2d));color:var(--color-token-text-primary,#eee);font:13px/1.6 system-ui}
      #codex-plus-prompt-enhance-panel *,#codex-plus-prompt-library *{box-sizing:border-box}
      .codex-plus-prompt-head{display:flex;align-items:center;gap:8px;flex:none}
      .codex-plus-prompt-head h2{margin:0;font-size:13px;font-weight:600}
      .codex-plus-prompt-meta{color:var(--color-token-text-tertiary,inherit);font-size:12px}
      .codex-plus-prompt-grow{flex:1 1 auto}
      .codex-plus-prompt-body{display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto;padding:2px 2px 4px}
      .codex-plus-prompt-status{color:var(--color-token-text-tertiary,inherit);margin:0}
      .codex-plus-prompt-status.is-loading{animation:codex-plus-prompt-pulse 1.2s ease-in-out infinite}
      @keyframes codex-plus-prompt-pulse{50%{opacity:.4}}
      .codex-plus-prompt-draft{padding:8px 10px;border-radius:10px;background:var(--color-token-bg-tertiary,#0002);color:var(--color-token-text-tertiary,inherit);white-space:pre-wrap;word-break:break-word;max-height:96px;overflow:auto}
      .codex-plus-prompt-question{margin:0;font-size:15px;font-weight:500;overflow-wrap:anywhere}
      .codex-plus-prompt-question-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
      .codex-plus-prompt-options{display:flex;flex-direction:column;gap:4px}
      .codex-plus-prompt-option{display:flex;align-items:flex-start;gap:10px;width:100%;padding:9px 8px;border:1px solid transparent;border-radius:9px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
      .codex-plus-prompt-option:hover{background:var(--color-token-interactive-bg-secondary-hover,#8882)}
      .codex-plus-prompt-option.is-selected{border-color:var(--color-token-border-heavy,#8885);background:var(--color-token-interactive-bg-secondary-hover,#fff1)}
      .codex-plus-prompt-option:disabled{opacity:.5;cursor:default}
      .codex-plus-prompt-option-number{display:inline-flex;align-items:center;justify-content:center;flex:none;width:24px;height:24px;border:1px solid var(--color-token-border-heavy,#8885);border-radius:6px;font-size:12px;color:var(--color-token-text-tertiary,inherit)}
      .codex-plus-prompt-option-text{min-width:0;overflow-wrap:anywhere;display:flex;flex-direction:column;gap:1px}
      .codex-plus-prompt-option-text strong{font-weight:500}
      .codex-plus-prompt-option-text small{color:var(--color-token-text-tertiary,inherit)}
      .codex-plus-prompt-badge{display:inline-block;margin-left:6px;padding:0 6px;border-radius:5px;background:var(--color-token-interactive-bg-secondary-hover,#8883);font-size:11px;color:var(--color-token-text-tertiary,inherit)}
      .codex-plus-prompt-answered{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;color:var(--color-token-text-tertiary,inherit);font-size:12px}
      .codex-plus-prompt-answered li{display:flex;gap:6px;min-width:0}
      .codex-plus-prompt-answered li span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .codex-plus-prompt-summary{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8}
      .codex-plus-prompt-input{width:100%;padding:8px 10px;border:1px solid var(--color-token-input-border,#8884);border-radius:9px;background:var(--color-token-bg-tertiary,transparent);color:inherit;font:inherit;outline:none}
      .codex-plus-prompt-input:focus-visible{border-color:var(--color-token-text-tertiary,#888);outline:2px solid currentColor;outline-offset:1px}
      .codex-plus-prompt-result{min-height:220px;max-height:46vh;resize:vertical;font-size:14px;line-height:1.65}
      .codex-plus-prompt-follow{flex:none}
      .codex-plus-prompt-caption{margin:0;color:var(--color-token-text-tertiary,inherit);font-size:12px;overflow-wrap:anywhere}
      .codex-plus-prompt-foot{display:flex;align-items:center;flex-wrap:wrap;gap:6px;flex:none;padding-top:2px}
      .codex-plus-prompt-action,.codex-plus-prompt-icon{height:28px;border:1px solid var(--color-token-border-heavy,#8885);border-radius:8px;background:transparent;color:inherit;font:inherit;cursor:pointer}
      .codex-plus-prompt-action{padding:0 12px;white-space:nowrap}
      .codex-plus-prompt-icon{width:28px;padding:0;display:inline-flex;align-items:center;justify-content:center}
      .codex-plus-prompt-action:hover,.codex-plus-prompt-icon:hover{background:var(--color-token-interactive-bg-secondary-hover,#fff2)}
      .codex-plus-prompt-action.is-primary{background:var(--color-token-text-primary,#eee);color:var(--color-token-bg-primary,#222);border-color:transparent;font-weight:500}
      .codex-plus-prompt-action:disabled,.codex-plus-prompt-icon:disabled{opacity:.45;cursor:default}
      .codex-plus-prompt-icon:focus-visible,.codex-plus-prompt-action:focus-visible,.codex-plus-prompt-option:focus-visible,.codex-plus-prompt-link:focus-visible{outline:2px solid currentColor;outline-offset:2px}
      .codex-plus-prompt-pager{display:inline-flex;align-items:center;gap:6px;color:var(--color-token-text-tertiary,inherit);font-size:12px}
      .codex-plus-prompt-pager button{width:28px}
      .codex-plus-prompt-link{padding:0;border:0;background:transparent;color:inherit;font:inherit;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
      .codex-plus-prompt-link:disabled{opacity:.45;cursor:default}
      .codex-plus-prompt-stale{display:flex;align-items:center;gap:10px;flex:none;padding:8px 10px;border-radius:9px;background:var(--color-token-interactive-bg-secondary-hover,#8882);color:var(--color-token-editor-warning-foreground,#ff8549);font-size:12px}
      .codex-plus-prompt-error-bar{display:flex;align-items:center;gap:10px;flex:none;padding:8px 10px;border-radius:9px;background:color-mix(in srgb,#e5484d 14%,transparent);color:#e5484d;font-size:12px;overflow-wrap:anywhere}
      .codex-plus-prompt-mode-menu{position:fixed;z-index:2147483001;display:flex;flex-direction:column;gap:2px;min-width:136px;padding:4px;border:1px solid var(--color-token-border-heavy,#8885);border-radius:10px;background:var(--color-token-dropdown-background,var(--color-token-main-surface-primary,#2d2d2d));color:var(--color-token-text-primary,#eee)}
      .codex-plus-prompt-mode-menu .codex-plus-prompt-action{display:block;width:100%;text-align:left;border:0;border-radius:6px;padding:7px 10px;height:auto}
      .codex-plus-prompt-mode-menu .codex-plus-prompt-action:hover{background:var(--color-token-interactive-bg-secondary-hover,#8883)}
      .codex-plus-prompt-close-button{font-size:16px;line-height:1}
      .codex-plus-prompt-close{line-height:1}
      @media(prefers-reduced-motion:reduce){.codex-plus-prompt-status.is-loading{animation:none}}
    `;
    document.head.append(style);
    return style;
  }

  function installCodexPlusPromptEnhance() {
    const footers = codexPlusPromptEnhanceFooters();
    installCodexPlusPromptLibrary(footers);
    if (codexPlusPromptEnhance.target) guardCodexPlusPromptEnhance();
    if (!codexPlusPromptEnhanceMasterEnabled()) {
      if (codexPlusPromptEnhance.phase !== "idle") closeCodexPlusPromptEnhance();
      document.querySelectorAll('[data-codex-plus-ext="builtin-prompt-enhance"]').forEach((node) => node.remove());
      document.getElementById("codex-plus-prompt-enhance-style")?.remove();
      return;
    }
    codexPlusPromptEnhanceStyle();
    document.querySelectorAll("[data-prompt-enhance-trigger]").forEach((node) => {
      if (!footers.has(node.closest(".composer-footer, [data-composer-footer-responsive]"))) node.remove();
    });
    if (!codexPlusPromptEnhanceEnabled()) {
      if (codexPlusPromptEnhance.phase !== "idle") closeCodexPlusPromptEnhance();
      document.querySelectorAll("[data-prompt-enhance-trigger]").forEach((node) => node.remove());
      return;
    }
    for (const footer of footers) {
      const host = codexPlusPromptToolsHost(footer);
      const existing = footer.querySelector("[data-prompt-enhance-trigger]");
      if (existing) {
        existing.setAttribute("aria-label", codexPlusPromptEnhanceTriggerLabel());
        existing.title = codexPlusPromptEnhanceTriggerLabel();
        if (existing.parentElement !== host) host.append(existing);
        continue;
      }
      host.append(createCodexPlusPromptEnhanceTrigger());
    }
  }

  const codexPlusPromptEnhanceKeyHandler = (event) => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      // 「其他…」里的 Esc 只收起输入框，交给卡片内部的处理器。
      if (codexPlusPromptEnhance.other !== null && event.target?.closest?.("#codex-plus-prompt-enhance-panel")) return;
      if (codexPlusPromptLibrary.panel) {
        event.preventDefault(); event.stopImmediatePropagation(); closeCodexPlusPromptLibrary(); return;
      }
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
      return;
    }
    // 追问时数字键选择选项，←/→ 切换题目；焦点在输入控件里时不拦截。
    const state = codexPlusPromptEnhance;
    if (state.phase !== "questions" || state.locked || state.other !== null) return;
    const question = state.questions[state.activeQuestion];
    if (!question) return;
    const target = event.target;
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey
        || target?.closest?.("input,textarea,select,[contenteditable=true]")) return;
    const number = Number(event.key);
    if (number >= 1 && number <= question.options.length) {
      pickCodexPlusPromptEnhanceAnswer(question.options[number - 1].label);
      event.preventDefault();
    } else if (number === question.options.length + 1) {
      state.other = "";
      renderCodexPlusPromptEnhance();
      event.preventDefault();
    } else if (event.key === "ArrowRight") {
      advanceCodexPlusPromptEnhance();
      event.preventDefault();
    } else if (event.key === "ArrowLeft" && state.activeQuestion > 0) {
      state.activeQuestion -= 1;
      state.other = null;
      renderCodexPlusPromptEnhance();
      event.preventDefault();
    }
  };
  const codexPlusPromptEnhancePointer = (event) => {
    const target = event.target;
    if (!target.closest?.("[data-prompt-enhance-menu], [data-prompt-enhance-trigger], #codex-plus-prompt-enhance-panel, #codex-plus-prompt-library")) {
      document.querySelectorAll("[data-prompt-enhance-menu]").forEach((menu) => menu.remove());
      if (codexPlusPromptEnhance.phase !== "idle") closeCodexPlusPromptEnhance();
      if (codexPlusPromptLibrary.panel) closeCodexPlusPromptLibrary();
    }
  };
  document.addEventListener("pointerdown", codexPlusPromptEnhancePointer, true);
  const codexPlusPromptEnhanceResize = () => {
    document.querySelectorAll("[data-prompt-enhance-menu]").forEach((menu) => menu.remove());
    const panel = document.getElementById("codex-plus-prompt-enhance-panel");
    if (panel) positionCodexPlusPromptCard(panel);
    if (codexPlusPromptLibrary.panel) positionCodexPlusPromptCard(codexPlusPromptLibrary.panel);
  };
  const codexPlusPromptEnhanceInput = (event) => {
    if (codexPlusPromptEnhance.phase !== "idle" && codexPlusPromptEnhance.target?.editor?.contains?.(event.target)) guardCodexPlusPromptEnhance();
  };
  const codexPlusPromptEnhanceNavigation = () => { if (codexPlusPromptEnhance.phase !== "idle") guardCodexPlusPromptEnhance(); };
  window.addEventListener("popstate", codexPlusPromptEnhanceNavigation);
  window.addEventListener("hashchange", codexPlusPromptEnhanceNavigation);
  document.addEventListener("input", codexPlusPromptEnhanceInput, true);
  document.addEventListener("keydown", codexPlusPromptEnhanceKeyHandler, true);
  window.addEventListener("resize", codexPlusPromptEnhanceResize);
  const codexPlusPromptEnhanceDispose = () => {
    cancelCodexPlusPromptEnhanceRequest();
    ++codexPlusPromptEnhance.revision;
    disposeCodexPlusPromptLibrary();
    codexPlusPromptWorkflows.clear();
    codexPlusPromptLibraries.clear();
    window.removeEventListener("popstate", codexPlusPromptEnhanceNavigation);
    window.removeEventListener("hashchange", codexPlusPromptEnhanceNavigation);
    document.removeEventListener("pointerdown", codexPlusPromptEnhancePointer, true);
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
