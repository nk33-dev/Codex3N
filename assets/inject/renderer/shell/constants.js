  const helperBase = window.__CODEX_SESSION_DELETE_HELPER__ || "http://127.0.0.1:57321";
  const buttonClass = "codex-delete-button";
  const exportButtonClass = "codex-export-button";
  const actionButtonClass = "codex-session-action-button";
  const actionGroupClass = "codex-session-actions";
  const moreButtonClass = "codex-session-more-button";
  const moreMenuClass = "codex-session-more-menu";
  const actionTooltipClass = "codex-session-action-tooltip";
  const threadIdBadgeClass = "codex-thread-id-badge";
  const conversationViewMinWidth = 320;
  const conversationViewMaxAllowedWidth = 4000;
  const conversationViewDefaultWidth = 900;
  const conversationViewLegacyWidthKey = "codexPlus.threadCenter.maxWidth";
  const zedRemoteButtonClass = "codex-zed-remote-button";
  const zedRemoteOpenInMenuItemClass = "codex-zed-open-in-menu-item";
  const sessionCopyMenuItemClass = "codex-session-copy-menu-item";
  const sessionCopyMenuItemVersion = "1";
  const sessionCopyMenuActivationTimeoutMs = 12000;
  const sessionShareButtonClass = "codex-session-share-button";
  const sessionShareButtonVersion = "1";
  const codexPlusShareBaseUrl = "https://share.codexpp.cc";
  const codexPlusShareFallbackBaseUrl = "https://codexpp-share.pages.dev";
  const codexPlusShareMaxCharacters = 900000;
  const sessionAutoRenameTimeoutMs = 20000;
  const zedRemoteToastClass = "codex-zed-remote-toast";
  const upstreamWorktreeDialogClass = "codex-upstream-worktree-dialog";
  const upstreamBranchOptionAttribute = "data-codex-upstream-branch-option";
  const upstreamBranchSelectionKey = "codexUpstreamBranchSelection";
  const upstreamProjectContextKey = "codexUpstreamProjectContext";
  const zedRemoteOpenInMenuVersion = "1";
  const zedRemoteOpenInMenuActivationWindowMs = 600;
  const styleId = "codex-delete-style";
  const codexDeleteStyleVersion = "19";
  const codexPlusMenuId = "codex-plus-menu";
  const codexPlusMenuFloatingClass = "codex-plus-menu-floating";
  const codexPlusSidebarNavId = "codex-plus-sidebar-nav";
  const codexPlusPageClass = "codex-plus-page-overlay";
  const codexDeleteVersion = "7";
  const codexExportVersion = "1";
  const codexActionGroupVersion = "6";
  const codexArchiveRowActionsVersion = "1";
  const codexArchiveDeleteAllVersion = "2";
  const codexConversationViewVersion = "1";
  const codexThreadScrollVersion = "1";
  const codexThreadIdBadgeVersion = "1";
  const codexThreadServiceTierVersion = "1";
  const codexServiceTierBadgeClass = "codex-service-tier-badge";
  const codexServiceTierBadgeVersion = "3";
  const codexRelayApiKeyBadgeClass = "codex-relay-api-key-badge";
  const codexRelayApiKeyBadgeVersion = "1";
  const codexMenuLocalizationVersion = "1";
  const codexMenuLocalizationMap = new Map([
    ["Toggle Sidebar", "切换侧边栏"],
    ["Toggle Bottom Panel", "切换底部面板"],
    ["Toggle Pinned Summary", "切换置顶摘要"],
    ["Open Terminal", "打开终端"],
    ["Toggle File Tree", "切换文件树"],
    ["Open Browser Tab", "打开浏览器标签页"],
    ["Focus Browser Address Bar", "聚焦浏览器地址栏"],
    ["Reload Browser Page", "重新加载浏览器页面"],
    ["Force Reload Browser Page", "强制重新加载浏览器页面"],
    ["Toggle Browser Panel", "切换浏览器面板"],
    ["Toggle Side Panel", "切换侧边面板"],
    ["Find", "查找"],
    ["Previous Chat", "上一个对话"],
    ["Next Chat", "下一个对话"],
    ["Back", "后退"],
    ["Forward", "前进"],
    ["Zoom In", "放大"],
    ["Zoom Out", "缩小"],
    ["Actual Size", "实际大小"],
    ["Toggle Full Screen", "切换全屏"],
    ["Keyboard Shortcuts", "键盘快捷键"],
    ["Open command menu", "打开命令菜单"],
    ["Search Chats…", "搜索对话…"],
    ["Search Files…", "搜索文件…"],
    ["New Chat", "新建对话"],
    ["Quick Chat", "快速对话"],
    ["Open in New Window", "在新窗口打开"],
    ["Archive chat", "归档对话"],
    ["Pin/unpin chat", "置顶/取消置顶对话"],
    ["Settings…", "设置…"],
    ["Open Folder…", "打开文件夹…"],
    ["Close Tab", "关闭标签页"],
    ["Close", "关闭"],
    ["New Window", "新建窗口"],
    ["Copy conversation path", "复制对话路径"],
    ["Copy deeplink", "复制深层链接"],
    ["Copy session id", "复制会话 ID"],
    ["Copy working directory", "复制工作目录"],
  ]);
  let codexPlusVersion = window.__CODEX_PLUS_VERSION__ || "unknown";
  const codexPlusBuild = window.__CODEX_PLUS_BUILD__ || "unknown";
  let lastSessionActionTrigger = null;
  const codexPlusSettingsKey = "codexPlusSettings";
  const codexThreadScrollKey = "codexThreadScroll";
  const codexThreadServiceTierKey = "codexThreadServiceTierOverrides";
  const codexThreadServiceTierMaxEntries = 120;
  const codexThreadServiceTierDraftBindWindowMs = 60 * 1000;
  const codexServiceTierRequestOverrideVersion = "9";
  const codexAppServerModelRequestPatchVersion = "8";
  const codexRemoteSessionRecoveryVersion = "5";
  const codexPluginMarketplaceUnlockVersion = "15";
  const codexThreadScrollMaxEntries = 120;
  const codexThreadScrollSaveThrottleMs = 120;
  const codexThreadScrollRestoreWindowMs = 3200;
  const codexThreadScrollRestoreDelaysMs = [0, 80, 220, 500, 1000, 1800, 2800];
  const codexThreadScrollUserIntentWindowMs = 1200;
  const codexThreadScrollProgrammaticGuardVersion = "dispatcher:2";
  const codexThreadScrollRouteHooksVersion = "dispatcher:2";
  const codexThreadScrollListenerVersion = "4";
  const codexThreadScrollUserIntentVersion = "dispatcher:2";
  const codexPlusImageOverlayId = "codex-plus-image-overlay";
  const codexPlusDreamSkinStyleId = "codex-dream-skin-style";
  const codexPlusDreamSkinPlatform = String(window.__CODEX_PLUS_DREAM_SKIN_PLATFORM__ || "macos");
  const codexPlusDreamSkinRevision = String(window.__CODEX_PLUS_DREAM_SKIN_REVISION__ || "1");
  clearTimeout(window.__codexThreadScrollSaveTimer);
  window.__codexThreadScrollSaveTimer = null;
  (window.__codexThreadScrollRestoreTimers || []).forEach((timer) => clearTimeout(timer));
  window.__codexThreadScrollRestoreTimers = [];
  (window.__codexThreadScrollSyncTimers || []).forEach((timer) => clearTimeout(timer));
  window.__codexThreadScrollSyncTimers = [];
  window.__codexThreadScrollRestoreRevision = (window.__codexThreadScrollRestoreRevision || 0) + 1;
