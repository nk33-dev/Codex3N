  function installStyle() {
    const existingStyle = document.getElementById(styleId);
    if (existingStyle?.dataset.codexDeleteStyleVersion === codexDeleteStyleVersion) return;
    existingStyle?.remove();
    const style = document.createElement("style");
    style.id = styleId;
    style.dataset.codexDeleteStyleVersion = codexDeleteStyleVersion;
    style.textContent = `
      [data-codex-invalid-session-hidden="true"] { display: none !important; }
      [data-codex-plus-model][hidden] { display: none !important; }
      .${actionGroupClass} {
        position: absolute;
        right: var(--codex-session-actions-right, 28px);
        top: 50%;
        transform: translateY(-50%);
        z-index: 20;
        opacity: 0;
        pointer-events: none;
        display: inline-flex;
        align-items: center;
        gap: 2px;
        background: transparent;
      }
      .${actionButtonClass} {
        width: 20px;
        height: 20px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--codex-session-action-color, var(--token-text-tertiary, rgba(255,255,255,.5)));
        font: 14px/1 system-ui, sans-serif;
        padding: 0;
        cursor: default;
        text-align: center;
      }
      .${actionButtonClass} svg {
        display: block;
        width: 16px;
        height: 16px;
      }
      .${actionButtonClass}:hover,
      .${actionButtonClass}:focus-visible {
        background: var(--codex-session-action-hover-background, transparent);
        color: var(--codex-session-action-hover-color, var(--codex-session-action-color, var(--token-text-default, #f4f4f5)));
        outline: none;
      }
      .${moreMenuClass} {
        position: fixed;
        z-index: 2147483201;
        min-width: 104px;
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        box-shadow: var(--ui-menu-shadow, var(--shadow-300, 0 8px 24px rgba(0,0,0,.16)));
        padding: 4px;
      }
      .${moreMenuClass}[hidden] { display: none !important; }
      .${moreMenuClass}.codex-session-more-menu-open-up {
        transform: translateY(calc(-100% - 34px));
      }
      .codex-session-more-menu-item {
        width: 100%;
        border: 0;
        border-radius: var(--border-radius-sm, 6px);
        background: transparent;
        color: inherit;
        cursor: default;
        display: flex;
        align-items: center;
        gap: 8px;
        font: inherit;
        font-size: 13px;
        line-height: 18px;
        padding: 6px 8px;
        text-align: left;
      }
      .codex-session-more-menu-item:hover,
      .codex-session-more-menu-item:focus-visible {
        background: var(--codex-plus-bg-hover);
        outline: none;
      }
      .codex-session-more-menu-icon {
        width: 16px;
        text-align: center;
      }
      .${threadIdBadgeClass} {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        max-width: 152px;
        margin-right: 8px;
        color: var(--text-secondary, var(--token-text-secondary, rgba(142,142,160,.95)));
        font: 11px/1.1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        letter-spacing: .01em;
        opacity: .9;
        white-space: nowrap;
        user-select: text;
      }
      ${selectors.sidebarThread} [data-codex-thread-id-badge-wrap="true"] {
        display: inline-flex;
        align-items: center;
        min-width: 0;
        max-width: 100%;
      }
      ${selectors.sidebarThread} [data-codex-thread-id-badge-wrap="true"] ${selectors.threadTitle},
      ${selectors.sidebarThread} [data-codex-thread-id-badge-wrap="true"] .truncate.select-none,
      ${selectors.sidebarThread} [data-codex-thread-id-badge-wrap="true"] .truncate.text-base {
        min-width: 0;
      }
      .codex-archive-row-button {
        border: 1px solid var(--color-token-border-light, var(--token-border, rgba(0,0,0,.12)));
        border-radius: var(--border-radius-sm, 6px);
        background: var(--color-token-bg-secondary, var(--token-bg-fog, transparent));
        color: var(--color-token-text-secondary, var(--token-text-secondary, inherit));
        font: inherit;
        font-size: 12px;
        line-height: 16px;
        padding: 3px 8px;
        cursor: pointer;
      }
      .codex-archive-row-button.${buttonClass} {
        border-color: var(--color-border-danger, #dc2626);
        background: var(--color-background-danger-soft, rgba(220,38,38,.1));
        color: var(--color-text-danger, #dc2626);
      }
      .codex-archive-row-button.${exportButtonClass} {
        border-color: var(--color-token-border-light, var(--token-border, rgba(0,0,0,.12)));
        background: var(--color-token-bg-secondary, var(--token-bg-fog, transparent));
        color: var(--color-token-text-primary, var(--token-text-primary, inherit));
      }
      .${zedRemoteButtonClass} {
        border: 1px solid var(--color-token-border-light, var(--token-border, rgba(0,0,0,.12)));
        border-radius: var(--border-radius-sm, 6px);
        background: var(--color-token-bg-secondary, var(--token-bg-fog, transparent));
        color: var(--color-token-text-primary, var(--token-text-primary, inherit));
        font: inherit;
        font-size: 12px;
        line-height: 16px;
        margin-left: 6px;
        padding: 2px 7px;
        cursor: pointer;
      }
      .${zedRemoteButtonClass}:hover,
      .${zedRemoteButtonClass}:focus-visible {
        background: var(--color-token-interactive-bg-secondary-hover, var(--token-list-hover-background, rgba(0,0,0,.06)));
        outline: none;
      }
      .${zedRemoteOpenInMenuItemClass} {
        cursor: pointer;
      }
      .${sessionCopyMenuItemClass} {
        cursor: pointer;
      }
      .${sessionShareButtonClass} {
        position: static;
        flex: 0 0 auto;
        pointer-events: auto;
        -webkit-app-region: no-drag;
        margin-left: 2px;
        z-index: 2147483001;
        min-height: var(--height-button-composer, 32px);
        border-radius: var(--border-radius-lg, 8px);
        font: inherit;
        font-size: 13px;
        line-height: 18px;
        cursor: pointer;
        box-shadow: none;
      }
      .${sessionShareButtonClass}:hover,
      .${sessionShareButtonClass}:focus-visible {
        background: var(--token-list-hover-background, rgba(70,70,70,.96));
        color: var(--token-text-default, #fff);
        outline: none;
      }
      .${sessionShareButtonClass}[aria-busy="true"] {
        cursor: wait;
        opacity: .65;
      }
      .codex-zed-open-in-menu-icon {
        width: 18px;
        height: 18px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        object-fit: contain;
      }
      .${zedRemoteToastClass} {
        position: fixed;
        right: 18px;
        bottom: 58px;
        z-index: 2147483000;
        max-width: min(420px, calc(100vw - 36px));
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 13px;
        line-height: 18px;
        padding: 10px 12px;
        box-shadow: var(--ui-menu-shadow, var(--shadow-300, 0 8px 24px rgba(0,0,0,.16)));
        pointer-events: none;
      }
      [data-codex-delete-row="true"]:hover .${actionGroupClass} {
        opacity: 1;
        pointer-events: auto;
      }
      [data-codex-delete-row="true"]:hover ${selectors.threadTitle},
      [data-codex-delete-row="true"]:focus-within ${selectors.threadTitle},
      [data-codex-delete-row="true"].codex-session-more-open ${selectors.threadTitle} {
        flex: 0 1 auto;
        width: var(--codex-session-title-max-width, auto);
        max-width: var(--codex-session-title-max-width, 100%);
        overflow: hidden;
      }
      [data-codex-delete-row="true"].codex-session-more-open .${actionGroupClass} {
        opacity: 1;
        pointer-events: auto;
        z-index: 2147483201;
      }
      [data-codex-delete-row="true"].codex-archive-confirm-visible .${actionGroupClass} {
        right: max(66px, var(--codex-session-actions-right, 28px));
      }
      .${actionTooltipClass} {
        position: fixed;
        z-index: 2147483201;
        max-width: min(220px, calc(100vw - 32px));
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-md, 6px);
        background: var(--color-token-bg-tooltip, var(--codex-plus-bg-elevated));
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 12px;
        line-height: 16px;
        padding: 6px 8px;
        box-shadow: var(--tooltip-box-shadow, var(--shadow-200, 0 4px 12px rgba(0,0,0,.14)));
        pointer-events: none;
        white-space: nowrap;
      }
      [data-codex-plus-usage-alert-hidden="true"] { display: none !important; }
      .codex-archive-delete-all {
        border: 1px solid var(--color-border-danger, #dc2626);
        border-radius: var(--border-radius-sm, 6px);
        background: var(--color-background-danger-soft, rgba(220,38,38,.1));
        color: var(--color-text-danger, #dc2626);
        font: inherit;
        font-size: 12px;
        line-height: 16px;
        padding: 3px 8px;
        cursor: pointer;
      }
      .codex-archive-action-bar {
        position: fixed;
        right: 28px;
        top: 86px;
        z-index: 2147482999;
        box-shadow: 0 8px 24px rgba(0,0,0,.18);
      }
      .codex-delete-toast {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483000;
        padding: 10px 12px;
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 13px;
        box-shadow: var(--ui-menu-shadow, var(--shadow-300, 0 8px 24px rgba(0,0,0,.16)));
        pointer-events: none;
      }
      .codex-delete-toast button { margin-left: 10px; pointer-events: auto; }
      .codex-delete-confirm-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483200;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--modal-backdrop-dim-shadow, rgba(0,0,0,.32));
        backdrop-filter: blur(1px);
      }
      .codex-delete-confirm-content {
        width: min(420px, calc(100vw - 48px));
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-xl, 12px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 14px;
        box-shadow: var(--shadow-400, 0 16px 48px rgba(0,0,0,.2));
        padding: 20px;
      }
      .codex-delete-confirm-title { font-size: 16px; font-weight: 650; }
      .codex-delete-confirm-message { margin-top: 8px; color: var(--codex-plus-text-secondary); line-height: 1.45; }
      .codex-delete-confirm-actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
        margin-top: 18px;
      }
      .codex-delete-confirm-actions button {
        min-height: 32px;
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        padding: 5px 12px;
        background: var(--codex-plus-bg-secondary);
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      .codex-delete-confirm-actions button:hover,
      .codex-delete-confirm-actions button:focus-visible {
        background: var(--codex-plus-bg-hover);
        outline: none;
      }
      .codex-delete-confirm-actions [data-codex-delete-confirm="true"] {
        border-color: var(--color-border-danger, #dc2626);
        background: var(--color-background-danger-solid, #dc2626);
        color: var(--color-text-danger-solid, #fff);
      }
      .codex-plus-modal-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--modal-backdrop-dim-shadow, rgba(0,0,0,.32));
        backdrop-filter: blur(1px);
        pointer-events: auto;
        -webkit-app-region: no-drag;
      }
      .codex-plus-modal-content {
        width: min(520px, calc(100vw - 48px));
        max-height: min(680px, calc(100vh - 40px));
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-xl, 12px);
        background: var(--codex-plus-bg-primary);
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 14px;
        box-shadow: var(--shadow-400, 0 16px 48px rgba(0,0,0,.2));
        pointer-events: auto;
        -webkit-app-region: no-drag;
      }
      .codex-plus-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 16px 20px 8px;
        flex: 0 0 auto;
        -webkit-app-region: no-drag;
      }
      .codex-plus-modal-title { display: flex; align-items: center; gap: 8px; font-size: 18px; font-weight: 600; }
      .codex-plus-backend-indicator { width: 8px; height: 8px; border-radius: 999px; background: var(--codex-plus-text-tertiary); display: inline-block; }
      .codex-plus-backend-indicator[data-status="ok"] { background: var(--codex-plus-success); }
      .codex-plus-backend-indicator[data-status="failed"] { background: var(--codex-plus-danger); }
      .codex-plus-backend-indicator[data-status="checking"] { background: var(--codex-plus-warning); }
      #${codexPlusSidebarNavId} {
        position: relative;
        flex: 0 0 auto;
      }
      #${codexPlusSidebarNavId} .codex-plus-sidebar-nav-icon {
        width: 20px;
        height: 20px;
        flex: 0 0 20px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }
      #${codexPlusSidebarNavId} .codex-plus-sidebar-nav-icon svg {
        width: 19px;
        height: 19px;
        display: block;
      }
      #${codexPlusSidebarNavId} .codex-plus-sidebar-nav-status {
        width: 7px;
        height: 7px;
        margin-left: auto;
        border-radius: 999px;
        background: #a1a1aa;
        opacity: .9;
      }
      #${codexPlusSidebarNavId} .codex-plus-sidebar-nav-status[data-status="ok"] {
        background: #34d399;
        box-shadow: 0 0 7px rgba(52,211,153,.7);
      }
      #${codexPlusSidebarNavId} .codex-plus-sidebar-nav-status[data-status="failed"] { background: #ef4444; }
      #${codexPlusSidebarNavId} .codex-plus-sidebar-nav-status[data-status="checking"] { background: #fbbf24; }
      #${codexPlusSidebarNavId} button[data-active="true"] {
        background: var(--token-list-hover-background, rgba(255,255,255,.08));
        color: var(--token-text-primary, inherit);
      }
      .${codexPlusPageClass} {
        position: fixed;
        inset: 0;
        z-index: 2147483644;
        display: block;
        background: var(--token-bg-primary, #212121);
        pointer-events: auto;
        -webkit-app-region: no-drag;
      }
      .${codexPlusPageClass} .codex-plus-modal-content {
        width: auto;
        height: 100%;
        max-height: none;
        border: 0;
        border-radius: 0;
        background: var(--token-bg-primary, #212121);
        box-shadow: none;
      }
      .${codexPlusPageClass} .codex-plus-modal-header {
        width: min(960px, 100%);
        margin: 0 auto;
        padding: 24px 32px 12px;
      }
      .${codexPlusPageClass} .codex-plus-tabs {
        width: min(960px, 100%);
        margin-inline: auto;
      }
      .${codexPlusPageClass} .codex-plus-modal-body {
        width: min(960px, 100%);
        margin: 0 auto;
        padding: 4px 32px 32px;
      }
      .${codexPlusPageClass} .codex-plus-modal-close {
        min-width: 56px;
        padding: 5px 12px;
        border: 1px solid rgba(255,255,255,.14);
        border-radius: 8px;
        font-size: 13px;
      }
      .codex-plus-modal-close {
        border: 0;
        background: transparent;
        color: #d1d5db;
        font-size: 20px;
        cursor: pointer;
        pointer-events: auto;
        -webkit-app-region: no-drag;
      }
      .codex-plus-modal-body {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        padding: 4px 20px 16px;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,.28) transparent;
      }
      .codex-plus-modal-body::-webkit-scrollbar { width: 10px; }
      .codex-plus-modal-body::-webkit-scrollbar-track { background: transparent; }
      .codex-plus-modal-body::-webkit-scrollbar-thumb {
        border: 2px solid transparent;
        border-radius: 999px;
        background: rgba(255,255,255,.28);
        background-clip: padding-box;
      }
      .codex-plus-modal-body::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.38); background-clip: padding-box; }
      .codex-plus-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 0;
        border-top: 1px solid rgba(255,255,255,.1);
      }
      .codex-plus-row:first-child { border-top: 0; }
      .codex-plus-row-title { font-weight: 550; line-height: 1.35; }
      .codex-plus-row-description { margin-top: 2px; color: #a1a1aa; font-size: 12px; line-height: 1.4; }
      .codex-plus-model-compat-warning { margin-top: 6px; color: #fbbf24; font-size: 12px; line-height: 1.45; }
      .codex-plus-toggle {
        width: 42px;
        height: 24px;
        border: 0;
        border-radius: 999px;
        background: #52525b;
        padding: 2px;
      }
      .codex-plus-toggle span {
        display: block;
        width: 20px;
        height: 20px;
        border-radius: 999px;
        background: white;
        transition: transform .12s ease;
      }
      .codex-plus-toggle,
      .codex-plus-action-button,
      .codex-plus-issue-button,
      .codex-plus-backend-status {
        flex-shrink: 0;
        align-self: center;
      }
      .codex-plus-toggle[data-enabled="true"] { background: #10a37f; }
      .codex-plus-toggle[data-enabled="true"] span { transform: translateX(18px); }
      .codex-plus-toggle[data-pending="true"],
      .codex-plus-toggle:disabled { cursor: not-allowed; opacity: .55; }
      .codex-plus-toggle[data-relay-unneeded="true"] { width: 72px; cursor: default; background: rgba(16,163,127,.16); color: #6ee7b7; }
      .codex-plus-toggle[data-relay-unneeded="true"] span { display: none; }
      .codex-plus-toggle[data-relay-unneeded="true"]::after { content: "无需开启"; font-size: 12px; font-weight: 650; line-height: 1; }
      .codex-plus-width-control { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 176px; align-self: center; }
      .codex-plus-width-input {
        width: 78px;
        height: 26px;
        box-sizing: border-box;
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 7px;
        background: rgba(255,255,255,.08);
        color: #f3f4f6;
        font: 12px system-ui, sans-serif;
        padding: 0 8px;
      }
      .codex-plus-width-input:disabled { opacity: .55; cursor: not-allowed; }
      .codex-plus-service-tier-control { display: grid; gap: 6px; min-width: 316px; justify-items: end; align-self: center; }
      .codex-plus-service-tier-status { color: #a1a1aa; font-size: 12px; line-height: 1.3; text-align: right; }
      .codex-plus-service-tier-status[data-status="ok"] { color: #34d399; }
      .codex-plus-service-tier-status[data-status="failed"] { color: #f87171; }
      .codex-plus-service-tier-status[data-status="unsupported"] { color: #fbbf24; }
      .codex-plus-service-tier-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
      .codex-plus-service-tier-thread-actions { opacity: .88; align-items: center; }
      .codex-plus-service-tier-thread-label { color: #a1a1aa; font: 12px/1.2 system-ui, sans-serif; white-space: nowrap; }
      .codex-plus-service-tier-button { border: 1px solid rgba(255,255,255,.18); border-radius: 7px; background: #3f3f46; color: #f3f4f6; font: 12px system-ui, sans-serif; padding: 5px 8px; white-space: nowrap; }
      .codex-plus-service-tier-button[data-active="true"] { border-color: #10a37f; background: rgba(16,163,127,.22); color: #6ee7b7; }
      .codex-plus-service-tier-button:disabled { opacity: .55; cursor: not-allowed; }
      .${codexServiceTierBadgeClass} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        height: 24px;
        min-width: 54px;
        box-sizing: border-box;
        border: 1px solid rgba(148,163,184,.28);
        border-radius: 999px;
        background: rgba(148,163,184,.12);
        color: #d4d4d8;
        font: 600 12px/1 system-ui, sans-serif;
        padding: 0 8px;
        white-space: nowrap;
        cursor: pointer;
      }
      .${codexServiceTierBadgeClass}:hover { border-color: rgba(16,163,127,.44); background: rgba(16,163,127,.13); }
      .${codexServiceTierBadgeClass}[data-tier="fast"] { border-color: rgba(16,163,127,.55); background: rgba(16,163,127,.18); color: #6ee7b7; }
      .${codexServiceTierBadgeClass}[data-tier="loading"] { color: #a1a1aa; }
      .${codexServiceTierBadgeClass}[data-tier="failed"] { border-color: rgba(248,113,113,.42); background: rgba(248,113,113,.12); color: #fca5a5; }
      .${codexServiceTierBadgeClass}[data-tier="unsupported"] { border-color: rgba(251,191,36,.48); background: rgba(251,191,36,.13); color: #fbbf24; }
      .${codexServiceTierBadgeClass}[data-disabled="true"] { cursor: not-allowed; opacity: .78; }
      .${codexRelayApiKeyBadgeClass} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 1 auto;
        max-width: 132px;
        height: 24px;
        border: 1px solid rgba(148,163,184,.28);
        border-radius: 7px;
        background: rgba(148,163,184,.12);
        color: #d4d4d8;
        font: 600 12px/1 system-ui, sans-serif;
        padding: 0 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .${codexRelayApiKeyBadgeClass}:hover { border-color: rgba(16,163,127,.44); background: rgba(16,163,127,.13); }
      .${codexRelayApiKeyBadgeClass}[data-disabled="true"] { cursor: not-allowed; opacity: .65; }
      .codex-plus-about { color: #a1a1aa; line-height: 1.5; }
      .codex-plus-tabs { display: flex; gap: 8px; padding: 0 20px 6px; flex: 0 0 auto; }
      .codex-plus-tab-button { border: 1px solid rgba(255,255,255,.14); border-radius: 999px; background: transparent; color: #d1d5db; font: 12px system-ui, sans-serif; padding: 5px 10px; }
      .codex-plus-tab-button[data-active="true"] { background: #10a37f; color: white; border-color: #10a37f; }
      .codex-plus-panel[hidden] { display: none; }
      .codex-plus-api-key-section { display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 360px); align-items: start; }
      .codex-plus-api-key-copy { min-width: 0; }
      .codex-plus-api-key-list { display: grid; gap: 6px; min-width: 0; }
      .codex-plus-api-key-button {
        display: grid;
        grid-template-columns: 16px minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px;
        width: 100%;
        min-height: 38px;
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 7px;
        background: #3f3f46;
        color: #f3f4f6;
        padding: 7px 10px;
        text-align: left;
      }
      .codex-plus-api-key-button span:nth-child(2) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .codex-plus-api-key-button small { color: #a1a1aa; font-size: 11px; }
      .codex-plus-api-key-button[data-active="true"] { border-color: #10a37f; background: rgba(16,163,127,.16); }
      .codex-plus-api-key-button:disabled { cursor: not-allowed; opacity: .72; }
      .codex-plus-api-key-check { width: 8px; height: 8px; border: 1px solid currentColor; border-radius: 50%; }
      .codex-plus-api-key-button[data-active="true"] .codex-plus-api-key-check { border-color: #10a37f; background: #10a37f; }
      .codex-plus-api-key-empty { color: #a1a1aa; font-size: 12px; line-height: 1.45; padding: 8px 0; }
      @media (max-width: 680px) { .codex-plus-api-key-section { grid-template-columns: 1fr; } }
      .codex-plus-action-button,
      .codex-plus-issue-button { border: 1px solid rgba(255,255,255,.18); border-radius: 7px; background: #3f3f46; color: #f3f4f6; font: 12px system-ui, sans-serif; padding: 6px 8px; }
      .codex-plus-worktree-actions {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .codex-plus-form-field {
        display: grid;
        gap: 4px;
        margin-top: 10px;
        color: #d4d4d8;
        font: 12px system-ui, sans-serif;
        text-align: left;
      }
      .codex-plus-form-field input {
        width: min(520px, 72vw);
        border: 1px solid rgba(255,255,255,.18);
        border-radius: 8px;
        background: #18181b;
        color: #f4f4f5;
        padding: 8px 10px;
        font: 13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      }
      .codex-plus-form-message {
        min-height: 18px;
        margin-top: 10px;
        color: #a1a1aa;
        font: 12px system-ui, sans-serif;
        text-align: left;
      }
      .codex-plus-form-message[data-status="ok"] { color: #34d399; }
      .codex-plus-form-message[data-status="failed"] { color: #f87171; }
      .codex-plus-form-message[data-status="loading"] { color: #fbbf24; }
      .codex-plus-backend-status { display: grid; gap: 4px; min-width: 132px; justify-items: end; }
      .codex-plus-backend-label { color: #a1a1aa; font-size: 12px; }
      .codex-plus-backend-label[data-status="ok"] { color: #34d399; }
      .codex-plus-backend-label[data-status="failed"] { color: #f87171; }
      .codex-plus-user-script-warning { margin-top: 4px; color: #fbbf24; font-size: 12px; }
      .codex-plus-user-script-dirs { margin-top: 6px; color: #a1a1aa; font-size: 11px; line-height: 1.4; word-break: break-all; }
      .codex-plus-user-script-list { margin-top: 8px; display: grid; gap: 6px; }
      .codex-plus-user-script-item { display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; padding: 6px 8px; }
      .codex-plus-user-script-name { font-size: 12px; }
      .codex-plus-user-script-meta { margin-top: 2px; color: #a1a1aa; font-size: 11px; }
      .codex-plus-user-script-error { margin-top: 2px; color: #f87171; font-size: 11px; word-break: break-all; }
      .codex-plus-user-script-actions { display: grid; justify-items: end; gap: 8px; min-width: 120px; }
      .codex-plus-user-script-reload { border: 1px solid rgba(255,255,255,.18); border-radius: 7px; background: #3f3f46; color: #f3f4f6; font: 12px system-ui, sans-serif; padding: 6px 8px; }
      /* Keep injected surfaces on Codex's own semantic palette in both themes. */
      :root {
        --codex-plus-bg-primary: var(--color-token-bg-primary, var(--token-bg-primary, #fff));
        --codex-plus-bg-secondary: var(--color-token-bg-secondary, var(--token-bg-secondary, #f7f7f7));
        --codex-plus-bg-elevated: var(--color-token-dropdown-background, var(--color-token-bg-elevated-secondary, var(--codex-plus-bg-primary)));
        --codex-plus-bg-hover: var(--color-token-interactive-bg-secondary-hover, var(--token-list-hover-background, rgba(0,0,0,.06)));
        --codex-plus-bg-selected: var(--color-token-interactive-bg-secondary-selected, var(--codex-plus-bg-hover));
        --codex-plus-text: var(--color-token-text-primary, var(--token-text-primary, #171717));
        --codex-plus-text-secondary: var(--color-token-text-secondary, var(--token-text-secondary, #5d5d5d));
        --codex-plus-text-tertiary: var(--color-token-text-tertiary, var(--token-text-tertiary, #8a8a8a));
        --codex-plus-border: var(--color-token-border-light, var(--color-token-border, var(--token-border, rgba(0,0,0,.12))));
        --codex-plus-border-subtle: var(--color-token-border-subtle, var(--codex-plus-border));
        --codex-plus-focus: var(--color-token-focus-border, var(--color-border-focus, currentColor));
        --codex-plus-danger: var(--color-text-danger, var(--color-token-text-error, #dc2626));
        --codex-plus-danger-bg: var(--color-background-danger-soft, rgba(220,38,38,.1));
        --codex-plus-success: var(--color-text-success, #15803d);
        --codex-plus-warning: var(--color-text-warning, #a16207);
      }
      :where(.${moreMenuClass}, .${actionTooltipClass}, .${zedRemoteToastClass}, .codex-delete-toast, .codex-delete-confirm-overlay, .codex-plus-modal-overlay, .${codexPlusPageClass}) {
        color: var(--codex-plus-text);
        font-family: inherit;
      }
      .${moreMenuClass} {
        border-color: var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-elevated);
        color: var(--codex-plus-text);
        box-shadow: var(--ui-menu-shadow, var(--shadow-300, 0 8px 24px rgba(0,0,0,.16)));
      }
      .codex-session-more-menu-item { border-radius: var(--border-radius-sm, 6px); font-family: inherit; }
      .codex-session-more-menu-item:hover,
      .codex-session-more-menu-item:focus-visible { background: var(--codex-plus-bg-hover); }
      .${actionButtonClass} {
        width: var(--h-token-button-composer-sm, 28px);
        height: var(--h-token-button-composer-sm, 28px);
        border-radius: var(--border-radius-lg, 8px);
        color: var(--codex-session-action-color, var(--codex-plus-text-tertiary));
        font-family: inherit;
      }
      .${actionButtonClass}:hover,
      .${actionButtonClass}:focus-visible {
        background: var(--codex-session-action-hover-background, var(--codex-plus-bg-hover));
        color: var(--codex-session-action-hover-color, var(--codex-plus-text));
      }
      .${sessionShareButtonClass}:hover,
      .${sessionShareButtonClass}:focus-visible {
        background: var(--codex-plus-bg-hover);
        color: var(--codex-plus-text);
      }
      .${actionTooltipClass} {
        border-color: var(--codex-plus-border);
        border-radius: var(--border-radius-md, 6px);
        background: var(--color-token-bg-tooltip, var(--codex-plus-bg-elevated));
        color: var(--codex-plus-text);
        font-family: inherit;
        font-size: 12px;
        line-height: 16px;
        padding: 6px 8px;
        box-shadow: var(--tooltip-box-shadow, var(--shadow-200, 0 4px 12px rgba(0,0,0,.14)));
      }
      .codex-delete-confirm-overlay,
      .codex-plus-modal-overlay { background: var(--color-background-surface-under, rgba(0,0,0,.32)); backdrop-filter: blur(1px); }
      .codex-delete-confirm-content,
      .codex-plus-modal-content {
        border-color: var(--codex-plus-border);
        border-radius: var(--border-radius-xl, 12px);
        background: var(--codex-plus-bg-primary);
        color: var(--codex-plus-text);
        font-family: inherit;
        box-shadow: var(--shadow-400, 0 16px 48px rgba(0,0,0,.2));
      }
      .codex-delete-confirm-message,
      .codex-plus-row-description,
      .codex-plus-about,
      .codex-plus-service-tier-thread-label,
      .codex-plus-backend-label,
      .codex-plus-form-message,
      .codex-plus-user-script-dirs,
      .codex-plus-user-script-meta { color: var(--codex-plus-text-secondary); }
      .codex-delete-confirm-actions button,
      .codex-plus-action-button,
      .codex-plus-issue-button,
      .codex-plus-service-tier-button,
      .codex-plus-user-script-reload {
        min-height: 32px;
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-secondary);
        color: var(--codex-plus-text);
        font: inherit;
        font-size: 13px;
        line-height: 18px;
        padding: 5px 10px;
      }
      .codex-delete-confirm-actions button:hover,
      .codex-delete-confirm-actions button:focus-visible,
      .codex-plus-action-button:hover,
      .codex-plus-action-button:focus-visible,
      .codex-plus-issue-button:hover,
      .codex-plus-issue-button:focus-visible,
      .codex-plus-service-tier-button:hover,
      .codex-plus-service-tier-button:focus-visible,
      .codex-plus-user-script-reload:hover,
      .codex-plus-user-script-reload:focus-visible { background: var(--codex-plus-bg-hover); outline: none; }
      .codex-delete-confirm-actions [data-codex-delete-confirm="true"] {
        border-color: var(--color-border-danger, #dc2626);
        background: var(--color-background-danger-solid, #dc2626);
        color: var(--color-text-danger-solid, #fff);
      }
      .codex-plus-modal-close { border-color: var(--codex-plus-border); color: var(--codex-plus-text-secondary); border-radius: var(--border-radius-lg, 8px); }
      .codex-plus-modal-close:hover,
      .codex-plus-modal-close:focus-visible { background: var(--codex-plus-bg-hover); color: var(--codex-plus-text); outline: none; }
      .${codexPlusPageClass},
      .${codexPlusPageClass} .codex-plus-modal-content {
        background: var(--codex-plus-bg-primary) !important;
        color: var(--codex-plus-text) !important;
      }
      .${codexPlusPageClass} .codex-plus-modal-content { border-color: transparent; }
      .codex-plus-modal-body { scrollbar-color: var(--codex-plus-text-tertiary) transparent; }
      .codex-plus-modal-body::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--codex-plus-text-tertiary) 45%, transparent); background-clip: padding-box; }
      .codex-plus-modal-body::-webkit-scrollbar-thumb:hover { background: var(--codex-plus-text-tertiary); background-clip: padding-box; }
      .codex-plus-row { border-top-color: var(--codex-plus-border-subtle); }
      .codex-plus-toggle { background: var(--color-background-secondary-solid, var(--codex-plus-text-tertiary)); }
      .codex-plus-toggle span { background: var(--color-token-bg-primary, #fff); box-shadow: var(--switch-thumb-shadow, 0 1px 2px rgba(0,0,0,.16)); }
      .codex-plus-toggle[data-enabled="true"] { background: var(--color-background-primary-solid, var(--color-background-success-solid, #10a37f)); }
      .codex-plus-toggle[data-relay-unneeded="true"] { background: var(--color-background-primary-soft, var(--codex-plus-bg-hover)); color: var(--codex-plus-success); }
      .codex-plus-width-input,
      .codex-plus-form-field input {
        border: 1px solid var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-secondary);
        color: var(--codex-plus-text);
        font-family: inherit;
      }
      .codex-plus-width-input:focus,
      .codex-plus-form-field input:focus { border-color: var(--codex-plus-focus); outline: 2px solid color-mix(in srgb, var(--codex-plus-focus) 25%, transparent); outline-offset: 0; }
      .codex-plus-service-tier-button[data-active="true"],
      .codex-plus-tab-button[data-active="true"] {
        border-color: var(--color-border-primary, var(--codex-plus-focus));
        background: var(--color-background-primary-soft, var(--codex-plus-bg-selected));
        color: var(--color-text-primary, var(--codex-plus-text));
      }
      .codex-plus-tabs { gap: 4px; }
      .codex-plus-tab-button { border-color: var(--codex-plus-border); border-radius: var(--border-radius-lg, 8px); background: transparent; color: var(--codex-plus-text-secondary); font: inherit; font-size: 13px; padding: 6px 10px; }
      .codex-plus-tab-button:hover,
      .codex-plus-tab-button:focus-visible { background: var(--codex-plus-bg-hover); color: var(--codex-plus-text); outline: none; }
      .codex-plus-user-script-item { border-color: var(--codex-plus-border-subtle); border-radius: var(--border-radius-lg, 8px); background: var(--codex-plus-bg-secondary); }
      .codex-plus-api-key-button { border-color: var(--codex-plus-border); background: var(--codex-plus-bg-secondary); color: var(--codex-plus-text); font: inherit; }
      .codex-plus-api-key-button:hover:not(:disabled),
      .codex-plus-api-key-button:focus-visible { background: var(--codex-plus-bg-hover); outline: none; }
      .codex-plus-api-key-button[data-active="true"] { border-color: var(--color-border-primary, var(--codex-plus-focus)); background: var(--color-background-primary-soft, var(--codex-plus-bg-selected)); }
      .codex-plus-api-key-button small,
      .codex-plus-api-key-empty { color: var(--codex-plus-text-tertiary); }
      .codex-plus-api-key-button[data-active="true"] .codex-plus-api-key-check { border-color: var(--codex-plus-focus); background: var(--codex-plus-focus); }
      #${codexPlusSidebarNavId} .codex-plus-sidebar-nav-status,
      .codex-plus-backend-indicator { box-shadow: none; }
      #${codexPlusSidebarNavId} .codex-plus-sidebar-nav-status[data-status="ok"],
      .codex-plus-backend-indicator[data-status="ok"] { background: var(--codex-plus-success); }
      #${codexPlusSidebarNavId} .codex-plus-sidebar-nav-status[data-status="failed"],
      .codex-plus-backend-indicator[data-status="failed"] { background: var(--codex-plus-danger); }
      #${codexPlusSidebarNavId} .codex-plus-sidebar-nav-status[data-status="checking"],
      .codex-plus-backend-indicator[data-status="checking"] { background: var(--codex-plus-warning); }
      .${codexServiceTierBadgeClass} {
        height: 24px;
        border-color: var(--codex-plus-border);
        border-radius: var(--border-radius-lg, 8px);
        background: var(--codex-plus-bg-secondary);
        color: var(--codex-plus-text-secondary);
        font-family: inherit;
      }
      .${codexServiceTierBadgeClass}:hover { border-color: var(--codex-plus-focus); background: var(--codex-plus-bg-hover); }
      .${codexServiceTierBadgeClass}[data-tier="fast"] { border-color: var(--color-border-primary, var(--codex-plus-focus)); background: var(--color-background-primary-soft, var(--codex-plus-bg-selected)); color: var(--codex-plus-text); }
      .${codexServiceTierBadgeClass}[data-tier="failed"] { border-color: var(--color-border-danger, var(--codex-plus-danger)); background: var(--codex-plus-danger-bg); color: var(--codex-plus-danger); }
      .${codexServiceTierBadgeClass}[data-tier="unsupported"] { border-color: var(--color-border-warning, var(--codex-plus-border)); background: var(--color-background-warning-soft, var(--codex-plus-bg-hover)); color: var(--codex-plus-warning); }
      .${codexRelayApiKeyBadgeClass} { border-color: var(--codex-plus-border); background: var(--codex-plus-bg-secondary); color: var(--codex-plus-text-secondary); font-family: inherit; }
      .${codexRelayApiKeyBadgeClass}:hover,
      .${codexRelayApiKeyBadgeClass}:focus-visible { border-color: var(--codex-plus-focus); background: var(--codex-plus-bg-hover); color: var(--codex-plus-text); outline: none; }
      .codex-plus-form-message[data-status="ok"], .codex-plus-service-tier-status[data-status="ok"], .codex-plus-backend-label[data-status="ok"] { color: var(--codex-plus-success); }
      .codex-plus-form-message[data-status="failed"], .codex-plus-service-tier-status[data-status="failed"], .codex-plus-backend-label[data-status="failed"], .codex-plus-user-script-error { color: var(--codex-plus-danger); }
      .codex-plus-form-message[data-status="loading"], .codex-plus-service-tier-status[data-status="unsupported"], .codex-plus-user-script-warning, .codex-plus-model-compat-warning { color: var(--codex-plus-warning); }
    `;
    document.documentElement.appendChild(style);
  }
