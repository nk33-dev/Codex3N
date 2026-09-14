  function scanLightweight() {
    installStyle();
    refreshOfficialUsageAlertVisibility();
    installCodexServiceTierDispatcherPatch();
    installCodexRemoteSessionRecoveryListener();
    if (window.__codexPlusRemoteSessionRecoveryDispatcher) {
      installCodexRemoteSessionDispatcherSubscription(
        window.__codexPlusRemoteSessionRecoveryDispatcher,
        "existing-renderer"
      );
    }
    installCodexPlusSidebarNavigation();
    installCodexPlusPageNavigationCloseHandler();
    installSessionShareImportListener();
    localizeCodexMenus();
    scheduleBackendHeartbeat();
    installDeleteButtonEventDelegation();
    updateThreadScrollHandlers();
    installThreadScrollProgrammaticScrollGuard();
    installThreadScrollNavigationCapture();
    installThreadScrollUserIntentCapture();
    installThreadScrollRouteHooks();
    scheduleThreadScrollSync(true);
    refreshCodexServiceTierControls();
  }

  function officialUsageAlertHidden() {
    return window.__CODEX_PLUS_HIDE_OFFICIAL_USAGE_ALERT__ === true;
  }

  function officialUsageAlertCards(scope = document) {
    const root = scope?.querySelectorAll ? scope : document;
    return Array.from(root.querySelectorAll('aside.app-shell-left-panel [role="status"][aria-live="polite"]')).filter((card) => {
      if (!(card instanceof HTMLElement)) return false;
      const progress = card.querySelector('progress[max="100"]');
      if (!progress) return false;
      const dismissButton = Array.from(card.querySelectorAll("button")).find((button) =>
        /dismiss usage alert|关闭使用量提醒/i.test(button.getAttribute("aria-label") || ""),
      );
      return !!dismissButton;
    });
  }

  function officialUsageAlertContainer(card) {
    const parent = card.parentElement;
    return parent?.children.length === 1 && parent.matches("div.w-full") ? parent : card;
  }

  function refreshOfficialUsageAlertVisibility() {
    const hidden = officialUsageAlertHidden();
    const expected = new Set(
      hidden ? officialUsageAlertCards().map((card) => officialUsageAlertContainer(card)) : [],
    );
    document.querySelectorAll('[data-codex-plus-usage-alert-hidden="true"]').forEach((container) => {
      if (!expected.has(container)) delete container.dataset.codexPlusUsageAlertHidden;
    });
    expected.forEach((container) => {
      if (container.dataset.codexPlusUsageAlertHidden !== "true") {
        container.dataset.codexPlusUsageAlertHidden = "true";
      }
    });
  }

