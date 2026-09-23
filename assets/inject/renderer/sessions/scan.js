  function scanDeferred() {
    if (pluginPatchDisabledInRelayMode()) {
      clearPluginPatchArtifacts();
    } else {
      const pluginUnlockStrategy = codexPluginUnlockStrategy();
      const settings = codexPlusSettings();
      logCodexPluginUnlockStrategy(pluginUnlockStrategy);
      if ((pluginUnlockStrategy === "modern" || pluginUnlockStrategy === "unknown") && settings.pluginMarketplaceUnlock) {
        const marketplaceRequestPatchStrategy = codexPluginMarketplaceRequestPatchStrategy();
        installPluginBuildFlavorFilterPatch();
        if (marketplaceRequestPatchStrategy === "bridge") {
          installPluginMarketplaceBridgePatch();
        } else if (marketplaceRequestPatchStrategy === "client") {
          installPluginMarketplaceRequestPatch();
        } else {
          installPluginMarketplaceWindowEventPatchOnly();
          installPluginMarketplaceBridgePatch();
          installPluginMarketplaceRequestPatch();
        }
      }
    }
    refreshDreamSkin();
    refreshThreadIdBadges();
    refreshInvalidSessionVisibility();
    sessionRows().forEach(tryAttachButton);
    updateDeleteButtonOffsets();
    archivedPageRows().forEach(attachArchivedPageDeleteButton);
    refreshConversationView();
    installCodexServiceTierBadge();
    installCodexRelayApiKeyBadge();
    installSessionShareButton();
    scheduleThreadScrollSync();
    refreshCodexModelWhitelistFromScan();
  }

  function runScanStep(step) {
    try {
      step();
    } catch (error) {
      window.__codexSessionDeleteScanFailures = window.__codexSessionDeleteScanFailures || [];
      window.__codexSessionDeleteScanFailures.push(String(error?.stack || error));
    }
  }

  function scan() {
    void installDictationSupportPatch();
    runScanStep(scanLightweight);
    requestAnimationFrame(() => runScanStep(scanDeferred));
  }

  function isExtensionUiNode(node) {
    return !!node?.closest?.(`.codex-delete-toast, .codex-delete-confirm-overlay, .codex-plus-modal-overlay, .${codexPlusPageClass}, #${codexPlusSidebarNavId}, .${codexServiceTierBadgeClass}, .${codexRelayApiKeyBadgeClass}, .${sessionShareButtonClass}, .codex-zed-remote-button, .codex-zed-remote-toast, .${sessionCopyMenuItemClass}, #codex-plus-menu`);
  }

  function scanRelevantSelector() {
    return [
      selectors.sidebarThread,
      'aside.app-shell-left-panel [role="status"][aria-live="polite"]',
      '[data-app-action-sidebar-section-heading="Chats"]',
      '[data-app-action-sidebar-section-heading="Projects"]',
      '[data-codex-archive-page-row="true"]',
      "[data-codex-archive-delete-all]",
      '[data-message-author-role]',
      '[data-testid="conversation-turn"]',
      '[class*="user-message"]',
      '[class*="UserMessage"]',
      ".composer-footer",
      '[role="menu"], [role="listbox"], [data-radix-menu-content]',
      selectors.appHeader,
      selectors.archiveNav,
      selectors.pluginNavButton,
      'aside.app-shell-left-panel nav[role="navigation"]',
      codexMenuLocalizationScopeSelector(),
      ...(pluginPatchDisabledInRelayMode() ? [] : [selectors.disabledInstallButton]),
    ].join(", ");
  }

  function nodeSelfOrAncestorMatchesScanRelevance(node) {
    if (node.nodeType !== 1) return false;
    if (isExtensionUiNode(node)) return false;
    const relevantSelector = scanRelevantSelector();
    return !!node.matches?.(relevantSelector) ||
      !!node.closest?.(relevantSelector) ||
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
    return !Array.from(mutation.addedNodes).some((node) => node.nodeType === 1 && isScanRelevantNode(node)) &&
      !Array.from(mutation.removedNodes).some((node) => node.nodeType === 1 && isScanRelevantNode(node));
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
    window.__codexSessionDeleteScanPending = false;
    clearTimeout(window.__codexSessionDeleteScanTimer);
    window.__codexSessionDeleteScanTimer = null;
    scan();
  }

  function scheduleScan(mutations) {
    scheduleZedRemoteMenuRefresh(mutations);
    if (!shouldScheduleScan(mutations)) return;
    if (window.__codexSessionDeleteScanPending) return;
    window.__codexSessionDeleteScanPending = true;
    window.__codexSessionDeleteScanTimer = setTimeout(runScheduledScan, 200);
  }

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
      attempts += 1;
      if (document.getElementById(codexPlusSidebarNavId) || attempts > 20) {
        clearInterval(window.__codexPlusSidebarNavRetryTimer);
        window.__codexPlusSidebarNavRetryTimer = null;
        return;
      }
      try {
        installCodexPlusSidebarNavigation();
      } catch {}
    }, 300);
  }

  void loadBackendSettingsForStartup();
  syncOfficialUsagePolicy();
  installUpstreamBranchDropdownAdapter();
  installUpstreamWorktreeNativeAdapter();
  scan();
  scheduleSidebarNavStartupRetry();
  window.removeEventListener("resize", window.__codexPlusResizeHandler);
  let codexPlusResizeRafId = 0;
  window.__codexPlusResizeHandler = () => {
    cancelAnimationFrame(codexPlusResizeRafId);
    codexPlusResizeRafId = requestAnimationFrame(() => {
      sessionRows().forEach((row) => {
        const group = actionGroupFromRow(row);
        if (group) delete group.dataset.codexActionLayoutStable;
      });
      syncActionGroupsLayout();
      runScanStep(refreshConversationView);
    });
  };
  window.addEventListener("resize", window.__codexPlusResizeHandler);
  window.__codexSessionDeleteObserver?.disconnect();
  window.__codexSessionDeleteObserver = new MutationObserver(scheduleScan);
  window.__codexSessionDeleteObserver.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
    // Codex may promote a newly-created row from a temporary client ID to its
    // persisted UUID without replacing the DOM node. Re-scan those rows so the
    // action button and its delete reference are rebuilt from the canonical ID.
    attributes: true,
    attributeFilter: ["data-app-action-sidebar-thread-id", "data-app-action-sidebar-thread-host-id", "href"],
  });
  document.removeEventListener("pointerdown", window.__codexSessionActionTriggerHandler, true);
  window.__codexSessionActionTriggerHandler = rememberSessionActionTrigger;
  document.addEventListener("pointerdown", window.__codexSessionActionTriggerHandler, true);
  document.removeEventListener("click", window.__codexSessionActionTriggerClickHandler, true);
  window.__codexSessionActionTriggerClickHandler = rememberSessionActionTrigger;
  document.addEventListener("click", window.__codexSessionActionTriggerClickHandler, true);
