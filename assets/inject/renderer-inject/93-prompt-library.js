  const codexPlusPromptLibrary = { revision: 0, target: null, project: null, panel: null, searchTimer: null, items: [], edit: null, query: "", scope: "available", sort: "recent" };
  registerCodexPlusExtensionSelector('[data-codex-plus-ext="builtin-prompt-library"]');

  async function codexPlusPromptToolsRequest(action, payload = {}) {
    const result = await postJson(`/prompt-enhance/${action}`, payload);
    if (result?.status !== "ok") throw new Error(result?.message || "读取或保存失败，请重试");
    return result;
  }

  async function saveCodexPlusPromptFeedback(panel) {
    const state = codexPlusPromptEnhance;
    if (state.phase !== "result" || !state.metadata || state.feedbackBusy) return;
    const payload = {
      original: state.target.original, generated: state.generated, edited: state.text,
      history: state.history, metadata: state.metadata,
      rating: panel.querySelector("[data-prompt-feedback-rating]")?.value || "useful",
      note: panel.querySelector("[data-prompt-feedback-note]")?.value || "",
    };
    state.feedbackBusy = true;
    const button = panel.querySelector('[data-prompt-enhance-action="feedback"]');
    if (button) button.disabled = true;
    try { await codexPlusPromptToolsRequest("feedback/save", payload); showToast("反馈已保存", null); }
    catch { showToast("反馈保存失败，请重试", null); }
    finally { state.feedbackBusy = false; if (button?.isConnected) button.disabled = false; }
  }

  function codexPlusPromptLibraryElement(tag, text = "") {
    const node = document.createElement(tag); node.textContent = text; return node;
  }

  function codexPlusPromptLibraryButton(label, callback) {
    const button = codexPlusPromptLibraryElement("button", label); button.type = "button";
    button.addEventListener("click", () => { void Promise.resolve().then(callback).catch(() => showToast("读取或保存失败，请重试", null)); });
    return button;
  }

  function closeCodexPlusPromptLibrary() {
    const state = codexPlusPromptLibrary;
    ++state.revision; clearTimeout(state.searchTimer); state.panel?.remove(); state.panel = null;
    if (state.target?.editor?.isConnected) state.target.editor.focus();
    state.target = null; state.edit = null;
  }

  async function codexPlusPromptLibraryProject(target) {
    let timeout;
    return Promise.race([
      codexPlusPromptEnhanceProject(target, true),
      new Promise((resolve) => { timeout = setTimeout(() => resolve({ reason: "未取得项目目录，仅显示全局收藏" }), 2500); }),
    ]).finally(() => clearTimeout(timeout));
  }

  async function openCodexPlusPromptLibrary(footer, seed) {
    if (!codexPlusBackendSettingsLoaded || codexPlusBackendSettings.enhancementsEnabled === false) return;
    closeCodexPlusPromptLibrary();
    const state = codexPlusPromptLibrary, revision = ++state.revision;
    const target = await captureCodexPlusPromptTarget(footer);
    if (revision !== state.revision) return;
    if (!target) { showToast("无法找到可编辑的 Codex 输入框", null); return; }
    state.target = target; state.project = null; state.items = []; state.query = ""; state.scope = "available";
    state.edit = seed === undefined ? null : { title: seed.split("\n")[0].slice(0, 80), body: seed, tags: [], project: null, pinned: false };
    renderCodexPlusPromptLibrary("读取收藏…");
    const identity = await codexPlusPromptLibraryProject(target);
    if (revision !== state.revision || !codexPlusPromptEnhanceTargetAlive(target)) { if (revision === state.revision) closeCodexPlusPromptLibrary(); return; }
    state.project = identity?.reason || !identity?.workingDirectory ? null : { hostId: identity.hostId, workingDirectory: identity.workingDirectory };
    await refreshCodexPlusPromptLibrary();
  }

  async function refreshCodexPlusPromptLibrary() {
    const state = codexPlusPromptLibrary, revision = ++state.revision;
    try {
      const result = await codexPlusPromptToolsRequest("library/list", { project: state.project, query: state.query, scope: state.scope, sort: state.sort });
      if (revision !== state.revision || !state.panel) return;
      state.items = result.favorites; renderCodexPlusPromptLibrary();
    } catch { if (revision === state.revision && state.panel) renderCodexPlusPromptLibrary("读取收藏失败，请重试"); }
  }

  async function useCodexPlusPromptFavorite(item, mode) {
    const state = codexPlusPromptLibrary, target = state.target, revision = state.revision;
    if (state.using) return;
    state.using = true;
    try {
    if (mode === "copy") {
      if (!navigator.clipboard?.writeText) { showToast("请选中正文手动复制", null); return; }
      await navigator.clipboard.writeText(item.body);
    } else {
      if (state.project) {
        const current = await codexPlusPromptLibraryProject(target);
        if (revision !== state.revision || current?.reason || current?.hostId !== state.project.hostId
            || current?.workingDirectory !== state.project.workingDirectory) { showToast("项目已变化，请重新打开收藏库", null); return; }
      }
      if (revision !== state.revision || !codexPlusPromptEnhanceTargetAlive(target)) { showToast("输入框或会话已变化，请复制后手动粘贴", null); return; }
      if (mode === "replace") {
        const blocker = codexPlusPromptEnhanceReplaceBlocker(target);
        if (blocker) { showToast(blocker, null); return; }
      }
      if (!codexPlusPromptEnhanceWrite(target.editor, item.body, mode, target.native)) { showToast("写入失败，请复制后手动粘贴", null); return; }
    }
    try { await codexPlusPromptToolsRequest("library/use", { id: item.id }); }
    catch { showToast("已使用收藏，最近使用时间保存失败", null); }
    if (revision !== state.revision) return;
    if (mode === "copy") showToast("已复制收藏", null);
    else closeCodexPlusPromptLibrary();
    } finally { state.using = false; }
  }

  function renderCodexPlusPromptLibrary(message = "") {
    const state = codexPlusPromptLibrary;
    let panel = state.panel;
    if (!panel) {
      panel = document.createElement("div"); state.panel = panel;
      panel.id = "codex-plus-prompt-library"; panel.dataset.codexPlusExt = "builtin-prompt-library";
      panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "提示词收藏库");
      panel.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        const nodes = [...panel.querySelectorAll("button:not(:disabled),input,textarea,select,summary")].filter((node) => node.checkVisibility() && !node.disabled);
        const first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      });
      document.body.append(panel);
    }
    const searchFocused = panel.querySelector('input[type="search"]') === document.activeElement;
    const selection = searchFocused ? document.activeElement.selectionStart : null;
    panel.replaceChildren();
    const header = codexPlusPromptLibraryElement("div"); header.className = "prompt-library-actions";
    header.append(codexPlusPromptLibraryElement("strong", "提示词收藏库"), codexPlusPromptLibraryButton("关闭", closeCodexPlusPromptLibrary));
    panel.append(header);
    if (message) { const status = codexPlusPromptLibraryElement("p", message); status.setAttribute("role", "status"); panel.append(status); }
    if (!state.project) panel.append(codexPlusPromptLibraryElement("p", "未选择项目，显示全局收藏"));
    if (state.edit) { renderCodexPlusPromptFavoriteEditor(panel); return; }
    const search = document.createElement("input"); search.type = "search"; search.value = state.query;
    search.placeholder = "搜索提示词"; search.setAttribute("aria-label", "搜索收藏");
    const filter = document.createElement("select"); filter.setAttribute("aria-label", "收藏范围");
    for (const [value, label] of [["available", "全部"], ["global", "全局"], ["project", "当前项目"]]) {
      const option = codexPlusPromptLibraryElement("option", label); option.value = value; option.disabled = value === "project" && !state.project; filter.append(option);
    }
    filter.value = state.scope;
    const sort = document.createElement("select"); sort.setAttribute("aria-label", "收藏排序");
    for (const [value, label] of [["recent", "最近使用"], ["updated", "最近修改"]]) { const option = codexPlusPromptLibraryElement("option", label); option.value = value; sort.append(option); }
    sort.value = state.sort;
    const runSearch = () => { clearTimeout(state.searchTimer); state.query = search.value; state.scope = filter.value; state.sort = sort.value; return refreshCodexPlusPromptLibrary(); };
    search.addEventListener("compositionstart", () => clearTimeout(state.searchTimer));
    search.addEventListener("compositionend", () => search.dispatchEvent(new Event("input", { bubbles: true })));
    search.addEventListener("input", (event) => {
      if (event.isComposing) return;
      clearTimeout(state.searchTimer); state.query = search.value; ++state.revision;
      state.searchTimer = setTimeout(() => { void runSearch(); }, 180);
    });
    search.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void runSearch(); } });
    filter.addEventListener("change", () => { void runSearch(); }); sort.addEventListener("change", () => { void runSearch(); });
    const actions = codexPlusPromptLibraryElement("div"); actions.className = "prompt-library-actions";
    actions.append(codexPlusPromptLibraryButton("新建", () => { state.edit = { title: "", body: "", tags: [], project: null, pinned: false }; renderCodexPlusPromptLibrary(); }),
      codexPlusPromptLibraryButton("收藏草稿", () => {
        if (!codexPlusPromptEnhanceTargetAlive(state.target)) { showToast("输入框或会话已变化，请重新打开收藏库", null); return; }
        const draft = codexPlusPromptEnhanceRead(state.target.editor, state.target.native);
        if (!draft?.text.trim()) { showToast("当前草稿为空", null); return; }
        state.edit = { title: draft.text.split("\n")[0].slice(0, 80), body: draft.text, tags: [], project: state.project, pinned: false }; renderCodexPlusPromptLibrary();
      }));
    const filters = document.createElement("details"); filters.className = "prompt-library-filters";
    filters.append(codexPlusPromptLibraryElement("summary", "筛选与排序"));
    const filterFields = codexPlusPromptLibraryElement("div"); filterFields.className = "prompt-library-actions";
    filterFields.append(filter, sort); filters.append(filterFields);
    header.insertBefore(actions, header.lastElementChild);
    actions.className = "prompt-library-header-actions";
    panel.append(search, filters);
    if (!state.items.length) panel.append(codexPlusPromptLibraryElement("p", "没有匹配的收藏，可以新建或收藏当前草稿"));
    for (const item of state.items) {
      const details = document.createElement("details"); details.name = "codex-plus-favorite-preview"; details.className = "prompt-library-record";
      const summary = codexPlusPromptLibraryElement("summary");
      const heading = codexPlusPromptLibraryElement("span", `${item.pinned ? "置顶 · " : ""}${item.title}`); heading.className = "prompt-library-title";
      const scopeLabel = codexPlusPromptLibraryElement("small", item.project ? "项目" : "全局");
      const snippet = codexPlusPromptLibraryElement("span", item.body.replace(/\s+/g, " ")); snippet.className = "prompt-library-snippet";
      summary.append(heading, scopeLabel, snippet); details.append(summary);
      details.append(codexPlusPromptLibraryElement("p", item.tags.join(" · ")), codexPlusPromptLibraryElement("pre", item.body));
      const use = codexPlusPromptLibraryElement("div"); use.className = "prompt-library-actions";
      use.append(codexPlusPromptLibraryButton("复制", () => useCodexPlusPromptFavorite(item, "copy")), codexPlusPromptLibraryButton("插入到末尾", () => useCodexPlusPromptFavorite(item, "append")));
      if (!codexPlusPromptEnhanceReplaceBlocker(state.target)) use.append(codexPlusPromptLibraryButton("替换", () => useCodexPlusPromptFavorite(item, "replace")));
      else details.append(codexPlusPromptLibraryElement("p", codexPlusPromptEnhanceReplaceBlocker(state.target)));
      use.append(codexPlusPromptLibraryButton("编辑", () => { state.edit = { ...item, tags: [...item.tags] }; renderCodexPlusPromptLibrary(); }));
      details.append(use); panel.append(details);
    }
    requestAnimationFrame(() => { if (search.isConnected) { search.focus(); if (selection != null) { try { search.setSelectionRange(selection, selection); } catch {} } } });
  }

  function renderCodexPlusPromptFavoriteEditor(panel) {
    const state = codexPlusPromptLibrary, item = state.edit;
    const field = (label, tag, value) => {
      const wrapper = codexPlusPromptLibraryElement("label", label), input = document.createElement(tag);
      input.value = value; input.setAttribute("aria-label", label); wrapper.append(input); panel.append(wrapper); return input;
    };
    const title = field("标题", "input", item.title); title.maxLength = 200;
    const body = field("正文", "textarea", item.body); body.maxLength = 20000; body.rows = 8;
    const tags = field("标签（逗号分隔）", "input", item.tags.join(", "));
    const scope = field("范围", "select", "");
    for (const [value, label] of [["global", "全局"], ["project", "当前项目"]]) {
      const option = codexPlusPromptLibraryElement("option", label); option.value = value; option.disabled = value === "project" && !state.project && !item.project; scope.append(option);
    }
    scope.value = item.project ? "project" : "global";
    const pinned = field("置顶", "input", ""); pinned.type = "checkbox"; pinned.checked = item.pinned;
    const actions = codexPlusPromptLibraryElement("div"); actions.className = "prompt-library-actions";
    const save = codexPlusPromptLibraryButton("保存收藏", async () => {
      if (!title.value.trim() || !body.value.trim()) { showToast("请填写标题和正文", null); return; }
      const revision = state.revision;
      save.disabled = true;
      try {
        await codexPlusPromptToolsRequest("library/save", { ...item, title: title.value, body: body.value, tags: tags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
          pinned: pinned.checked, project: scope.value === "project" ? item.project || state.project : null });
        if (revision !== state.revision || !panel.isConnected) return;
        state.edit = null; await refreshCodexPlusPromptLibrary(); showToast("收藏已保存", null);
      } finally { if (save.isConnected) save.disabled = false; }
    });
    actions.append(save, codexPlusPromptLibraryButton("返回列表", () => { state.edit = null; renderCodexPlusPromptLibrary(); })); panel.append(actions);
    requestAnimationFrame(() => { if (title.isConnected) title.focus(); });
  }

  function installCodexPlusPromptLibrary(footers) {
    if (!codexPlusBackendSettingsLoaded || codexPlusBackendSettings.enhancementsEnabled === false) { disposeCodexPlusPromptLibrary(); return; }
    if (codexPlusPromptLibrary.target && !codexPlusPromptEnhanceTargetAlive(codexPlusPromptLibrary.target)) closeCodexPlusPromptLibrary();
    if (!document.getElementById("codex-plus-prompt-library-style")) {
      const style = document.createElement("style"); style.id = "codex-plus-prompt-library-style"; style.dataset.codexPlusExt = "builtin-prompt-library";
      style.textContent = `#codex-plus-prompt-library{position:fixed;z-index:2147483002;right:16px;bottom:24px;width:min(420px,calc(100vw - 32px));max-height:min(480px,calc(100vh - 48px));overflow:auto;box-sizing:border-box;padding:12px;border:1px solid var(--color-token-border-heavy,#8885);border-radius:16px;background:var(--color-token-dropdown-background,#2d2d2d);color:var(--color-token-text-primary,#eee);box-shadow:0 12px 32px #0006;font:13px/1.5 system-ui}
        #codex-plus-prompt-library label{display:block;margin:8px 0}#codex-plus-prompt-library input:not([type=checkbox]),#codex-plus-prompt-library textarea{display:block;box-sizing:border-box;width:100%;padding:8px;border-radius:8px}
        #codex-plus-prompt-library input,#codex-plus-prompt-library textarea,#codex-plus-prompt-library select,#codex-plus-prompt-library button,#codex-plus-prompt-enhance-panel select,#codex-plus-prompt-enhance-panel .codex-plus-prompt-feedback input{border:1px solid var(--color-token-border-heavy,#8885);background:var(--color-token-dropdown-background,#2d2d2d);color:inherit;font:inherit;border-radius:8px;padding:6px 10px}
        #codex-plus-prompt-library button,#codex-plus-prompt-library summary{cursor:pointer}#codex-plus-prompt-library :focus-visible,#codex-plus-prompt-enhance-panel select:focus-visible{outline:2px solid currentColor;outline-offset:2px}
        #codex-plus-prompt-library details{border-top:1px solid var(--color-token-border-heavy,#8885);padding:10px 0}#codex-plus-prompt-library pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;max-height:180px;overflow:auto}
        #codex-plus-prompt-library .prompt-library-filters{border:0;padding:0;font-size:12px;color:var(--color-token-text-tertiary,inherit)}
        .prompt-library-record summary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;list-style:none}.prompt-library-record summary::-webkit-details-marker{display:none}
        .prompt-library-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.prompt-library-snippet{grid-column:1/-1;display:block;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;color:var(--color-token-text-tertiary,inherit);font-size:12px}.prompt-library-record[open] .prompt-library-snippet{display:none}.prompt-library-record small{font-size:11px;color:var(--color-token-text-tertiary,inherit)}
        .prompt-library-header-actions{display:flex;gap:4px;align-items:center}#codex-plus-prompt-library .prompt-library-header-actions button{font-size:12px;padding:4px 6px}
        .prompt-library-actions,.codex-plus-prompt-feedback{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:8px 0}.prompt-library-actions strong{margin-right:auto}
        .codex-plus-prompt-library-trigger{background:transparent;border:0;color:inherit;cursor:pointer;width:28px;height:28px;flex-shrink:0;border-radius:8px}.codex-plus-prompt-library-trigger:hover{background:var(--color-token-interactive-bg-secondary-hover,#8883)}.codex-plus-prompt-library-trigger:focus-visible{outline:2px solid currentColor}
        #codex-plus-prompt-library p{color:var(--color-token-text-tertiary,inherit)}#codex-plus-prompt-library button:disabled{opacity:.5;cursor:default}.codex-plus-prompt-feedback input{min-width:0;flex:1}`;
      document.head.append(style);
    }
    document.querySelectorAll("[data-prompt-library-trigger]").forEach((node) => { if (!footers.has(node.closest(".composer-footer, [data-composer-footer-responsive]"))) node.remove(); });
    for (const footer of footers) {
      const host = codexPlusPromptToolsHost(footer);
      const existing = footer.querySelector("[data-prompt-library-trigger]");
      if (existing) { if (existing.parentElement !== host) host.append(existing); continue; }
      const button = document.createElement("button"); button.type = "button"; button.className = "codex-plus-prompt-library-trigger";
      button.dataset.promptLibraryTrigger = "true"; button.dataset.codexPlusExt = "builtin-prompt-library";
      button.setAttribute("aria-label", "提示词收藏库"); button.title = "提示词收藏库";
      // 沿用宿主的图标尺寸，用标准书签图形区分增强入口。
      const svg = codexPlusPromptEnhanceIcon(); svg.replaceChildren();
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "M4 2h8v12l-4-3-4 3V2Z"); svg.append(path); button.append(svg);
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); void openCodexPlusPromptLibrary(footer); }); host.append(button);
    }
  }

  function disposeCodexPlusPromptLibrary() {
    closeCodexPlusPromptLibrary();
    document.querySelectorAll('[data-codex-plus-ext="builtin-prompt-library"]').forEach((node) => node.remove());
  }
