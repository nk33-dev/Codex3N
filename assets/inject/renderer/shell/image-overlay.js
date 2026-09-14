  function installCodexPlusImageOverlay() {
    const config = window.__CODEX_PLUS_IMAGE_OVERLAY__ || {};
    const canQueryById = typeof document?.getElementById === "function";
    const existing = canQueryById ? document.getElementById(codexPlusImageOverlayId) : null;
    const source = config.dataUrl || "";
    if (!config.enabled || !source) {
      if (window.__codexPlusImageOverlayBlobUrl) {
        URL.revokeObjectURL(window.__codexPlusImageOverlayBlobUrl);
        window.__codexPlusImageOverlayBlobUrl = "";
      }
      if (existing) existing.remove();
      return;
    }
    const root = document?.documentElement;
    if (!root || typeof document?.createElement !== "function") {
      return;
    }
    const opacity = Math.min(1, Math.max(0.01, Number(config.opacity) || 0.35));
    const fitMode = ["fill", "fit", "stretch", "tile", "center"].includes(config.fitMode)
      ? config.fitMode
      : "fit";
    const fitStyles = {
      fill: { size: "cover", position: "center center", repeat: "no-repeat" },
      fit: { size: "contain", position: "center center", repeat: "no-repeat" },
      stretch: { size: "100% 100%", position: "center center", repeat: "no-repeat" },
      tile: { size: "auto", position: "left top", repeat: "repeat" },
      center: { size: "auto", position: "center center", repeat: "no-repeat" },
    }[fitMode];
    const overlay = existing?.tagName === "DIV" ? existing : document.createElement("div");
    if (existing && existing !== overlay) existing.remove();
    overlay.id = codexPlusImageOverlayId;
    overlay.setAttribute("aria-hidden", "true");
    Object.assign(overlay.style, {
      position: "fixed",
      inset: "0",
      width: "100vw",
      height: "100vh",
      backgroundImage: `url("${source.replace(/"/g, "%22")}")`,
      backgroundSize: fitStyles.size,
      backgroundPosition: fitStyles.position,
      backgroundRepeat: fitStyles.repeat,
      opacity: String(opacity),
      pointerEvents: "none",
      zIndex: "2147483646",
      userSelect: "none",
    });
    if (!overlay.parentElement) root.appendChild(overlay);
    sendCodexPlusDiagnostic("image_overlay_installed", {
      opacity,
      fitMode,
      sourceKind: source.startsWith("data:") ? "data-uri" : "unknown",
    });
  }

  function scheduleCodexPlusImageOverlay() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", installCodexPlusImageOverlay, { once: true });
      return;
    }
    installCodexPlusImageOverlay();
    setTimeout(installCodexPlusImageOverlay, 250);
  }

  scheduleCodexPlusImageOverlay();
  window.__codexThreadScrollSyncRevision = (window.__codexThreadScrollSyncRevision || 0) + 1;
  let upstreamBranchDefaultsCache = new Map();
  const upstreamBranchDefaultsCacheTtlMs = 5000;
  const upstreamRemoteBranchDefaultsCacheTtlMs = 30000;
  let upstreamBranchDefaultsInflight = new Map();
  const upstreamProjectContextTtlMs = 10 * 60 * 1000;
  const branchWorktreePathAttribute = "data-codex-branch-worktree-path";
  ["__codexPlusHtmlCenteredThreadWidth", "__codexPlusViewportCenteredThreadWidth", "__codexPlusBoundedThreadCenter"].forEach((key) => {
    try {
      window[key]?.cleanup?.();
    } catch (_) {}
  });
  try {
    window.__codexPlusConversationViewCleanup?.();
  } catch (_) {}
  window.__codexPlusConversationViewCleanup = null;
  const selectors = {
    sidebarThread: "[data-app-action-sidebar-thread-id]",
    threadTitle: "[data-thread-title]",
    appHeader: '[class*="ApplicationMenuTopBar"], .app-header-tint',
    archiveNav: 'button[aria-label="已归档对话"], button[aria-label="Archived conversations"]',
    disabledInstallButton: 'button:disabled, button[aria-disabled="true"], [role="button"][aria-disabled="true"], button[data-disabled], [role="button"][data-disabled], button.cursor-not-allowed, [role="button"].cursor-not-allowed, button.pointer-events-none, [role="button"].pointer-events-none',
    pluginNavButton: 'nav[role="navigation"] button.h-token-nav-row.w-full',
    pluginSvgPath: 'svg path[d^="M7.94562 14.0277"]',
  };
  const headerContextButtonClass = "border-token-border user-select-none no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg border-token-border text-token-button-tertiary-foreground bg-token-bg-fog enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background border h-token-button-composer px-2 py-0 text-base leading-[18px]";

