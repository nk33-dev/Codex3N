  function loadBackendSettingsForStartup(attempt = 0) {
    loadBackendSettings().then((loaded) => {
      if (loaded) {
        scan();
        return;
      }
      if (attempt < 60) {
        setTimeout(() => loadBackendSettingsForStartup(attempt + 1), 250);
      }
    });
  }

  let syncBackendSettingsInFlight = false;
  async function syncBackendSettingsFromHeartbeat() {
    if (syncBackendSettingsInFlight) return;
    syncBackendSettingsInFlight = true;
    try {
      const previousConversationView = !!codexPlusSettings().conversationView;
      const loaded = await loadBackendSettingsState();
      if (loaded) {
        syncOfficialUsagePolicy();
        if (previousConversationView !== !!codexPlusSettings().conversationView) {
          refreshConversationView();
        }
      }
    } finally {
      syncBackendSettingsInFlight = false;
    }
  }

  async function setBackendSetting(key, value) {
    const seq = ++codexPlusBackendSettingsSeq;
    codexPlusBackendSettings = { ...codexPlusBackendSettings, [key]: value };
    codexPlusBackendSettingsLoaded = true;
    refreshCodexPlusBackendToggles();
    try {
      const settings = await postJson("/settings/set", { [key]: value });
      if (seq === codexPlusBackendSettingsSeq) {
        codexPlusBackendSettings = { ...codexPlusBackendSettings, ...settings };
      }
    } finally {
      refreshCodexPlusBackendToggles();
    }
  }

  function refreshCodexPlusBackendToggles() {
    document.querySelectorAll(".codex-plus-toggle[data-codex-backend-setting]").forEach((button) => {
      const key = button.getAttribute("data-codex-backend-setting");
      button.dataset.enabled = String(!!codexPlusBackendSettings[key]);
    });
    syncStepwisePanel();
    renderCodexPlusMenu();
    scan();
  }

  let codexPlusUserScripts = { enabled: true, builtin_dir: "", user_dir: "", scripts: [] };
  let codexPlusRelayApiKeys = { status: "loading", enabled: false, providerId: "", providerName: "", activeKeyId: "", keys: [] };
  let codexPlusRelayApiKeySwitching = false;
  let codexPlusRelayApiKeysPromise = null;
  let codexPlusBackendStatus = window.__codexPlusBackendStatus || { status: "checking", message: "正在检查后端…" };
  let codexPlusBackendCheckSeq = 0;
  let codexPlusBackendCheckInFlight = false;
  let codexPlusBackendFailureCount = 0;
  const CODEX_PLUS_BACKEND_FAILURE_THRESHOLD = 3;
  let codexPlusBridgeFailureCount = 0;
  const CODEX_PLUS_BRIDGE_FAILURE_THRESHOLD = 3;
  const codexPlusBackendGeneration = (Number(window.__codexPlusBackendGeneration) || 0) + 1;
  window.__codexPlusBackendGeneration = codexPlusBackendGeneration;

  function recordCodexPlusBridgeHealth(field) {
    if (codexPlusBackendGeneration !== window.__codexPlusBackendGeneration) return;
    const health = window.__codexPlusBridgeHealth || (window.__codexPlusBridgeHealth = {});
    health[field] = Date.now();
  }

  function recordCodexPlusBridgeSuccess() {
    recordCodexPlusBridgeHealth("lastSuccessAt");
    codexPlusBridgeFailureCount = 0;
  }

  function recordCodexPlusBridgeAttempt() {
    recordCodexPlusBridgeHealth("lastAttemptAt");
  }

  function recordCodexPlusBridgeFailure() {
    codexPlusBridgeFailureCount += 1;
  }

  function renderBackendStatus() {
    const bridgeDegraded = codexPlusBridgeFailureCount >= CODEX_PLUS_BRIDGE_FAILURE_THRESHOLD;
    const rawStatus = codexPlusBackendStatus.status || "failed";
    const status = bridgeDegraded && rawStatus === "ok" ? "degraded" : rawStatus;
    if (codexPlusBackendStatus.version) {
      codexPlusVersion = codexPlusBackendStatus.version;
      document.querySelectorAll("[data-codex-plus-version]").forEach((node) => {
        node.textContent = `Codex++ ${codexPlusVersion}`;
      });
    }
    const labelFallback = status === "ok" ? "后端已连接" : status === "degraded" ? "桥接降级，自动修复中" : "未连接";
    const label = document.querySelector("[data-codex-backend-status]");
    if (label) {
      label.dataset.status = status;
      label.textContent = status === "degraded" ? labelFallback : (codexPlusBackendStatus.message || labelFallback);
    }
    document.querySelectorAll("[data-codex-backend-indicator]").forEach((indicator) => {
      indicator.dataset.status = status;
      indicator.title = status === "ok" ? "后端已连接" : status === "degraded" ? labelFallback : status === "checking" ? "正在检查后端" : "未连接";
    });
    const sidebarStatus = document.querySelector(`#${codexPlusSidebarNavId} .codex-plus-sidebar-nav-status`);
    if (sidebarStatus) {
      sidebarStatus.dataset.status = status;
      sidebarStatus.title = status === "ok" ? "后端已连接" : status === "degraded" ? labelFallback : status === "checking" ? "正在检查后端" : "未连接";
    }
    refreshCodexServiceTierControls();
    installCodexRelayApiKeyBadge();
  }

  function withBackendTimeout(request) {
    return Promise.race([
      request,
      new Promise((resolve) => setTimeout(() => resolve({ status: "failed", message: "后端检查超时", timeout: true }), 2000)),
    ]);
  }

  async function checkBackendStatus() {
    if (codexPlusBackendCheckInFlight) return;
    codexPlusBackendCheckInFlight = true;
    const seq = ++codexPlusBackendCheckSeq;
    try {
      const nextStatus = await postJson("/backend/status", {});
      if (seq !== codexPlusBackendCheckSeq || codexPlusBackendGeneration !== window.__codexPlusBackendGeneration) return;
      if (nextStatus?.status === "ok") {
        codexPlusBackendFailureCount = 0;
        codexPlusBackendStatus = window.__codexPlusBackendStatus = nextStatus;
        if (typeof nextStatus.hideOfficialUsageAlert === "boolean") {
          window.__CODEX_PLUS_HIDE_OFFICIAL_USAGE_ALERT__ = nextStatus.hideOfficialUsageAlert;
          syncOfficialUsagePolicy();
        }
        void syncBackendSettingsFromHeartbeat();
      } else {
        codexPlusBackendFailureCount += 1;
        sendCodexPlusDiagnostic("backend_check_failed", {
          status: nextStatus?.status || "unknown",
          message: nextStatus?.message || "",
          timeout: !!nextStatus?.timeout,
          consecutiveFailures: codexPlusBackendFailureCount,
        });
        if (codexPlusBackendFailureCount >= CODEX_PLUS_BACKEND_FAILURE_THRESHOLD) {
          codexPlusBackendStatus = window.__codexPlusBackendStatus = nextStatus;
        }
      }
      renderBackendStatus();
    } finally {
      codexPlusBackendCheckInFlight = false;
    }
  }

  async function openManagerFromCodex() {
    const result = await postJson("/manager/open", {});
    if (result.status === "ok") {
      showToast("管理工具已打开", null);
    } else {
      showToast(result.message || "打开管理工具失败", null);
    }
  }

  function scheduleBackendHeartbeat() {
    if (codexPlusBackendGeneration !== window.__codexPlusBackendGeneration) return;
    if (window.__codexPlusBackendHeartbeat &&
        window.__codexPlusBackendHeartbeatGeneration === codexPlusBackendGeneration) return;
    if (window.__codexPlusBackendHeartbeat) clearInterval(window.__codexPlusBackendHeartbeat);
    window.__codexPlusBackendHeartbeatGeneration = codexPlusBackendGeneration;
    window.__codexPlusBackendHeartbeat = setInterval(checkBackendStatus, 5000);
    checkBackendStatus();
  }

  function userScriptStatusLabel(status) {
    return { loaded: "已加载", failed: "失败", disabled: "已禁用", not_loaded: "未加载", loading: "加载中" }[status] || status || "未知";
  }

  function renderUserScripts() {
    const enabledToggle = document.querySelector("[data-codex-user-scripts-enabled]");
    if (enabledToggle) enabledToggle.dataset.enabled = String(!!codexPlusUserScripts.enabled);
    const dirs = document.querySelector("[data-codex-user-script-dirs]");
    if (dirs) dirs.textContent = `内置：${codexPlusUserScripts.builtin_dir || "未找到"}  用户：${codexPlusUserScripts.user_dir || "未找到"}`;
    const list = document.querySelector("[data-codex-user-script-list]");
    if (!list) return;
    if (!codexPlusUserScripts.scripts?.length) {
      list.textContent = "未发现用户脚本。";
      return;
    }
    list.innerHTML = codexPlusUserScripts.scripts.map((script) => `
      <div class="codex-plus-user-script-item">
        <div>
          <div class="codex-plus-user-script-name">${escapeHtml(script.name || script.key)}</div>
          <div class="codex-plus-user-script-meta">${script.source === "builtin" ? "内置" : "用户"} · ${userScriptStatusLabel(script.status)}</div>
          ${script.error ? `<div class="codex-plus-user-script-error">${escapeHtml(script.error)}</div>` : ""}
        </div>
        <button type="button" class="codex-plus-toggle" data-codex-user-script-key="${escapeHtml(script.key)}" data-enabled="${String(!!script.enabled)}"><span></span></button>
      </div>
    `).join("");
  }

  async function loadUserScripts(path = "/user-scripts/list", payload = {}) {
    const requestPayload = path === "/user-scripts/list"
      ? { ...payload, runtime_status: window.__codexPlusUserScripts?.scripts || {} }
      : payload;
    const result = await postJson(path, requestPayload);
    if (result?.scripts) {
      codexPlusUserScripts = result;
      renderUserScripts();
    }
  }

  function renderRelayApiKeys() {
    const summary = document.querySelector("[data-codex-relay-api-key-summary]");
    const list = document.querySelector("[data-codex-relay-api-key-list]");
    if (!summary || !list) return;
    if (codexPlusRelayApiKeys.status === "loading") {
      summary.textContent = "正在读取当前供应商…";
      list.textContent = "";
      return;
    }
    if (codexPlusRelayApiKeys.status !== "ok") {
      summary.textContent = codexPlusRelayApiKeys.message || "读取 Key 失败";
      list.textContent = "";
      return;
    }
    summary.textContent = codexPlusRelayApiKeys.enabled
      ? `当前供应商：${codexPlusRelayApiKeys.providerName || codexPlusRelayApiKeys.providerId || "未命名"}`
      : "供应商配置切换尚未启用";
    const keys = Array.isArray(codexPlusRelayApiKeys.keys) ? codexPlusRelayApiKeys.keys : [];
    if (!keys.length) {
      list.innerHTML = '<div class="codex-plus-api-key-empty">当前供应商没有可切换的命名 Key，请先在管理工具中添加。</div>';
      return;
    }
    list.innerHTML = keys.map((entry) => {
      const active = entry.id === codexPlusRelayApiKeys.activeKeyId;
      return `<button type="button" class="codex-plus-api-key-button" data-codex-relay-api-key-id="${escapeHtml(entry.id)}" data-active="${String(active)}" ${!codexPlusRelayApiKeys.enabled || codexPlusRelayApiKeySwitching ? "disabled" : ""}>
        <span class="codex-plus-api-key-check" aria-hidden="true"></span>
        <span>${escapeHtml(entry.name || "未命名 Key")}</span>
        <small>${active ? "使用中" : "切换"}</small>
      </button>`;
    }).join("");
    refreshCodexRelayApiKeyBadges();
  }

  async function loadRelayApiKeys(force = false) {
    if (codexPlusRelayApiKeysPromise) return codexPlusRelayApiKeysPromise;
    if (!force && codexPlusRelayApiKeys.status === "ok") return codexPlusRelayApiKeys;
    codexPlusRelayApiKeys = { ...codexPlusRelayApiKeys, status: "loading" };
    renderRelayApiKeys();
    codexPlusRelayApiKeysPromise = postJson("/relay-api-keys", {})
      .then((result) => {
        codexPlusRelayApiKeys = result && typeof result === "object"
          ? result
          : { status: "failed", message: "读取 Key 失败", keys: [] };
        renderRelayApiKeys();
        return codexPlusRelayApiKeys;
      })
      .finally(() => { codexPlusRelayApiKeysPromise = null; });
    return codexPlusRelayApiKeysPromise;
  }

  async function selectRelayApiKey(keyId) {
    if (!keyId || codexPlusRelayApiKeySwitching || keyId === codexPlusRelayApiKeys.activeKeyId) return;
    codexPlusRelayApiKeySwitching = true;
    renderRelayApiKeys();
    try {
      const result = await postJson("/relay-api-keys/select", { keyId });
      if (result?.status !== "ok") {
        showToast(result?.message || "切换 Key 失败", null);
        return;
      }
      codexPlusRelayApiKeys = { ...codexPlusRelayApiKeys, activeKeyId: result.activeKeyId || keyId };
      codexModelCatalogLoadedAt = 0;
      await loadCodexModelCatalog(true);
      refreshCodexModelQueries();
      scheduleCodexModelWhitelistRefresh();
      showToast("Key 已切换，可用模型已刷新", null);
    } finally {
      codexPlusRelayApiKeySwitching = false;
      await loadRelayApiKeys(true);
    }
  }

  function selectCodexPlusTab(tab) {
    document.querySelectorAll(".codex-plus-modal-content").forEach((modal) => {
      modal.dataset.codexPlusActiveTab = tab;
    });
    document.querySelectorAll("[data-codex-plus-tab]").forEach((button) => {
      button.dataset.active = String(button.getAttribute("data-codex-plus-tab") === tab);
    });
    document.querySelectorAll("[data-codex-plus-panel]").forEach((panel) => {
      panel.hidden = panel.getAttribute("data-codex-plus-panel") !== tab;
    });
    if (tab === "userScripts") loadUserScripts();
    if (tab === "apiKeys") void loadRelayApiKeys();
  }

  function setCodexPlusSidebarNavActive(active) {
    const nav = document.getElementById(codexPlusSidebarNavId);
    const button = nav?.querySelector("button");
    if (!button) return;
    button.dataset.active = String(active);
    button.setAttribute("aria-current", active ? "page" : "false");
  }

  function positionCodexPlusPage(overlay) {
    if (!overlay?.classList?.contains(codexPlusPageClass)) return;
    const sidebar = document.querySelector("aside.app-shell-left-panel");
    const rect = sidebar?.getBoundingClientRect?.();
    const left = rect && rect.width > 0 ? Math.max(0, rect.right) : 0;
    overlay.style.left = `${left}px`;
    overlay.style.top = "0px";
  }

  function codexPlusHostUsesLightTheme() {
    const root = document.documentElement;
    const body = document.body;
    const explicitTheme = [
      root?.getAttribute("data-theme"),
      body?.getAttribute("data-theme"),
      root?.getAttribute("data-color-scheme"),
      body?.getAttribute("data-color-scheme"),
    ].filter(Boolean).join(" ").toLowerCase();
    if (/\b(light|light-mode|theme-light)\b/.test(explicitTheme)) return true;
    if (/\b(dark|dark-mode|theme-dark)\b/.test(explicitTheme)) return false;

    const themeClasses = [root?.className, body?.className]
      .filter((value) => typeof value === "string")
      .join(" ")
      .toLowerCase();
    if (/(^|\s)(light|light-mode|theme-light)(\s|$)/.test(themeClasses)) return true;
    if (/(^|\s)(dark|dark-mode|theme-dark)(\s|$)/.test(themeClasses)) return false;

    return !window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  }

  function applyCodexPlusTheme(overlay) {
    if (!overlay?.style) return;
    const light = codexPlusHostUsesLightTheme();
    const palette = light ? {
      bgPrimary: "#ffffff",
      bgSecondary: "#f7f7f7",
      bgElevated: "#ffffff",
      bgHover: "rgba(0,0,0,.06)",
      bgSelected: "rgba(0,0,0,.08)",
      text: "#171717",
      textSecondary: "#5d5d5d",
      textTertiary: "#8a8a8a",
      border: "rgba(0,0,0,.12)",
      borderSubtle: "rgba(0,0,0,.08)",
    } : {
      bgPrimary: "#212121",
      bgSecondary: "#2f2f2f",
      bgElevated: "#2f2f2f",
      bgHover: "rgba(255,255,255,.08)",
      bgSelected: "rgba(255,255,255,.12)",
      text: "#f3f4f6",
      textSecondary: "#d1d5db",
      textTertiary: "#a1a1aa",
      border: "rgba(255,255,255,.14)",
      borderSubtle: "rgba(255,255,255,.08)",
    };
    const variables = {
      "--codex-plus-bg-primary": palette.bgPrimary,
      "--codex-plus-bg-secondary": palette.bgSecondary,
      "--codex-plus-bg-elevated": palette.bgElevated,
      "--codex-plus-bg-hover": palette.bgHover,
      "--codex-plus-bg-selected": palette.bgSelected,
      "--codex-plus-text": palette.text,
      "--codex-plus-text-secondary": palette.textSecondary,
      "--codex-plus-text-tertiary": palette.textTertiary,
      "--codex-plus-border": palette.border,
      "--codex-plus-border-subtle": palette.borderSubtle,
    };
    Object.entries(variables).forEach(([name, value]) => overlay.style.setProperty(name, value));
    overlay.dataset.codexPlusTheme = light ? "light" : "dark";
  }
