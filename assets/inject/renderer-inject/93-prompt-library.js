  // 常用提示词：浮在输入框上方，点一条就追加；拖动手柄调整顺序，删除可从提示条撤销。
  const codexPlusPromptLibrary = {
    revision: 0, target: null, project: null, panel: null, searchTimer: null,
    items: [], tags: [], total: 0, edit: null, query: "", scope: "available", tag: "", limit: 50,
    returnToEnhance: null, cacheKey: "", loading: false, message: "", error: "", editId: "",
    dragging: null, over: null,
  };
  const codexPlusPromptLibraries = new Map();
  registerCodexPlusExtensionSelector('[data-codex-plus-ext="builtin-prompt-library"]');

  async function codexPlusPromptToolsRequest(action, payload = {}) {
    const result = await postJson(`/prompt-enhance/${action}`, payload);
    if (result?.status !== "ok") throw new Error(result?.message || "读取或保存失败，请重试");
    return result;
  }

  function codexPlusPromptLibraryNode(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function codexPlusPromptLibraryButton(label, className = "") {
    const button = codexPlusPromptLibraryNode("button", className, label);
    button.type = "button";
    return button;
  }

  function closeCodexPlusPromptLibrary(restore = true) {
    const state = codexPlusPromptLibrary;
    const back = state.returnToEnhance;
    state.returnToEnhance = null;
    if (state.cacheKey && state.panel) codexPlusPromptLibraries.set(state.cacheKey, {
      edit: state.edit, query: state.query, scope: state.scope, tag: state.tag, limit: state.limit,
    });
    ++state.revision;
    clearTimeout(state.searchTimer);
    state.panel?.promptObserver?.disconnect();
    state.panel?.remove();
    state.panel = null;
    state.edit = null;
    state.editId = "";
    state.dragging = null;
    state.over = null;
    state.error = "";
    state.message = "";
    if (state.target?.editor?.isConnected) state.target.editor.focus();
    state.target = null;
    if (restore && back?.footer?.isConnected) void startCodexPlusPromptEnhance(back.footer, back.mode);
  }

  async function codexPlusPromptLibraryProject(target) {
    let timeout;
    return Promise.race([
      codexPlusPromptEnhanceProject(target, true),
      new Promise((resolve) => { timeout = setTimeout(() => resolve({ reason: "未取得项目目录，仅显示通用收藏" }), 2500); }),
    ]).finally(() => clearTimeout(timeout));
  }

  async function openCodexPlusPromptLibrary(footer, options = {}) {
    if (!codexPlusPromptFavoritesEnabled()) return;
    const seed = options.seed;
    const editId = options.editId || "";
    const keepEnhance = (seed !== undefined || editId) && codexPlusPromptEnhance.phase !== "idle";
    closeCodexPlusPromptLibrary(false);
    const back = keepEnhance ? { footer: codexPlusPromptEnhance.target?.footer, mode: codexPlusPromptEnhance.mode } : null;
    if (codexPlusPromptEnhance.phase !== "idle") closeCodexPlusPromptEnhance();
    const state = codexPlusPromptLibrary, revision = ++state.revision;
    const target = await captureCodexPlusPromptTarget(footer);
    if (revision !== state.revision) return;
    if (!target) { showToast("无法找到可编辑的 Codex 输入框", null); return; }
    state.cacheKey = JSON.stringify([target.href, target.location?.sessionId || "", target.location?.hostId || "", target.location?.workingDirectory || ""]);
    const saved = codexPlusPromptLibraries.get(state.cacheKey);
    Object.assign(state, {
      target, project: null, items: [], tags: [], total: 0, query: "", scope: "available", tag: "",
      limit: 50, returnToEnhance: back, loading: true, message: "", error: "", editId,
    }, saved || {});
    if (seed !== undefined) state.edit = {
      id: "", title: seed.trim().split("\n")[0].slice(0, 80), body: seed, tags: [], project: null,
    };
    else if (!editId) state.edit = saved?.edit || null;
    renderCodexPlusPromptLibrary();
    const identity = await codexPlusPromptLibraryProject(target);
    if (revision !== state.revision || !codexPlusPromptEnhanceTargetAlive(target)) {
      if (revision === state.revision) closeCodexPlusPromptLibrary();
      return;
    }
    state.project = identity?.reason || !identity?.workingDirectory
      ? null : { hostId: identity.hostId, workingDirectory: identity.workingDirectory };
    await refreshCodexPlusPromptLibrary();
  }

  async function refreshCodexPlusPromptLibrary() {
    const state = codexPlusPromptLibrary, revision = ++state.revision;
    state.loading = true;
    renderCodexPlusPromptLibrary();
    try {
      const result = await codexPlusPromptToolsRequest("library/list", {
        project: state.project, query: state.query,
        scope: state.scope === "all" ? "available" : state.scope,
        tag: state.tag, sort: "manual", limit: state.limit,
      });
      if (revision !== state.revision || !state.panel) return;
      state.items = result.favorites || [];
      state.tags = result.tags || [];
      state.total = result.total ?? state.items.length;
      state.loading = false;
      state.error = "";
      if (state.editId) {
        const item = state.items.find((value) => value.id === state.editId);
        state.editId = "";
        if (item) state.edit = { ...item, tags: [...item.tags] };
      }
      renderCodexPlusPromptLibrary();
    } catch (error) {
      if (revision !== state.revision || !state.panel) return;
      state.loading = false;
      state.error = error?.message || "读取收藏失败，请重试";
      renderCodexPlusPromptLibrary();
    }
  }

  async function useCodexPlusPromptFavorite(item, mode) {
    const state = codexPlusPromptLibrary, target = state.target, revision = state.revision;
    if (state.using) return;
    state.using = true;
    try {
      if (mode === "copy") {
        if (!navigator.clipboard?.writeText) { showToast("请选中正文手动复制", null); return; }
        await navigator.clipboard.writeText(item.body);
        showToast("已复制收藏", null);
        return;
      }
      if (state.project) {
        const current = await codexPlusPromptLibraryProject(target);
        if (revision !== state.revision || current?.reason || current?.hostId !== state.project.hostId
            || current?.workingDirectory !== state.project.workingDirectory) { showToast("项目已变化，请重新打开常用提示词", null); return; }
      }
      if (revision !== state.revision || !codexPlusPromptEnhanceTargetAlive(target)) { showToast("输入框或会话已变化，请复制后手动粘贴", null); return; }
      if (mode === "replace") {
        const blocker = codexPlusPromptEnhanceReplaceBlocker(target);
        if (blocker) { showToast(blocker, null); return; }
      }
      if (!codexPlusPromptEnhanceWrite(target.editor, item.body, mode, target.native)) { showToast("写入失败，请复制后手动粘贴", null); return; }
      try { await codexPlusPromptToolsRequest("library/use", { id: item.id }); }
      catch { showToast("已使用收藏，最近使用时间保存失败", null); }
      if (revision !== state.revision) return;
      closeCodexPlusPromptLibrary();
      codexPlusPromptEnhanceNotifyWrite(target, mode, target.original);
    } finally { state.using = false; }
  }

  async function removeCodexPlusPromptFavorite(item) {
    try {
      const removed = await codexPlusPromptToolsRequest("library/delete", { id: item.id });
      await refreshCodexPlusPromptLibrary();
      showToast(`已删除“${item.title}”`, { action: {
        label: "撤销",
        run: () => {
          void codexPlusPromptToolsRequest("library/restore", {
            favorite: removed.favorite, index: removed.index,
          }).then(() => refreshCodexPlusPromptLibrary())
            .catch(() => showToast("恢复失败，请重试", null));
        },
      } });
    } catch (error) {
      showToast(error?.message || "删除失败，请重试", null);
    }
  }

  async function saveCodexPlusPromptDraft() {
    const state = codexPlusPromptLibrary;
    if (!codexPlusPromptEnhanceTargetAlive(state.target)) { showToast("输入框或会话已变化，请重新打开", null); return; }
    const draft = codexPlusPromptEnhanceRead(state.target.editor, state.target.native);
    if (!draft?.text.trim()) { showToast("当前输入为空", null); return; }
    try {
      const result = await codexPlusPromptToolsRequest("library/add", {
        body: draft.text, project: state.project,
      });
      state.editId = result.favorite?.id || "";
      await refreshCodexPlusPromptLibrary();
      showToast("已存为常用", { action: {
        label: "编辑",
        run: () => {
          const item = state.items.find((value) => value.id === result.favorite?.id);
          if (!item) return;
          state.edit = { ...item, tags: [...item.tags] };
          renderCodexPlusPromptLibrary();
        },
      } });
    } catch (error) {
      showToast(error?.message || "保存失败，请重试", null);
    }
  }

  async function saveCodexPlusPromptEdit() {
    const state = codexPlusPromptLibrary, item = state.edit;
    if (!item || !item.body.trim()) { showToast("请填写正文", null); return; }
    try {
      await codexPlusPromptToolsRequest("library/save", {
        id: item.id, title: item.title.trim() || item.body.trim().split("\n")[0].slice(0, 80),
        body: item.body, tags: item.tags,
        project: item.project,
      });
      state.edit = null;
      await refreshCodexPlusPromptLibrary();
      showToast("已保存", null);
    } catch (error) {
      showToast(error?.message || "保存失败，请重试", null);
    }
  }

  async function moveCodexPlusPromptFavorite(id, targetId) {
    const state = codexPlusPromptLibrary;
    if (!id || id === targetId) return;
    const next = [...state.items];
    const from = next.findIndex((item) => item.id === id);
    const to = next.findIndex((item) => item.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    state.items = next;
    renderCodexPlusPromptLibrary();
    try {
      await codexPlusPromptToolsRequest("library/reorder", { ids: next.map((item) => item.id) });
    } catch (error) {
      showToast(error?.message || "调整顺序失败，请重试", null);
    }
    await refreshCodexPlusPromptLibrary();
  }

  function renderCodexPlusPromptLibrary() {
    const state = codexPlusPromptLibrary;
    if (!state.target) return;
    let panel = state.panel;
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "codex-plus-prompt-library";
      panel.dataset.codexPlusExt = "builtin-prompt-library";
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "常用提示词");
      panel.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        const nodes = [...panel.querySelectorAll("button:not(:disabled),input,textarea,select,summary")].filter((node) => node.checkVisibility());
        const first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      });
      state.panel = panel;
      document.body.append(panel);
    }
    positionCodexPlusPromptCard(panel);
    const search = panel.querySelector('input[type="search"]');
    const searchFocused = search === document.activeElement;
    const caret = searchFocused ? search.selectionStart : null;
    panel.replaceChildren();
    const header = codexPlusPromptLibraryNode("header", "codex-plus-prompt-head");
    header.append(codexPlusPromptLibraryNode("h2", "", "常用提示词"));
    if (!state.edit) header.append(codexPlusPromptLibraryNode("span", "codex-plus-prompt-meta", "点一条追加到输入框"));
    const close = codexPlusPromptIconButton("trash", "关闭", "library-close");
    close.replaceChildren(codexPlusPromptLibraryNode("span", "codex-plus-prompt-close", "×"));
    close.className = "codex-plus-prompt-icon codex-plus-prompt-close-button";
    delete close.dataset.promptEnhanceAction;
    close.addEventListener("click", () => closeCodexPlusPromptLibrary());
    header.append(codexPlusPromptLibraryNode("span", "codex-plus-prompt-grow"), close);
    panel.append(header);
    if (state.edit) {
      renderCodexPlusPromptFavoriteEditor(panel);
      return;
    }
    const body = codexPlusPromptLibraryNode("div", "codex-plus-prompt-body");
    const searchInput = document.createElement("input");
    searchInput.className = "codex-plus-prompt-input";
    searchInput.type = "search";
    searchInput.placeholder = "搜索";
    searchInput.setAttribute("aria-label", "搜索");
    searchInput.value = state.query;
    searchInput.addEventListener("compositionstart", () => clearTimeout(state.searchTimer));
    searchInput.addEventListener("compositionend", () => searchInput.dispatchEvent(new Event("input", { bubbles: true })));
    searchInput.addEventListener("input", (event) => {
      if (event.isComposing) return;
      clearTimeout(state.searchTimer);
      state.query = searchInput.value;
      state.searchTimer = setTimeout(() => { void refreshCodexPlusPromptLibrary(); }, 180);
    });
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void refreshCodexPlusPromptLibrary(); }
    });
    body.append(searchInput);
    const chips = codexPlusPromptLibraryNode("div", "codex-plus-prompt-chips");
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", "筛选");
    const filters = ["all", "project", "global", ...state.tags];
    for (const value of filters) {
      const label = value === "all" ? "全部" : value === "project" ? "本项目" : value === "global" ? "通用" : value;
      const chip = codexPlusPromptLibraryButton(label, "codex-plus-prompt-chip");
      chip.setAttribute("aria-pressed", String(state.scope === value || state.tag === value));
      chip.addEventListener("click", () => {
        if (value === "all" || value === "project" || value === "global") { state.scope = value; state.tag = ""; }
        else { state.scope = "all"; state.tag = value; }
        state.limit = 50;
        void refreshCodexPlusPromptLibrary();
      });
      chips.append(chip);
    }
    body.append(chips);
    if (state.loading && !state.items.length) body.append(codexPlusPromptLibraryNode("p", "codex-plus-prompt-caption", "正在读取…"));
    if (!state.loading && !state.items.length) {
      const empty = codexPlusPromptLibraryNode("div", "codex-plus-prompt-empty");
      const filtered = state.query || state.tag || !["all", "available"].includes(state.scope);
      empty.append(codexPlusPromptLibraryNode("p", "codex-plus-prompt-caption", filtered ? "没有找到提示词" : "还没有常用提示词"));
      if (filtered) {
        const clear = codexPlusPromptLibraryButton("清除筛选", "codex-plus-prompt-action");
        clear.addEventListener("click", () => { state.query = ""; state.tag = ""; state.scope = "all"; void refreshCodexPlusPromptLibrary(); });
        empty.append(clear);
      }
      body.append(empty);
    }
    if (state.items.length) {
      const list = codexPlusPromptLibraryNode("ul", "codex-plus-prompt-list");
      list.setAttribute("aria-label", "常用提示词");
      state.items.forEach((item, index) => {
        const row = codexPlusPromptLibraryNode("li", "codex-plus-prompt-row");
        row.dataset.dragging = String(state.dragging === item.id);
        row.dataset.over = String(state.over === item.id && state.dragging !== item.id);
        const grip = codexPlusPromptLibraryNode("button", "codex-plus-prompt-grip");
        grip.type = "button";
        grip.draggable = true;
        grip.title = "拖动排序";
        grip.setAttribute("aria-label", `拖动排序：${item.title}`);
        grip.append(codexPlusPromptIcon("grip"));
        grip.addEventListener("dragstart", (event) => {
          event.dataTransfer?.setData("text/plain", item.id);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          state.dragging = item.id;
        });
        grip.addEventListener("dragend", () => { state.dragging = null; state.over = null; renderCodexPlusPromptLibrary(); });
        grip.addEventListener("keydown", (event) => {
          const target = event.key === "ArrowUp" ? state.items[index - 1]
            : event.key === "ArrowDown" ? state.items[index + 1] : null;
          if (!target) return;
          event.preventDefault();
          void moveCodexPlusPromptFavorite(item.id, target.id);
        });
        row.addEventListener("dragover", (event) => {
          if (!state.dragging) return;
          event.preventDefault();
          state.over = item.id;
          row.dataset.over = String(state.dragging !== item.id);
        });
        row.addEventListener("dragleave", () => { if (state.over === item.id) state.over = null; });
        row.addEventListener("drop", (event) => {
          event.preventDefault();
          const id = state.dragging;
          state.dragging = null;
          state.over = null;
          if (id) void moveCodexPlusPromptFavorite(id, item.id);
        });
        const main = codexPlusPromptLibraryNode("button", "codex-plus-prompt-row-main");
        main.type = "button";
        main.title = "追加到输入框";
        const titleRow = codexPlusPromptLibraryNode("span", "codex-plus-prompt-row-title");
        titleRow.append(codexPlusPromptLibraryNode("strong", "", item.title));
        for (const tag of item.tags) titleRow.append(codexPlusPromptLibraryNode("span", "codex-plus-prompt-pill", tag));
        if (item.project && item.project.workingDirectory !== state.project?.workingDirectory) {
          const pill = codexPlusPromptLibraryNode("span", "codex-plus-prompt-pill", item.project.workingDirectory.split(/[\\/]/).filter(Boolean).at(-1) || "");
          pill.title = item.project.workingDirectory;
          titleRow.append(pill);
        }
        main.append(titleRow, codexPlusPromptLibraryNode("small", "", item.body.replace(/\s+/g, " ").slice(0, 160)));
        main.addEventListener("click", () => void useCodexPlusPromptFavorite(item, "append"));
        const actions = codexPlusPromptLibraryNode("span", "codex-plus-prompt-row-actions");
        const replace = codexPlusPromptLibraryNode("button", "codex-plus-prompt-icon");
        replace.type = "button"; replace.title = "替换"; replace.setAttribute("aria-label", "替换");
        replace.append(codexPlusPromptIcon("swap"));
        replace.addEventListener("click", () => void useCodexPlusPromptFavorite(item, "replace"));
        const copy = codexPlusPromptLibraryNode("button", "codex-plus-prompt-icon");
        copy.type = "button"; copy.title = "复制"; copy.setAttribute("aria-label", "复制");
        copy.append(codexPlusPromptIcon("copy"));
        copy.addEventListener("click", () => void useCodexPlusPromptFavorite(item, "copy"));
        const edit = codexPlusPromptLibraryNode("button", "codex-plus-prompt-icon");
        edit.type = "button"; edit.title = "编辑"; edit.setAttribute("aria-label", "编辑");
        edit.append(codexPlusPromptIcon("pencil"));
        edit.addEventListener("click", () => { state.edit = { ...item, tags: [...item.tags] }; renderCodexPlusPromptLibrary(); });
        const remove = codexPlusPromptLibraryNode("button", "codex-plus-prompt-icon");
        remove.type = "button"; remove.title = "删除"; remove.setAttribute("aria-label", "删除");
        remove.append(codexPlusPromptIcon("trash"));
        remove.addEventListener("click", () => void removeCodexPlusPromptFavorite(item));
        actions.append(replace, copy, edit, remove);
        row.append(grip, main, actions);
        list.append(row);
      });
      body.append(list);
      if (state.total > state.items.length) {
        const more = codexPlusPromptLibraryButton(`显示更多（${state.items.length}/${state.total}）`, "codex-plus-prompt-action");
        more.addEventListener("click", () => { state.limit = Math.min(state.limit + 50, 5000); void refreshCodexPlusPromptLibrary(); });
        body.append(more);
      }
    }
    panel.append(body);
    if (state.error) {
      const error = codexPlusPromptLibraryNode("div", "codex-plus-prompt-error-bar", state.error);
      error.setAttribute("role", "alert");
      panel.append(error);
    }
    const footer = codexPlusPromptLibraryNode("footer", "codex-plus-prompt-foot");
    const save = codexPlusPromptLibraryButton("存当前输入", "codex-plus-prompt-action");
    save.disabled = !codexPlusPromptEnhanceDraftOf(state.target?.footer);
    save.title = save.disabled ? "先在输入框里写点内容" : "";
    save.addEventListener("click", () => void saveCodexPlusPromptDraft());
    footer.append(save, codexPlusPromptLibraryNode("span", "codex-plus-prompt-grow"));
    if (state.items.length > 1) footer.append(codexPlusPromptLibraryNode("span", "codex-plus-prompt-caption", "拖动 ⠿ 调整顺序"));
    panel.append(footer);
    requestAnimationFrame(() => {
      if (!searchInput.isConnected) return;
      if (searchFocused) {
        searchInput.focus();
        if (caret != null) { try { searchInput.setSelectionRange(caret, caret); } catch {} }
      }
    });
  }

  function renderCodexPlusPromptFavoriteEditor(panel) {
    const state = codexPlusPromptLibrary, item = state.edit;
    const body = codexPlusPromptLibraryNode("div", "codex-plus-prompt-body codex-plus-prompt-edit");
    const field = (label, tag, value, options = {}) => {
      const wrapper = codexPlusPromptLibraryNode("label", "codex-plus-prompt-field");
      wrapper.append(codexPlusPromptLibraryNode("span", "", label));
      const input = document.createElement(tag);
      input.className = "codex-plus-prompt-input";
      input.value = value;
      if (options.maxLength) input.maxLength = options.maxLength;
      if (options.rows) input.rows = options.rows;
      if (options.placeholder) input.placeholder = options.placeholder;
      wrapper.append(input);
      body.append(wrapper);
      return input;
    };
    const title = field("标题", "input", item.title, { maxLength: 200 });
    const text = field("内容", "textarea", item.body, { maxLength: 20000, rows: 7 });
    const tags = field("标签", "input", item.tags.join("，"), { placeholder: "用逗号分隔，如：修 bug，审查" });
    const scope = codexPlusPromptLibraryNode("label", "codex-plus-prompt-field codex-plus-prompt-check");
    const all = document.createElement("input");
    all.type = "checkbox";
    all.checked = !item.project;
    all.disabled = !item.project && !state.project;
    all.addEventListener("change", () => { item.project = all.checked ? null : (item.project || state.project); });
    scope.append(all, codexPlusPromptLibraryNode("span", "", "所有项目都能用"));
    body.append(scope);
    title.addEventListener("input", () => { item.title = title.value; });
    text.addEventListener("input", () => { item.body = text.value; });
    tags.addEventListener("input", () => {
      item.tags = tags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    });
    panel.append(body);
    if (state.error) {
      const error = codexPlusPromptLibraryNode("div", "codex-plus-prompt-error-bar", state.error);
      error.setAttribute("role", "alert");
      panel.append(error);
    }
    const footer = codexPlusPromptLibraryNode("footer", "codex-plus-prompt-foot");
    const cancel = codexPlusPromptLibraryButton("取消", "codex-plus-prompt-action");
    cancel.addEventListener("click", () => { state.edit = null; renderCodexPlusPromptLibrary(); });
    footer.append(codexPlusPromptLibraryNode("span", "codex-plus-prompt-grow"), cancel);
    const save = codexPlusPromptLibraryButton("保存", "codex-plus-prompt-action is-primary");
    save.disabled = !item.body.trim();
    save.addEventListener("click", () => void saveCodexPlusPromptEdit());
    footer.append(save);
    panel.append(footer);
    requestAnimationFrame(() => { if (title.isConnected) title.focus(); });
  }

  function installCodexPlusPromptLibrary(footers) {
    if (!codexPlusPromptFavoritesEnabled()) {
      if (codexPlusPromptLibrary.panel) closeCodexPlusPromptLibrary(false);
      document.querySelectorAll('[data-codex-plus-ext="builtin-prompt-library"]').forEach((node) => node.remove());
      document.getElementById("codex-plus-prompt-library-style")?.remove();
      return;
    }
    if (!document.getElementById("codex-plus-prompt-library-style")) {
      const style = document.createElement("style");
      style.id = "codex-plus-prompt-library-style";
      style.dataset.codexPlusExt = "builtin-prompt-library";
      style.textContent = `
        .codex-plus-prompt-chips{display:flex;flex-wrap:wrap;gap:4px}
        .codex-plus-prompt-chip{padding:2px 9px;border:1px solid var(--color-token-border-heavy,#8885);border-radius:999px;background:transparent;color:var(--color-token-text-tertiary,inherit);font:inherit;font-size:12px;cursor:pointer}
        .codex-plus-prompt-chip:hover{color:var(--color-token-text-primary,inherit)}
        .codex-plus-prompt-chip[aria-pressed="true"]{color:var(--color-token-text-primary,inherit);background:var(--color-token-interactive-bg-secondary-hover,#8882);border-color:transparent}
        .codex-plus-prompt-chip:focus-visible{outline:2px solid currentColor;outline-offset:1px}
        .codex-plus-prompt-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px}
        .codex-plus-prompt-row{display:flex;align-items:center;gap:2px;border-radius:9px;padding:1px}
        .codex-plus-prompt-row:hover,.codex-plus-prompt-row:focus-within{background:var(--color-token-interactive-bg-secondary-hover,#8882)}
        .codex-plus-prompt-row[data-dragging="true"]{opacity:.5}
        .codex-plus-prompt-row[data-over="true"]{box-shadow:inset 0 2px 0 var(--color-token-text-tertiary,#888)}
        .codex-plus-prompt-grip{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:32px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--color-token-text-tertiary,inherit);cursor:grab;opacity:0}
        .codex-plus-prompt-row:hover .codex-plus-prompt-grip,.codex-plus-prompt-row:focus-within .codex-plus-prompt-grip{opacity:.7}
        .codex-plus-prompt-grip:focus-visible{outline:2px solid currentColor;outline-offset:1px;opacity:1}
        .codex-plus-prompt-row-main{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0;padding:6px 4px;border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
        .codex-plus-prompt-row-title{display:flex;align-items:center;gap:6px;min-width:0}
        .codex-plus-prompt-row-title strong{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .codex-plus-prompt-row-main small{color:var(--color-token-text-tertiary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .codex-plus-prompt-pill{flex:none;padding:0 6px;border-radius:5px;background:var(--color-token-interactive-bg-secondary-hover,#8882);font-size:11px;color:var(--color-token-text-tertiary,inherit)}
        .codex-plus-prompt-row-actions{display:flex;gap:1px;flex:none;opacity:0}
        .codex-plus-prompt-row:hover .codex-plus-prompt-row-actions,.codex-plus-prompt-row:focus-within .codex-plus-prompt-row-actions{opacity:1}
        .codex-plus-prompt-row-actions .codex-plus-prompt-icon{width:26px;height:26px;border:0}
        .codex-plus-prompt-empty{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px 2px}
        .codex-plus-prompt-empty p{margin:0}
        .codex-plus-prompt-field{display:flex;flex-direction:column;gap:4px;color:var(--color-token-text-tertiary,inherit);font-size:12px}
        .codex-plus-prompt-field .codex-plus-prompt-input{color:var(--color-token-text-primary,inherit);font-size:13px}
        .codex-plus-prompt-field textarea.codex-plus-prompt-input{resize:vertical;line-height:1.6}
        .codex-plus-prompt-check{flex-direction:row;align-items:center;gap:6px;font-size:13px;color:var(--color-token-text-primary,inherit)}
      `;
      document.head.append(style);
    }
    document.querySelectorAll("[data-prompt-library-trigger]").forEach((node) => {
      if (!footers.has(node.closest(".composer-footer, [data-composer-footer-responsive]"))) node.remove();
    });
    for (const footer of footers) {
      const host = codexPlusPromptToolsHost(footer);
      const existing = footer.querySelector("[data-prompt-library-trigger]");
      if (existing) { if (existing.parentElement !== host) host.append(existing); continue; }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "codex-plus-prompt-library-trigger";
      button.dataset.promptLibraryTrigger = "true";
      button.dataset.codexPlusExt = "builtin-prompt-library";
      button.setAttribute("aria-label", "常用提示词");
      button.title = "常用提示词";
      button.append(codexPlusPromptIcon("bookmark"));
      button.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        if (codexPlusPromptLibrary.panel) codexPlusPromptLibrary.suppressTriggerClick = true;
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (codexPlusPromptLibrary.suppressTriggerClick) {
          codexPlusPromptLibrary.suppressTriggerClick = false;
          return;
        }
        void openCodexPlusPromptLibrary(footer);
      });
      host.append(button);
    }
  }

  function disposeCodexPlusPromptLibrary() {
    closeCodexPlusPromptLibrary(false);
    codexPlusPromptLibraries.clear();
    document.querySelectorAll('[data-codex-plus-ext="builtin-prompt-library"]').forEach((node) => node.remove());
  }
