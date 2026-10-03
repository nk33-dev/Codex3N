    const localized = codexMenuLocalizationMap.get(normalized);
    if (!localized) return false;
    const next = `${leading}${localized}${trailing}`;
    if (next === original) return false;
    node.nodeValue = next;
    return true;
  }

  function localizeCodexMenuAttributes(root) {
    if (!root?.querySelectorAll) return false;
    let changed = false;
    const selector = "button[aria-label], [role='menuitem'][aria-label], [title], [placeholder]";
    root.querySelectorAll(selector).forEach((element) => {
      if (isExtensionUiNode(element)) return;
      if (element.closest?.("textarea, input, [contenteditable='true'], [data-message-author-role], [data-testid='conversation-turn'], main .prose")) return;
      if (!element.closest?.(codexMenuLocalizationScopeSelector())) return;
      for (const attribute of ["aria-label", "title", "placeholder"]) {
        const value = element.getAttribute(attribute);
        const localized = codexMenuLocalizationMap.get((value || "").replace(/\s+/g, " ").trim());
        if (localized && localized !== value) {
          element.setAttribute(attribute, localized);
          changed = true;
        }
      }
    });
    if (customModels.length && codexModelCatalog.status === "ok") {
      if (sortModelChoices(models, (item) => item.model)) changed = true;
      models.forEach((item, index) => {
        if (item.priority !== index) {
          item.priority = index;
          changed = true;
        }
      });
    }
    return changed;
  }

  function localizeCodexMenus(root = codexMenuLocalizationRoot()) {
    if (!root) return false;
    let changed = false;
    const scopes = [];
    if (root.nodeType === 1 && root.matches?.(codexMenuLocalizationScopeSelector())) scopes.push(root);
    root.querySelectorAll?.(codexMenuLocalizationScopeSelector()).forEach((scope) => scopes.push(scope));
    for (const scope of scopes.slice(0, 80)) {
      if (!(scope instanceof HTMLElement) || isExtensionUiNode(scope)) continue;
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (localizeCodexMenuTextNode(node)) changed = true;
      }
      if (localizeCodexMenuAttributes(scope)) changed = true;
      scope.dataset.codexMenuLocalizationVersion = codexMenuLocalizationVersion;
    }
    return changed;
  }

  async function loadUpstreamBranchDefaults(context) {
    const repoPath = typeof context === "string" ? context : context?.repoPath || "";
    const projectId = typeof context === "string" ? "" : context?.projectId || "";
    if (!repoPath && !projectId) return null;
    const cacheKey = projectId ? `project:${projectId}` : `repo:${repoPath}`;
    const cacheTtlMs = projectId ? upstreamRemoteBranchDefaultsCacheTtlMs : upstreamBranchDefaultsCacheTtlMs;
    const cached = upstreamBranchDefaultsCache.get(cacheKey);
    if (cached && Date.now() - cached.loadedAt < cacheTtlMs) return cached;
    const inflight = upstreamBranchDefaultsInflight.get(cacheKey);
    if (inflight) return inflight;
    const request = postJson("/upstream-worktree/defaults", { repoPath, projectId })
      .then((result) => {
        const entry = { repoPath, projectId, result, loadedAt: Date.now() };
        if (result?.status === "ok") upstreamBranchDefaultsCache.set(cacheKey, entry);
        return entry;
      })
      .finally(() => upstreamBranchDefaultsInflight.delete(cacheKey));
    upstreamBranchDefaultsInflight.set(cacheKey, request);
    return request;
  }

  function renderUpstreamBranchOption(menu, context, ref) {
    const repoPath = context?.repoPath || "";
    const label = ref.label || `${ref.remote || "upstream"}/${ref.branch || "main"}`;
    const item = document.createElement("div");
    item.setAttribute("role", "menuitem");
    item.setAttribute("aria-checked", "false");
    item.setAttribute(upstreamBranchOptionAttribute, "true");
    item.setAttribute("data-repo-path", repoPath);
    item.setAttribute("data-project-id", context?.projectId || "");
    item.setAttribute("data-remote", ref.remote || "upstream");
    item.setAttribute("data-base-branch", ref.branch || "main");
    item.setAttribute("data-label", label);
    item.className = "codex-upstream-branch-option cursor-interaction flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-token-foreground hover:bg-token-list-hover-background";
    item.innerHTML = `${branchIconSvg()}<span class="min-w-0 flex-1 truncate">${escapeHtml(label)}</span>${checkmarkSvg()}`;
    menu.appendChild(item);
  }

  function branchIconSvg() {
    return '<svg aria-hidden="true" data-codex-upstream-branch-icon="true" viewBox="0 0 24 24" class="h-4 w-4 shrink-0 text-token-text-tertiary" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="6" y1="3" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>';
  }

  function checkmarkSvg() {
    return '<svg hidden aria-hidden="true" data-codex-upstream-branch-check="true" viewBox="0 0 24 24" class="h-4 w-4 shrink-0 text-token-text-secondary" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>';
  }

  function branchMenuItems(menu) {
    return [...menu.querySelectorAll('[role="menuitem"], [data-radix-collection-item]')]
      .filter((item) => !item.closest?.(`[${upstreamBranchOptionAttribute}]`));
  }

  function branchMenuItemLabel(menuItem) {
    return normalizedElementText(menuItem);
  }

  function upstreamBranchOptionLabel(option) {
    return option?.getAttribute?.("data-label") || normalizedElementText(option);
  }

  function worktreeBranchMap(defaultsResult) {
    const repoRoot = defaultsResult?.repoRoot || "";
    const entries = Array.isArray(defaultsResult?.worktreeBranches) ? defaultsResult.worktreeBranches : [];
    return new Map(entries
      .filter((entry) => entry?.branch && entry?.path && entry.path !== repoRoot)
      .map((entry) => [entry.branch, entry.path]));
  }

  function annotateBranchMenuWorktreeUsage(menu, defaultsResult) {
    const usedBranches = worktreeBranchMap(defaultsResult);
    for (const item of branchMenuItems(menu)) {
      item.removeAttribute(branchWorktreePathAttribute);
      item.removeAttribute("title");
      const worktreePath = usedBranches.get(branchMenuItemLabel(item));
      if (!worktreePath) continue;
      item.setAttribute(branchWorktreePathAttribute, worktreePath);
      item.setAttribute("title", `该分支已在另一个 worktree 使用：${worktreePath}`);
    }
  }

  function branchWorktreePathFromMenuItem(menuItem) {
    const annotatedPath = menuItem?.getAttribute?.(branchWorktreePathAttribute) || "";
    if (annotatedPath) return annotatedPath;
    const menu = menuItem?.closest?.('[role="menu"], [data-radix-menu-content]');
    const context = currentProjectContextForBranchMenu(menu);
    const cacheKey = context?.projectId ? `project:${context.projectId}` : `repo:${context?.repoPath || ""}`;
    const usedBranches = worktreeBranchMap(upstreamBranchDefaultsCache.get(cacheKey)?.result);
    return usedBranches.get(branchMenuItemLabel(menuItem)) || "";
  }

  function upstreamBranchOptionsMatchRefs(menu, context, refs) {
    const repoPath = context?.repoPath || "";
    const projectId = context?.projectId || "";
    const options = [...menu.querySelectorAll(`[${upstreamBranchOptionAttribute}]`)];
    if (options.length !== refs.length) return false;
    return options.every((option, index) => {
      const ref = refs[index];
      return option.getAttribute("data-repo-path") === repoPath
        && option.getAttribute("data-project-id") === projectId
        && option.getAttribute("data-remote") === (ref.remote || "upstream")
        && option.getAttribute("data-base-branch") === (ref.branch || "main")
        && upstreamBranchOptionLabel(option) === (ref.label || `${ref.remote || "upstream"}/${ref.branch || "main"}`);
    });
  }

  function syncUpstreamBranchMenuSelection(menu) {
    if (!menu) return;
    const selection = readUpstreamBranchSelection();
    for (const option of menu.querySelectorAll(`[${upstreamBranchOptionAttribute}]`)) {
      const selected = !!selection
        && option.getAttribute("data-repo-path") === (selection.repoPath || "")
        && option.getAttribute("data-project-id") === (selection.projectId || "")
        && option.getAttribute("data-remote") === (selection.remote || "upstream")
        && option.getAttribute("data-base-branch") === (selection.baseBranch || "main");
      option.setAttribute("aria-checked", selected ? "true" : "false");
      option.toggleAttribute("data-selected", selected);
      const check = option.querySelector('[data-codex-upstream-branch-check="true"]');
      if (check && selected) check.removeAttribute("hidden");
      if (check && !selected) check.setAttribute("hidden", "");
    }
  }

  function removeUpstreamBranchOptions(scope = document) {
    scope.querySelectorAll(`[${upstreamBranchOptionAttribute}], .codex-upstream-branch-group`)
      .forEach((node) => node.remove());
  }

  function cleanupInvalidUpstreamBranchOptions() {
    for (const menu of nativeBranchMenuCandidates()) {
      if (!menu.querySelector(`[${upstreamBranchOptionAttribute}], .codex-upstream-branch-group`)) continue;
      const trigger = branchMenuTriggerFromMenu(menu);
      if (!looksLikeBranchMenu(menu, trigger) || !branchMenuInNewWorktreeMode(trigger)) {
        removeUpstreamBranchOptions(menu);
      }
    }
  }

  function branchMenuTriggerFromMenu(menu) {
    const labelledBy = menu?.getAttribute?.("aria-labelledby") || "";
    if (labelledBy) {
      const trigger = document.getElementById(labelledBy);
      if (trigger instanceof Element) return trigger;
    }
    return [...document.querySelectorAll('.composer-footer button, .composer-footer [role="button"]')]
      .filter((button) => (button.innerText || button.textContent || "").trim() === "main")
      .sort((left, right) => right.getBoundingClientRect().x - left.getBoundingClientRect().x)[0] || null;
  }

  function branchMenuTriggerIsBranchControl(trigger) {
    const text = normalizedElementText(trigger);
    if (!text || /^(work locally|new worktree|cloud|no environment)$/i.test(text)) return false;
    const rect = effectiveElementRect(trigger);
    const footer = trigger?.closest?.(".composer-footer");
    if (!rect || !footer) return /branch|main|create branch/i.test(text);
    const modeTrigger = [...footer.querySelectorAll('button, [role="button"]')]
      .filter((node) => node !== trigger && visibleElement(node))
      .filter((node) => node.getBoundingClientRect().x < rect.x)
      .sort((left, right) => right.getBoundingClientRect().x - left.getBoundingClientRect().x)
      .find((node) => /^(work locally|new worktree|cloud)$/i.test(normalizedElementText(node)));
    return !!modeTrigger;
  }

  function branchMenuInNewWorktreeMode(trigger) {
    if (!trigger) return newWorktreeModeActive();
    const footer = trigger.closest?.(".composer-footer");
    const scope = footer || trigger.parentElement || document;
    const triggerRect = effectiveElementRect(trigger);
    if (!triggerRect) return false;
    const modeTrigger = [...scope.querySelectorAll('button, [role="button"]')]
      .filter((node) => node !== trigger && visibleElement(node))
      .filter((node) => node.getBoundingClientRect().x < triggerRect.x)
      .sort((left, right) => right.getBoundingClientRect().x - left.getBoundingClientRect().x)
      .find((node) => /worktree|work locally/i.test(normalizedElementText(node)));
    return normalizedElementText(modeTrigger) === "New worktree";
  }

  function branchTriggerLabelNode(trigger) {
    if (!trigger) return null;
    const nodes = [...trigger.querySelectorAll("span, div")]
      .filter((node) => (node.innerText || node.textContent || "").trim());
    return nodes.find((node) => node.classList?.contains("composer-footer__label--sm")) || nodes[0] || trigger;
  }

  function ensureNativeBranchTriggerLabel(trigger) {
    if (!trigger || trigger.querySelector?.('[data-codex-upstream-branch-selection-label="true"]')) return;
    const labelNode = branchTriggerLabelNode(trigger);
    if (!labelNode) return;
    trigger.setAttribute("data-codex-upstream-branch-trigger", "true");
    labelNode.setAttribute("data-codex-native-branch-label", "true");
    const selectionLabel = document.createElement("span");
    selectionLabel.setAttribute("data-codex-upstream-branch-selection-label", "true");
    selectionLabel.className = labelNode.className || "composer-footer__label--sm composer-footer__secondary-label max-w-40 truncate";
    selectionLabel.hidden = true;
    labelNode.insertAdjacentElement("afterend", selectionLabel);
  }

  function clearUpstreamBranchTriggerLabel() {
    document.querySelectorAll('[data-codex-upstream-branch-trigger="true"]').forEach((trigger) => {
      const nativeLabel = trigger.querySelector('[data-codex-native-branch-label="true"]');
      const selectionLabel = trigger.querySelector('[data-codex-upstream-branch-selection-label="true"]');
      if (nativeLabel) nativeLabel.hidden = false;
      if (selectionLabel) selectionLabel.hidden = true;
      trigger.removeAttribute("aria-label");
      trigger.removeAttribute("title");
    });
  }

  function syncUpstreamBranchTriggerLabel() {
    const selection = readUpstreamBranchSelection();
    if (!selection?.label) {
      clearUpstreamBranchTriggerLabel();
      return;
    }
    document.querySelectorAll('[data-codex-upstream-branch-trigger="true"]').forEach((trigger) => {
      const nativeLabel = trigger.querySelector('[data-codex-native-branch-label="true"]');
      const selectionLabel = trigger.querySelector('[data-codex-upstream-branch-selection-label="true"]');
      if (!selectionLabel) return;
      if (nativeLabel) nativeLabel.hidden = true;
      selectionLabel.hidden = false;
      selectionLabel.textContent = selection.label;
      trigger.setAttribute("aria-label", selection.label);
      trigger.setAttribute("title", selection.label);
    });
  }

  function handleNativeBranchSelection(event) {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const menuItem = target?.closest?.('[role="menuitem"], [data-radix-collection-item]');
    if (!menuItem || menuItem.closest?.(`[${upstreamBranchOptionAttribute}]`)) return;
    const menu = menuItem.closest?.('[role="menu"], [data-radix-menu-content]');
    if (!menu || !looksLikeBranchMenu(menu)) return;
    const text = (menuItem.innerText || menuItem.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || /^branches$/i.test(text) || /^upstream$/i.test(text) || text === readUpstreamBranchSelection()?.label) return;
    const usedWorktreePath = branchWorktreePathFromMenuItem(menuItem);
    writeUpstreamBranchSelection(null);
    clearUpstreamBranchTriggerLabel();
    syncUpstreamBranchMenuSelection(menu);
    if (usedWorktreePath) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation?.();
      showToast(`该分支已在另一个 worktree 使用：${usedWorktreePath}`, null);
    }
  }

  async function injectUpstreamBranchOptions() {
    if (!codexPlusSettings().upstreamWorktreeCreate) {
      removeUpstreamBranchOptions();
      return;
    }
    cleanupInvalidUpstreamBranchOptions();
    for (const menu of nativeBranchMenuCandidates()) {
      const trigger = branchMenuTriggerFromMenu(menu);
      if (!looksLikeBranchMenu(menu, trigger)) continue;
      const context = currentProjectContextForBranchMenu(menu, trigger);
      if (!context?.repoPath && !context?.projectId) {
        removeUpstreamBranchOptions(menu);
        continue;
      }
      const defaults = await loadUpstreamBranchDefaults(context);
      const defaultsResult = defaults?.result;
      const refs = defaults?.result?.upstreamRefs || [];
      annotateBranchMenuWorktreeUsage(menu, defaultsResult);
      if (!branchMenuInNewWorktreeMode(trigger)) {
        removeUpstreamBranchOptions(menu);
        writeUpstreamBranchSelection(null);
        clearUpstreamBranchTriggerLabel();
        continue;
      }
      if (!refs.length) {
        removeUpstreamBranchOptions(menu);
        continue;
      }
      const resolvedContext = {
        repoPath: defaults?.repoPath || context.repoPath || defaultsResult?.repoRoot || "",
        projectId: defaults?.projectId || context.projectId || "",
      };
      if (upstreamBranchOptionsMatchRefs(menu, resolvedContext, refs)) {
        syncUpstreamBranchTriggerLabel();
        syncUpstreamBranchMenuSelection(menu);
        continue;
      }
      removeUpstreamBranchOptions(menu);
      ensureNativeBranchTriggerLabel(trigger);
      const group = document.createElement("div");
      group.className = "codex-upstream-branch-group px-2 py-1 text-xs text-token-text-tertiary";
      group.textContent = "Upstream";
      menu.appendChild(group);
      refs.forEach((ref) => renderUpstreamBranchOption(menu, resolvedContext, ref));
      syncUpstreamBranchTriggerLabel();
      syncUpstreamBranchMenuSelection(menu);
    }
  }

  function installUpstreamBranchDropdownAdapter() {
    const adapterVersion = "actual-upstream-refs-v17";
    window.__codexUpstreamBranchDropdownAdapterVersion = adapterVersion;
    if (window.__codexUpstreamBranchDropdownAdapterInstalled === adapterVersion) return;
    window.__codexUpstreamBranchDropdownObserver?.disconnect?.();
    window.__codexUpstreamBranchDropdownAdapterInstalled = adapterVersion;
    let upstreamBranchInjectTimer = null;
    const schedule = () => {
      clearTimeout(upstreamBranchInjectTimer);
      upstreamBranchInjectTimer = setTimeout(() => {
        injectUpstreamBranchOptions().catch((error) => reportDiagnostic("upstream_branch_inject_failed", { error: error?.message || String(error) }));
      }, 80);
    };
    document.addEventListener("click", (event) => {
      rememberStartNewChatProjectContext(event);
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const control = target?.closest?.('button, [role="button"]');
      if (control && branchMenuTriggerIsBranchControl(control)) schedule();
      const option = target?.closest?.(`[${upstreamBranchOptionAttribute}]`);
      if (!option) {
        handleNativeBranchSelection(event);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const selection = {
        repoPath: option.getAttribute("data-repo-path") || "",
        projectId: option.getAttribute("data-project-id") || "",
        remote: option.getAttribute("data-remote") || "upstream",
        baseBranch: option.getAttribute("data-base-branch") || "main",
        label: upstreamBranchOptionLabel(option) || "upstream/main",
      };
      writeUpstreamBranchSelection(selection);
      prepareUpstreamBranchSelection(selection);
      syncUpstreamBranchTriggerLabel();
      syncUpstreamBranchMenuSelection(option.closest?.('[role="menu"], [data-radix-menu-content], [cmdk-list]'));
      showToast(`将从 ${upstreamBranchOptionLabel(option) || "upstream/main"} 创建新 worktree`, null);
    }, true);
    const branchMenuSelector = '[role="menu"], [data-radix-menu-content], [cmdk-list]';
    const addedNodeContainsBranchMenu = (node) => {
      if (!(node instanceof Element)) return false;
      return node.matches(branchMenuSelector) || !!node.querySelector(branchMenuSelector);
    };
    const observer = new MutationObserver((records) => {
      if (records.some((record) => [...record.addedNodes].some(addedNodeContainsBranchMenu))) schedule();
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    window.__codexUpstreamBranchDropdownObserver = observer;
    schedule();
  }

  function upstreamQualifiedSourceRef(selection) {
    if (selection?.qualifiedSourceRef) return selection.qualifiedSourceRef;
    const remote = (selection?.remote || "upstream").trim();
    const baseBranch = (selection?.baseBranch || "main").trim();
    return remote && baseBranch ? `refs/remotes/${remote}/${baseBranch}` : "";
  }

  function prepareUpstreamBranchSelection(selection) {
    if ((!selection?.repoPath && !selection?.projectId) || !selection.remote || !selection.baseBranch) return;
    void postJson("/upstream-worktree/prepare", {
      repoPath: selection.repoPath || "",
      projectId: selection.projectId || "",
      remote: selection.remote,
      baseBranch: selection.baseBranch,
      fetch: true,
    }).then((result) => {
      if (result?.status !== "ok") throw new Error(result?.message || "prepare failed");
      writePreparedUpstreamBranchSelection(selection, result);
    }).catch((error) => {
      sendCodexPlusDiagnostic("upstream_branch_prepare_failed", {
        label: selection.label || "",
        errorName: error?.name || "",
        errorMessage: error?.message || String(error),
      });
    });
  }

  function writePreparedUpstreamBranchSelection(selection, result) {
    const current = readUpstreamBranchSelection();
    if (!upstreamSelectionMatches(current, selection)) return;
    writeUpstreamBranchSelection({
      ...current,
      qualifiedSourceRef: result.qualifiedSourceRef || upstreamQualifiedSourceRef(selection),
      sourceHead: result.sourceHead || "",
      preparedAt: Date.now(),
    });
  }

  function upstreamSelectionMatches(left, right) {
    return !!left && !!right
      && (left.repoPath || "") === (right.repoPath || "")
      && (left.projectId || "") === (right.projectId || "")
      && (left.remote || "upstream") === (right.remote || "upstream")
      && (left.baseBranch || "main") === (right.baseBranch || "main");
  }

  function upstreamWorktreeNativePayloadFromElement(element) {
    const trigger = element?.closest?.("[data-codex-worktree-create], [data-worktree-create]") || element;
    const scopes = [
      trigger,
      trigger?.closest?.("form"),
      trigger?.closest?.("dialog, [role='dialog']"),
    ].filter((scope, index, all) => scope?.querySelector && all.indexOf(scope) === index);
    if (!scopes.length) return null;
    const valueFrom = (selectors) => {
      for (const scope of scopes) {
        for (const selector of selectors) {
          const node = scope.matches?.(selector) ? scope : scope.querySelector(selector);
          const dataAttribute = selector.match(/^\[([a-z0-9-]+)\]$/i)?.[1] || "";
          const value = node?.value || node?.getAttribute?.(dataAttribute) || node?.getAttribute?.("data-value") || node?.textContent || "";
          if (String(value).trim()) return String(value).trim();
        }
      }
      return "";
    };
    const repoPath = valueFrom(["[data-repo-path]", "[name='repoPath']", "[name='repo']"]);
    const branchName = valueFrom(["[data-branch-name]", "[name='branchName']", "[name='branch']"]);
    const worktreePath = valueFrom(["[data-worktree-path]", "[name='worktreePath']", "[name='path']"]);
    const remote = valueFrom(["[data-remote]", "[name='remote']"]) || "upstream";
    const baseBranch = valueFrom(["[data-base-branch]", "[name='baseBranch']", "[name='base']"]) || "main";
    if (!repoPath || !branchName || !worktreePath || !remote || !baseBranch) return null;
    return { repoPath, branchName, worktreePath, remote, baseBranch, fetch: true };
  }

  function upstreamWorktreePayloadFromSelection(trigger) {
    const selection = readUpstreamBranchSelection();
    if ((!selection?.repoPath && !selection?.projectId) || !selection?.remote || !selection?.baseBranch) return null;
    const nativePayload = upstreamWorktreeNativePayloadFromElement(trigger);
    if (!nativePayload?.branchName || !nativePayload?.worktreePath) return null;
    return {
      ...nativePayload,
      repoPath: selection.repoPath,
      projectId: selection.projectId || "",
      remote: selection.remote,
      baseBranch: selection.baseBranch,
      fetch: true,
    };
  }

  async function handleUpstreamWorktreeNativeCreate(event) {
    if (!codexPlusSettings().upstreamWorktreeCreate) return false;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const trigger = target?.closest?.("[data-codex-worktree-create], [data-worktree-create]");
    if (!trigger) return false;
    const payload = upstreamWorktreePayloadFromSelection(trigger) || upstreamWorktreeNativePayloadFromElement(trigger);
    if (!payload) {
      showToast("无法安全识别 Codex 原生 worktree 表单，请使用 Codex++ 菜单创建。", null);
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    try {
      const result = await postJson("/upstream-worktree/create", payload);
      if (result?.status === "ok") {
        writeUpstreamBranchSelection(null);
        syncUpstreamBranchTriggerLabel();
        showToast(`已从 ${result.sourceRef} 创建 worktree`, null);
      } else {
        showToast(result?.message || "创建 upstream worktree 失败", null);
      }
    } catch (error) {
      showToast(error?.message || "创建 upstream worktree 失败", null);
    }
    return true;
  }

  function installUpstreamWorktreeNativeAdapter() {
    const adapterVersion = "2";
    if (window.__codexUpstreamWorktreeNativeAdapterInstalled === adapterVersion) return;
    window.__codexUpstreamWorktreeNativeAdapterInstalled = adapterVersion;
    document.addEventListener("click", (event) => {
      handleUpstreamWorktreeNativeCreate(event);
    }, true);
  }

  function setUpstreamWorktreeMessage(dialog, message, status = "idle") {
    const messageNode = dialog.querySelector("[data-codex-upstream-worktree-message]");
    if (!messageNode) return;
    messageNode.dataset.status = status;
    messageNode.textContent = message || "";
  }

  async function loadUpstreamWorktreeDefaults(dialog) {
    const repoPath = upstreamWorktreeField(dialog, "repoPath")?.value?.trim() || "";
    if (!repoPath) {
      setUpstreamWorktreeMessage(dialog, "填写仓库路径后会自动读取 remote 和当前分支。", "idle");
      return;
    }
    setUpstreamWorktreeMessage(dialog, "正在读取仓库默认值…", "loading");
    try {
      const result = await postJson("/upstream-worktree/defaults", { repoPath });
      if (result?.status !== "ok") {
        setUpstreamWorktreeMessage(dialog, result?.message || "读取仓库默认值失败", "failed");
        return;
      }
      const remote = upstreamWorktreeField(dialog, "remote");
      const baseBranch = upstreamWorktreeField(dialog, "baseBranch");
      if (remote && !remote.value) remote.value = result.defaultRemote || "upstream";
      if (baseBranch && (!baseBranch.value || baseBranch.value === "main")) baseBranch.value = result.defaultBaseBranch || "main";
      setUpstreamWorktreeMessage(dialog, `将从 ${remote?.value || "upstream"}/${baseBranch?.value || "main"} 创建 worktree。`, "ok");
    } catch (error) {
      setUpstreamWorktreeMessage(dialog, error?.message || "读取仓库默认值失败", "failed");
    }
  }

  async function submitUpstreamWorktree(dialog) {
    const payload = upstreamWorktreePayload(dialog);
    if (!payload.repoPath || !payload.branchName || !payload.worktreePath || !payload.remote || !payload.baseBranch) {
      setUpstreamWorktreeMessage(dialog, "仓库路径、分支名、worktree 路径、remote 和 base branch 都必须填写。", "failed");
      return;
    }
    setUpstreamWorktreeMessage(dialog, "正在 fetch 并创建 worktree…", "loading");
    try {
      const result = await postJson("/upstream-worktree/create", payload);
      if (result?.status === "ok") {
        setUpstreamWorktreeMessage(dialog, `已从 ${result.sourceRef} 创建：${result.worktreePath}`, "ok");
        showToast(`已创建 upstream worktree：${result.branchName}`, null);
      } else {
        setUpstreamWorktreeMessage(dialog, result?.message || "创建 upstream worktree 失败", "failed");
      }
    } catch (error) {
      setUpstreamWorktreeMessage(dialog, error?.message || "创建 upstream worktree 失败", "failed");
    }
  }

  function openUpstreamWorktreeDialog() {
    document.querySelectorAll(`.${upstreamWorktreeDialogClass}`).forEach((node) => node.remove());
    const overlay = document.createElement("div");
    overlay.className = `codex-delete-confirm-overlay ${upstreamWorktreeDialogClass}`;
    overlay.innerHTML = `
      <div class="codex-delete-confirm-content" role="dialog" aria-modal="true" aria-label="Create upstream worktree">
        <div class="codex-delete-confirm-title">Create from upstream</div>
        <div class="codex-delete-confirm-message">等价于 git worktree add -b branch path upstream/base。创建前会先 fetch 远端分支。</div>
        <label class="codex-plus-form-field">仓库路径<input data-codex-upstream-worktree-field="repoPath" type="text" placeholder="/path/to/repo"></label>
        <label class="codex-plus-form-field">新分支名<input data-codex-upstream-worktree-field="branchName" type="text" placeholder="feature/my-task"></label>
        <label class="codex-plus-form-field">Worktree 路径<input data-codex-upstream-worktree-field="worktreePath" type="text" placeholder="/path/to/worktrees/my-task"></label>
        <label class="codex-plus-form-field">Remote<input data-codex-upstream-worktree-field="remote" type="text" value="upstream"></label>
        <label class="codex-plus-form-field">Base branch<input data-codex-upstream-worktree-field="baseBranch" type="text" value="main"></label>
        <div class="codex-plus-form-message" data-codex-upstream-worktree-message>填写仓库路径后会自动读取 remote 和当前分支。</div>
        <div class="codex-delete-confirm-actions">
          <button type="button" data-codex-upstream-worktree-cancel="true">取消</button>
          <button type="button" data-codex-upstream-worktree-defaults="true">读取默认值</button>
          <button type="button" data-codex-upstream-worktree-submit="true">Create from upstream</button>
        </div>
      </div>
    `;
    overlay.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      if (event.target === overlay || target?.closest("[data-codex-upstream-worktree-cancel]")) {
        overlay.remove();
        return;
      }
      if (target?.closest("[data-codex-upstream-worktree-defaults]")) {
        loadUpstreamWorktreeDefaults(overlay);
        return;
      }
      if (target?.closest("[data-codex-upstream-worktree-submit]")) {
        submitUpstreamWorktree(overlay);
      }
    }, true);
    upstreamWorktreeField(overlay, "repoPath")?.addEventListener("change", () => loadUpstreamWorktreeDefaults(overlay));
    document.body.appendChild(overlay);
    upstreamWorktreeField(overlay, "repoPath")?.focus();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function confirmDelete(title) {
    document.querySelectorAll(".codex-delete-confirm-overlay").forEach((node) => node.remove());
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "codex-delete-confirm-overlay";
      overlay.innerHTML = `
        <div class="codex-delete-confirm-content" role="dialog" aria-modal="true" aria-label="删除会话">
          <div class="codex-delete-confirm-title">删除会话</div>
          <div class="codex-delete-confirm-message">删除“${escapeHtml(title)}”？</div>
          <div class="codex-delete-confirm-actions">
            <button type="button" data-codex-delete-cancel="true">取消</button>
            <button type="button" data-codex-delete-confirm="true">删除</button>
          </div>
        </div>
      `;
      const finish = (value, event) => {
        event?.preventDefault();
        event?.stopPropagation();
        event?.target?.blur?.();
        overlay.remove();
        resolve(value);
      };
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay || event.target.closest("[data-codex-delete-cancel]")) {
          finish(false, event);
          return;
        }
        if (event.target.closest("[data-codex-delete-confirm]")) {
          finish(true, event);
        }
      }, true);
      overlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") finish(false, event);
      }, true);
      document.body.appendChild(overlay);
      overlay.querySelector("[data-codex-delete-cancel]")?.focus();
    });
  }

  function rowHref(row) {
    return row.getAttribute("href") || row.querySelector("a")?.getAttribute("href") || "";
  }

  function isCurrentSessionRow(row, ref) {
    if (row.getAttribute("aria-current") === "page" || row.getAttribute("aria-current") === "true") return true;
    const href = rowHref(row);
    if (href) {
      try {
        const url = new URL(href, window.location.href);
        if (url.href === window.location.href || url.pathname === window.location.pathname) return true;
      } catch {
        if (window.location.href.includes(href)) return true;
      }
    }
    return !!ref.session_id && window.location.href.includes(ref.session_id);
  }

  function releaseDeleteFocus(row, button) {
    button.blur();
    if (row.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }

  function removeDeletedRow(row, button, ref) {
    releaseDeleteFocus(row, button);
    const shouldReload = isCurrentSessionRow(row, ref);
    row.remove();
    if (shouldReload) {
      setTimeout(() => window.location.reload(), 10000);
    }
  }

  function updateDeleteButtonOffsets() {
    sessionRows().forEach((row) => {
      const hasArchiveConfirm = Array.from(row.querySelectorAll("button")).some((button) => {
        const rect = button.getBoundingClientRect();
        const label = button.getAttribute("aria-label") || "";
        const text = (button.textContent || "").trim();
        if (button.classList.contains(buttonClass) || button.classList.contains(exportButtonClass) || label === "归档对话" || label === "置顶对话") return false;
        return text === "确认" || (text.length > 0 && rect.width > 0 && rect.width <= 36 && rect.x > row.getBoundingClientRect().right - 50);
      });
      row.classList.toggle("codex-archive-confirm-visible", hasArchiveConfirm);
    });
  }

  function openDeleteConfirmForRow(row, button, ref, event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    releaseDeleteFocus(row, button);
    confirmDelete(ref.title).then(async (confirmed) => {
      if (!confirmed) return;
      releaseDeleteFocus(row, button);
      const result = await postJson("/delete", ref);
      if (result.status === "server_deleted" || result.status === "local_deleted") {
        removeDeletedRow(row, button, ref);
        showToast(result.message || "删除成功", result.undo_token);
      } else {
        showToast(result.message || "删除失败", null);
      }
    });
  }

  async function exportMarkdown(ref) {
    const result = await postJson("/export-markdown", ref);
    if (result.status === "exported" && result.filename && typeof result.markdown === "string") {
      const saveResult = await saveMarkdown(result.filename, result.markdown);
      if (saveResult?.status === "cancelled") {
        showToast(saveResult.message || "导出已取消", null);
      } else {
        showToast(result.message || "导出成功", null);
      }
      return;
    }
    showToast(result.message || "导出失败", null);
  }

  function installDeleteButtonEventDelegation() {
    document.removeEventListener("click", window.__codexSessionDeleteDocumentDeleteHandler, true);
    const handler = (event) => {
      const button = event.target?.closest?.(`.${buttonClass}`);
      const row = button?.closest?.("[data-app-action-sidebar-thread-id]");
      if (!button || !row) return;
      const ref = sessionRefFromRow(row);
      if (!ref.session_id) {
        const placeholderId = row.getAttribute("data-app-action-sidebar-thread-id");
        if (isClientNewThreadId(placeholderId)) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation?.();
          showToast("会话仍在同步，请稍后重试", null);
        }
        return;
      }
      openDeleteConfirmForRow(row, button, ref, event);
    };
    window.__codexSessionDeleteDocumentDeleteHandler = handler;
    document.addEventListener("click", handler, true);
  }

  function actionGroupFromRow(row) {
    return row.querySelector(`.${actionGroupClass}`);
  }

  function nativeActionButtonsFromRow(row) {
    return [...row.querySelectorAll('button,[role="button"],a')]
      .filter((node) => !node.closest(`.${actionGroupClass}`))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width < 12 || rect.height < 12) return false;
        const label = [
          node.getAttribute("aria-label"),
          node.getAttribute("title"),
          node.dataset?.state,
          node.textContent,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (/(pin|archive|置顶|归档)/i.test(label)) return true;
        const rowRect = row.getBoundingClientRect();
        return rect.left > rowRect.left + rowRect.width * 0.68;
      });
  }

  function syncActionGroupLayout(row, group) {
    if (!row || !group) return;
    if (group.dataset.codexActionLayoutStable === "true") return;
    const rowRect = row.getBoundingClientRect();
    const nativeButtons = nativeActionButtonsFromRow(row);
    const leftmostNative = nativeButtons
      .map((button) => button.getBoundingClientRect())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .sort((a, b) => a.left - b.left)[0];
    const gap = 8;
    const fallbackRight = 28;
    const right = leftmostNative
      ? Math.max(fallbackRight, Math.round(rowRect.right - leftmostNative.left + gap))
      : fallbackRight;
    const groupWidth = Math.ceil(group.getBoundingClientRect().width || 96);
    const titleNode = row.querySelector(selectors.threadTitle);
    const titleRect = titleNode?.getBoundingClientRect();
    const titleLeft = titleRect?.left || rowRect.left + 40;
