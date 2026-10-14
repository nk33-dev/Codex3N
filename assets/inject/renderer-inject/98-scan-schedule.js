  /**
   * 这个节点是不是 Codex++ 自己（或拓展）的 UI。
   *
   * 内置选择器写在这里；拓展通过注册中心登记的选择器走 isCodexPlusExtensionNode，
   * 那边已把选择器合并成一个串并在 Set 变化时重建缓存，所以这里每次调用只多一次
   * closest()，不会因为拓展数量增长而线性变慢。
   */
  function isExtensionUiNode(node) {
    if (!node?.closest) return false;
    if (node.closest(`[data-codex-plus-ext], .codex-delete-toast, .codex-delete-confirm-overlay, .codex-plus-modal-overlay, .${codexPlusPageClass}, #${codexPlusSidebarNavId}, #${codexPlusRailNavId}, #${codexPlusRailExtensionsId}, #${codexPlusRailSponsorId}, #${codexPlusRailNavId} > button, #${codexPlusRailExtensionsId} > button, #${codexPlusRailSponsorId} > button, .${codexServiceTierBadgeClass}, .${sessionShareButtonClass}, .codex-zed-remote-button, .codex-zed-remote-toast, .${sessionCopyMenuItemClass}, #codex-plus-menu, #${capacityAutoRetryChipId}`)) {
      return true;
    }
    return isCodexPlusExtensionNode(node);
  }

  function scanRelevantSelector() {
    return [
      selectors.sidebarThread,
      '[data-app-action-sidebar-section-heading="Chats"]',
      '[data-app-action-sidebar-section-heading="Projects"]',
      '[data-codex-archive-page-row="true"]',
      "[data-codex-archive-delete-all]",
      '[data-message-author-role]',
      '[data-testid="conversation-turn"]',
      '[class*="user-message"]',
      '[class*="UserMessage"]',
      selectors.conversationViewScrollContainer,
      selectors.conversationViewFooter,
      "[data-codex-composer-root]",
      '[role="menu"], [role="dialog"], [role="listbox"]',
      ".composer-footer",
      selectors.appHeader,
      selectors.archiveNav,
      selectors.pluginNavButton,
      'aside.app-shell-left-panel nav[role="navigation"]',
      'nav[data-app-navigation-rail]',
      ...(codexPluginMarketplacePatchEnabled() ? [selectors.disabledInstallButton] : []),
    ].join(", ");
  }

  function nodeSelfOrAncestorMatchesScanRelevance(node) {
    if (node.nodeType !== 1) return false;
    if (isExtensionUiNode(node)) return false;
    const relevantSelector = scanRelevantSelector();
    return !!node.closest?.(relevantSelector) ||
      nodeOrAncestorLooksLikeCodexUserBubble(node);
  }

  function isScanRelevantNode(node) {
    if (node.nodeType !== 1) return false;
    if (isExtensionUiNode(node)) return false;
    return nodeSelfOrAncestorMatchesScanRelevance(node) || !!node.querySelector?.(scanRelevantSelector()) || nodeLooksLikeCodexUserBubble(node);
  }

  function isChatContentMutation(mutation) {
    const target = mutation.target;
    if (!target?.closest?.('[data-message-author-role], [data-testid="conversation-turn"], main .prose')) return false;
    const boundaries = `${selectors.conversationViewScrollContainer}, ${selectors.conversationViewFooter}, [data-codex-composer-root], [data-message-author-role], [data-testid="conversation-turn"], [role="menu"], [role="dialog"], [role="listbox"]`;
    return ![...mutation.addedNodes, ...mutation.removedNodes].some((node) => node.nodeType === 1
      && (node.matches?.(boundaries) || node.querySelector?.(boundaries)));
  }

  function shouldScheduleScan(mutations) {
    if (!mutations) return true;
    return mutations.some((mutation) => {
      if (isChatContentMutation(mutation)) return false;
      const target = mutation.target;
      if (isExtensionUiNode(target)) return false;
      const changedNodes = [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)];
      const changedElements = changedNodes.filter((node) => node.nodeType === 1);
      // 我们自己插入的节点挂在 Codex 的容器里，而容器本身是 scan-relevant，
      // 于是「写入 → 观察到自己的写入 → 200ms 后再 scan → 再写入」形成自喂循环，
      // 空闲时也每秒全量扫描五次，macOS 上足以吃满一个核（issue #1960）。
      // 一次变更如果只动了我们自己的 UI，就不该再排一次 scan。
      if (changedElements.length && changedElements.every(isExtensionUiNode)) return false;
      if (target?.nodeType === 1 && nodeSelfOrAncestorMatchesScanRelevance(target)) return true;
      return changedElements.some((node) => isScanRelevantNode(node));
    });
  }

  function runScheduledScan() {
    clearTimeout(window.__codexSessionDeleteScanTimer);
    window.__codexSessionDeleteScanTimer = null;
    if (document.hidden) return;
    const work = codexPlusPendingScanWork;
    codexPlusPendingScanWork = {};
    scan(work);
  }

  const codexPlusAllScanWork = { sidebar: true, conversation: true, menus: true, shell: true, models: true };
  let codexPlusPendingScanWork = {};
  let codexPlusDeferredScanWork = {};
  let codexPlusDeferredScanFrame = 0;
  let codexPlusScanRevision = 0;
  let codexPlusScanDisposed = false;

  function scanWorkForMutations(mutations) {
    if (!mutations) return { ...codexPlusAllScanWork };
    const work = {};
    const sidebar = `${selectors.sidebarThread}, aside.app-shell-left-panel, nav[data-app-navigation-rail], [data-codex-archive-page-row]`;
    const conversation = `${selectors.conversationViewScrollContainer}, ${selectors.conversationViewFooter}, [data-codex-composer-root], [data-message-author-role], [data-testid="conversation-turn"]`;
    for (const mutation of mutations) {
      if (!shouldScheduleScan([mutation])) continue;
      const nodes = [mutation.target, ...mutation.addedNodes, ...mutation.removedNodes].filter((node) => node.nodeType === 1 && !isExtensionUiNode(node));
      let classified = false;
      for (const node of nodes) {
        const matches = (selector) => node.matches?.(selector) || node.closest?.(selector)
          || (node !== mutation.target && node.querySelector?.(selector));
        if (matches(sidebar)) { work.sidebar = true; classified = true; }
        if (matches(conversation) || nodeOrAncestorLooksLikeCodexUserBubble(node)) {
          work.conversation = work.models = true;
          classified = true;
        }
        if (matches('[role="menu"], [role="dialog"], [role="listbox"]')) { work.menus = work.models = true; classified = true; }
        if (matches(selectors.appHeader)) { work.shell = true; classified = true; }
      }
      // 宿主新结构暂时不能归类时，保留完整刷新兜底。
      if (!classified) Object.assign(work, codexPlusAllScanWork);
    }
    return work;
  }

  function scheduleScan(mutations) {
    if (codexPlusScanDisposed) return;
    const work = scanWorkForMutations(mutations);
    if (!Object.keys(work).length) return;
    Object.assign(codexPlusPendingScanWork, work);
    if (document.hidden) {
      window.__codexSessionDeleteLastMutations = null;
      return;
    }
    // 不长期持有卸载的消息子树；超过上限让模型适配走完整刷新。
    const previous = window.__codexSessionDeleteLastMutations;
    const combined = mutations && previous !== null ? [...(previous || []), ...mutations] : null;
    window.__codexSessionDeleteLastMutations = combined?.length <= 80 ? combined : null;
    if (window.__codexSessionDeleteScanPending) return;
    window.__codexSessionDeleteScanPending = true;
    if (document.hidden) return;
    window.__codexSessionDeleteScanTimer = setTimeout(runScheduledScan, 200);
  }

  function cancelDeferredScan() {
    codexPlusScanRevision += 1;
    if (codexPlusDeferredScanFrame) cancelAnimationFrame(codexPlusDeferredScanFrame);
    codexPlusDeferredScanFrame = 0;
    Object.assign(codexPlusPendingScanWork, codexPlusDeferredScanWork);
    codexPlusDeferredScanWork = {};
  }

  function onCodexPlusScanNavigation(event) {
    if (event.type === "keydown" && (event.isComposing || !["Enter", " "].includes(event.key))) return;
    if (["click", "keydown"].includes(event.type) && !event.target?.closest?.(selectors.sidebarThread)) return;
    cancelDeferredScan();
    clearTimeout(window.__codexSessionDeleteScanTimer);
    window.__codexSessionDeleteScanTimer = null;
    window.__codexSessionDeleteScanPending = false;
    conversationViewState.targetsDirty = true;
    scheduleScan();
  }

  function onCodexPlusScanVisibility() {
    if (document.hidden) {
      cancelDeferredScan();
      clearTimeout(window.__codexSessionDeleteScanTimer);
      window.__codexSessionDeleteScanTimer = null;
      window.__codexSessionDeleteScanPending = false;
      if (conversationViewState.rafId) cancelAnimationFrame(conversationViewState.rafId);
      conversationViewState.rafId = 0;
    } else scheduleScan();
  }

  window.__codexPlusScanCleanup = () => {
    codexPlusScanDisposed = true;
    cancelDeferredScan();
    clearTimeout(window.__codexSessionDeleteScanTimer);
    window.__codexSessionDeleteScanTimer = null;
    window.__codexSessionDeleteScanPending = false;
    window.__codexSessionDeleteLastMutations = undefined;
    window.__codexSessionDeleteObserver?.disconnect();
    clearInterval(window.__codexPlusSidebarNavRetryTimer);
    document.removeEventListener("visibilitychange", onCodexPlusScanVisibility);
    document.removeEventListener("click", onCodexPlusScanNavigation, true);
    document.removeEventListener("keydown", onCodexPlusScanNavigation, true);
    window.removeEventListener("popstate", onCodexPlusScanNavigation);
    window.removeEventListener("hashchange", onCodexPlusScanNavigation);
    window.navigation?.removeEventListener?.("currententrychange", onCodexPlusScanNavigation);
  };
  document.addEventListener("visibilitychange", onCodexPlusScanVisibility);
  document.addEventListener("click", onCodexPlusScanNavigation, true);
  document.addEventListener("keydown", onCodexPlusScanNavigation, true);
  window.addEventListener("popstate", onCodexPlusScanNavigation);
  window.addEventListener("hashchange", onCodexPlusScanNavigation);
  window.navigation?.addEventListener?.("currententrychange", onCodexPlusScanNavigation);

  /**
   * 侧边栏入口的启动补扫。
   *
   * 注入永远早于 Codex 把左侧面板渲染出来：注入那一刻 readyState 已是 complete，
   * 但 aside.app-shell-left-panel 还不存在（实测 anyNav: 0），所以首次 scan 里的
   * installCodexPlusSidebarNavigation 必然走 `if (!navigation) return`。
   *
   * 之后全靠 MutationObserver 观察到侧边栏挂载再补一次，实测要 2.6~3.1 秒。
   * 但那把入口的出现押在了单次 DOM 变更上——那次变更若被 shouldScheduleScan
   * 过滤掉，就没有下一次触发，入口会一直缺失到用户手动操作产生新的变更为止。
   *
   * 这里加一个不依赖 DOM 事件的有界重试作为兜底：插上就停，超时就放弃，
   * 不留常驻定时器，也不影响 observer 那条正常路径。
   */
  function scheduleSidebarNavStartupRetry() {
    clearInterval(window.__codexPlusSidebarNavRetryTimer);
    let attempts = 0;
    window.__codexPlusSidebarNavRetryTimer = setInterval(() => {
      if (document.hidden || codexPlusScanDisposed) return;
      attempts += 1;
      const installed = document.getElementById(codexPlusSidebarNavId)
        || document.getElementById(codexPlusRailNavId);
      if (installed || attempts > 20) {
        clearInterval(window.__codexPlusSidebarNavRetryTimer);
        window.__codexPlusSidebarNavRetryTimer = null;
        return;
      }
      try {
        installCodexPlusNavigationEntries();
      } catch {}
    }, 300);
  }

  void loadBackendSettingsForStartup();
  scan();
  syncOfficialUsagePolicy();
  scheduleSidebarNavStartupRetry();
  window.removeEventListener("resize", window.__codexPlusResizeHandler);
