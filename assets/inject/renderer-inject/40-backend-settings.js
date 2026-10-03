      }
      if (method === "browser-use-session-route-capture") {
        const threadId = String(
          candidate.params?.conversationId
          || candidate.params?.conversation_id
          || candidate.conversationId
          || candidate.conversation_id
          || ""
        ).trim();
        if (threadId) return threadId;
      }
      if (method === "browser-sidebar-browser-use-state") {
        const isActive = candidate.params?.isActive ?? candidate.params?.is_active
          ?? candidate.isActive ?? candidate.is_active;
        if (isActive !== true) continue;
        const threadId = String(
          candidate.params?.conversationId
          || candidate.params?.conversation_id
          || candidate.conversationId
          || candidate.conversation_id
          || ""
        ).trim();
        if (threadId) return threadId;
      }
      if (current.depth >= 4) continue;
      for (const key of ["message", "response", "detail", "data", "payload", "params", "request"]) {
        const nested = candidate[key];
        if (nested && typeof nested === "object") {
          queue.push({ value: nested, depth: current.depth + 1 });
        }
      }
    }
    return "";
  }

  function requestCodexRemoteSessionRecovery(threadId, attempt) {
    const payload = { thread_id: threadId };
    const testHook = window.__CODEX_PLUS_TEST_REMOTE_RECOVERY__;
    const request = typeof testHook === "function"
      ? Promise.resolve(testHook(payload, attempt))
      : postJson("/remote-control-session/recover", payload);
    return request.then((result) => {
      if (attempt === 0
        || result?.message === "Remote Control session recovery complete"
        || result?.message === "Remote Control session catalog recovery complete") {
        sendCodexPlusDiagnostic("remote_session_recovery_requested", {
          threadId,
          attempt,
          status: result?.status || "",
          message: result?.message || "",
          changedSessionFiles: result?.changed_session_files || 0,
          catalogRowsInserted: result?.sqlite_catalog_rows_inserted || 0,
        });
      }
      return result;
    }).catch((error) => {
      if (attempt === 0) {
        sendCodexPlusDiagnostic("remote_session_recovery_failed", {
          threadId,
          attempt,
          errorName: error?.name || "",
          errorMessage: error?.message || String(error),
        });
      }
      return null;
    });
  }

  function scheduleCodexRemoteSessionRecovery(threadId) {
    if (!codexRemoteSessionProviderNormalizationEnabled()) return false;
    const normalizedThreadId = String(threadId || "").trim();
    if (!normalizedThreadId || normalizedThreadId.length > 128) return false;
    window.__codexPlusRemoteSessionRecoveryPending = window.__codexPlusRemoteSessionRecoveryPending || new Map();
    const pending = window.__codexPlusRemoteSessionRecoveryPending;
    if (pending.has(normalizedThreadId)) return false;
    const retryOffsets = [100, 350, 800, 1600, 3000];
    const state = { timer: 0 };
    const finish = () => {
      if (state.timer) window.clearTimeout(state.timer);
      state.timer = 0;
      if (pending.get(normalizedThreadId) === state) pending.delete(normalizedThreadId);
    };
    const runAttempt = async (attempt) => {
      state.timer = 0;
      if (!codexRemoteSessionProviderNormalizationEnabled()) {
        finish();
        return;
      }
      const result = await requestCodexRemoteSessionRecovery(normalizedThreadId, attempt);
      const message = String(result?.message || "");
      if (message === "Remote Control session recovery complete"
        || message === "Remote Control session catalog recovery complete"
        || message === "Remote Control session recovery is disabled for the active profile") {
        finish();
        return;
      }
      const nextAttempt = attempt + 1;
      if (nextAttempt >= retryOffsets.length) {
        finish();
        return;
      }
      const nextDelay = retryOffsets[nextAttempt] - retryOffsets[attempt];
      state.timer = window.setTimeout(() => void runAttempt(nextAttempt), nextDelay);
    };
    state.timer = window.setTimeout(() => void runAttempt(0), retryOffsets[0]);
    pending.set(normalizedThreadId, state);
    return true;
  }

  function observeCodexRemoteSessionNotification(value) {
    const threadId = codexRemoteSessionStartedThreadId(value);
    return threadId ? scheduleCodexRemoteSessionRecovery(threadId) : false;
  }

  function installCodexRemoteSessionRecoveryListener() {
    if (window.__codexPlusRemoteSessionRecoveryInstalled === codexRemoteSessionRecoveryVersion) return true;
    if (window.__codexPlusRemoteSessionRecoveryMessageHandler) {
      window.removeEventListener("message", window.__codexPlusRemoteSessionRecoveryMessageHandler, true);
    }
    if (window.__codexPlusRemoteSessionRecoveryViewHandler) {
      window.removeEventListener("codex-message-from-view", window.__codexPlusRemoteSessionRecoveryViewHandler, true);
    }
    const messageHandler = (event) => {
      if (event?.source !== window) return false;
      const origin = String(event?.origin || "");
      if (origin && origin !== "null" && origin !== window.location.origin) return false;
      return observeCodexRemoteSessionNotification(event?.data);
    };
    const viewHandler = (event) => observeCodexRemoteSessionNotification(event?.detail);
    window.__codexPlusRemoteSessionRecoveryMessageHandler = messageHandler;
    window.__codexPlusRemoteSessionRecoveryViewHandler = viewHandler;
    window.addEventListener("message", messageHandler, true);
    window.addEventListener("codex-message-from-view", viewHandler, true);
    window.__codexPlusRemoteSessionRecoveryInstalled = codexRemoteSessionRecoveryVersion;
    sendCodexPlusDiagnostic("remote_session_recovery_listener_installed", {
      version: codexRemoteSessionRecoveryVersion,
    });
    return true;
  }

  function installCodexRemoteSessionDispatcherSubscription(dispatcher, assetPrefix = "") {
    if (!dispatcher || typeof dispatcher.subscribe !== "function") return false;
    if (window.__codexPlusRemoteSessionRecoveryDispatcher === dispatcher
        && window.__codexPlusRemoteSessionRecoveryDispatcherVersion === codexRemoteSessionRecoveryVersion) {
      return true;
    }
    if (typeof window.__codexPlusRemoteSessionRecoveryDispatcherUnsubscribe === "function") {
      try {
        window.__codexPlusRemoteSessionRecoveryDispatcherUnsubscribe();
      } catch {
      }
    }
    const handler = (payload) => {
      if (observeCodexRemoteSessionNotification(payload)) return true;
      const params = payload && typeof payload === "object" ? payload : {};
      if (observeCodexRemoteSessionNotification({
        method: "thread/started",
        params,
      })) return true;
      return observeCodexRemoteSessionNotification({
        method: "thread/started",
        params: { thread: params },
      });
    };
    const browserUseHandler = (payload) => observeCodexRemoteSessionNotification({
      type: "browser-sidebar-browser-use-state",
      params: payload && typeof payload === "object" ? payload : {},
    });
    const unsubscribers = [
      dispatcher.subscribe("thread/started", handler),
      dispatcher.subscribe("browser-sidebar-browser-use-state", browserUseHandler),
    ];
    window.__codexPlusRemoteSessionRecoveryDispatcher = dispatcher;
    window.__codexPlusRemoteSessionRecoveryDispatcherHandler = handler;
    window.__codexPlusRemoteSessionRecoveryDispatcherUnsubscribe = () => {
      for (const unsubscribe of unsubscribers) {
        if (typeof unsubscribe !== "function") continue;
        try {
          unsubscribe();
        } catch {
        }
      }
    };
    window.__codexPlusRemoteSessionRecoveryDispatcherVersion = codexRemoteSessionRecoveryVersion;
    sendCodexPlusDiagnostic("remote_session_dispatcher_subscription_installed", { assetPrefix });
    return true;
  }

  function codexServiceTierRequestOverride(message, skipFetchEnvelope = false) {
    if (!message || typeof message !== "object") return message;
    if (!skipFetchEnvelope && message.type === "fetch" && typeof message.url === "string") {
      const urlPrefix = "vscode://codex/";
      if (!message.url.startsWith(urlPrefix)) return message;
      const requestType = message.url.slice(urlPrefix.length).split(/[?#]/, 1)[0];
      let params = null;
      let bodyWasString = false;
      if (typeof message.body === "string") {
        try {
          params = JSON.parse(message.body);
          bodyWasString = true;
        } catch (_) {
          return message;
        }
      } else if (message.body && typeof message.body === "object") {
        params = message.body;
      } else {
        return message;
      }
      if (!params || typeof params !== "object" || Array.isArray(params)) return message;
      const bodyHadType = Object.prototype.hasOwnProperty.call(params, "type");
      const originalBodyType = params.type;
      const logicalMessage = { ...params, type: requestType };
      const patchedMessage = codexServiceTierRequestOverride(logicalMessage, true);
      if (patchedMessage === logicalMessage) return message;
      const nextParams = { ...patchedMessage };
      delete nextParams.type;
      if (bodyHadType) nextParams.type = originalBodyType;
      return {
        ...message,
        body: bodyWasString ? JSON.stringify(nextParams) : nextParams,
      };
    }
    if (message.type === "send-cli-request-for-host") {
      const method = String(message.method || "");
      const params = applyCodexServiceTierRequestOverride(method, message.params);
      return params === message.params ? message : { ...message, params };
    }
    if (message.type === "mcp-request" && message.request && typeof message.request === "object") {
      const method = String(message.request.method || "");
      const params = applyCodexServiceTierRequestOverride(method, message.request.params);
      if (params === message.request.params) return message;
      return { ...message, request: { ...message.request, params } };
    }
    if (message.type === "worker-request" && message.request && typeof message.request === "object") {
      const method = String(message.request.method || "");
      const params = applyCodexServiceTierRequestOverride(method, message.request.params);
      if (params === message.request.params) return message;
      return { ...message, request: { ...message.request, params } };
    }
    if (message.type === "thread-prewarm-start" && message.request && typeof message.request === "object") {
      const params = applyCodexServiceTierRequestOverride("thread/start", message.request.params);
      if (params === message.request.params) return message;
      return { ...message, request: { ...message.request, params } };
    }
    if (message.type === "start-conversation") {
      const nextMessage = applyCodexServiceTierRequestOverride("thread/start", message);
      return nextMessage === message ? message : nextMessage;
    }
    if (message.type === "prewarm-thread-start-for-host" && message.params && typeof message.params === "object") {
      const params = applyCodexServiceTierRequestOverride("thread/start", message.params);
      return params === message.params ? message : { ...message, params };
    }
    if (message.type === "start-thread-for-host") {
      const params = applyCodexServiceTierRequestOverride("thread/start", message);
      return params === message ? message : params;
    }
    if (message.type === "start-turn-for-host" && message.params && typeof message.params === "object") {
      const params = applyCodexServiceTierRequestOverride("turn/start", message.params, message.conversationId);
      return params === message.params ? message : { ...message, params };
    }
    return message;
  }

  function codexServiceTierDispatcherFromModule(module) {
    const directSingleton = module?.idt;
    if (directSingleton
        && typeof directSingleton === "object"
        && typeof directSingleton.dispatchMessage === "function"
        && typeof directSingleton.subscribe === "function") {
      return directSingleton;
    }
    const values = module && typeof module === "object" ? Object.values(module) : [];
    const singleton = values.find((candidate) => candidate
      && typeof candidate === "object"
      && typeof candidate.dispatchMessage === "function"
      && typeof candidate.subscribe === "function");
    if (singleton) return singleton;
    const dispatcherClass = values.find((candidate) => typeof candidate === "function"
      && typeof candidate.getInstance === "function"
      && typeof candidate.prototype?.dispatchMessage === "function");
    return dispatcherClass?.getInstance?.() || null;
  }

  const serviceTierDispatcherPatchMaxMisses = 8;
  let serviceTierDispatcherPatchMissCount = 0;
  let serviceTierDispatcherPatchDisabled = false;
  let serviceTierDispatcherPatchPromise = null;

  function codexServiceTierDispatcherPatchable(dispatcher) {
    if (!dispatcher || typeof dispatcher !== "object") return false;
    try {
      if (!Object.isExtensible(dispatcher)) return false;
      for (const key of ["__codexServiceTierOriginalDispatchMessage", "dispatchMessage"]) {
        const descriptor = Object.getOwnPropertyDescriptor(dispatcher, key);
        if (descriptor && descriptor.writable === false && typeof descriptor.set !== "function") return false;
      }
      return true;
    } catch {
      // Codex 26.908 RPC stubs can throw even while being inspected.
      return false;
    }
  }

  // issue #1960：这是 installAppServerModelRequestPatch（#1324）和插件市场那两层的同一个缺陷。
  // 补丁挂在 scanLightweight() 里每轮都跑，而早退守卫只在装上之后才写入，
  // Codex 侧 asset 改名后就永远装不上，于是每轮 scan 重新拉一遍全部 app asset，
  // 而且每轮都发一条相同的诊断。首次失败仍上报以便定位，之后噤声，连续失败够多次就停掉这一层。
  function installCodexServiceTierDispatcherPatch() {
    if (window.__codexServiceTierRequestOverrideInstalled === codexServiceTierRequestOverrideVersion) return;
    if (serviceTierDispatcherPatchDisabled) return;
    // 上一轮没跑完就不要再起一轮：loadDispatcher() 会依次试三个前缀，
    // 没有这道去重时 scan 的频率就直接变成并发全量扫描的频率。
    if (serviceTierDispatcherPatchPromise) return;
    const loadDispatcher = async () => {
      const errors = [];
      for (const assetPrefix of ["setting-storage-", "vscode-api-", "app-initial-"]) {
        try {
          const module = await loadCodexAppModule(assetPrefix);
          const dispatcher = codexServiceTierDispatcherFromModule(module);
          if (dispatcher) return { dispatcher, assetPrefix };
          errors.push(`${assetPrefix}: dispatcher export unavailable`);
        } catch (error) {
          errors.push(`${assetPrefix}: ${error?.message || String(error)}`);
        }
      }
      throw new Error(`Codex dispatcher unavailable (${errors.join("; ")})`);
    };
    const patch = async () => {
      try {
        const { dispatcher, assetPrefix } = await loadDispatcher();
        if (!codexServiceTierDispatcherPatchable(dispatcher)) {
          throw new Error(`dispatcher is a non-writable RPC stub (${assetPrefix})`);
        }
        if (!dispatcher.__codexServiceTierOriginalDispatchMessage) {
          dispatcher.__codexServiceTierOriginalDispatchMessage = dispatcher.dispatchMessage.bind(dispatcher);
        }
        dispatcher.dispatchMessage = (type, payload) => {
          return dispatchCodexPlusMessage(dispatcher, type, payload);
        };
        installCodexRemoteSessionDispatcherSubscription(dispatcher, assetPrefix);
        window.__codexServiceTierRequestOverrideInstalled = codexServiceTierRequestOverrideVersion;
        serviceTierDispatcherPatchMissCount = 0;
        sendCodexPlusDiagnostic("service_tier_dispatcher_patch_installed", { assetPrefix });
      } catch (error) {
        serviceTierDispatcherPatchMissCount += 1;
        if (serviceTierDispatcherPatchMissCount === 1) {
          sendCodexPlusDiagnostic("service_tier_dispatcher_patch_failed", {
            errorName: error?.name || "",
            errorMessage: error?.message || String(error),
          });
        }
        if (serviceTierDispatcherPatchMissCount >= serviceTierDispatcherPatchMaxMisses
            && !serviceTierDispatcherPatchDisabled) {
          serviceTierDispatcherPatchDisabled = true;
          sendCodexPlusDiagnostic("service_tier_dispatcher_patch_skipped", {
            misses: serviceTierDispatcherPatchMissCount,
          });
        }
      } finally {
        serviceTierDispatcherPatchPromise = null;
      }
    };
    serviceTierDispatcherPatchPromise = patch();
  }

  // --- Dictation / Voice patch for apikey (ported from v1.2.34 preload) ---
  const codexDictationSupportVersion = "1";
  function codexDictationSupportModuleCandidates() {
    const prefixes = ["use-is-dictation-supported-", "use-dictation-", "app-initial-", "setting-storage-", "vscode-api-"];
    return prefixes;
  }
  async function installDictationSupportPatch() {
    if (window.__codexDictationSupportPatched === codexDictationSupportVersion) return;
    for (const prefix of codexDictationSupportModuleCandidates()) {
      try {
        const module = await loadOptionalCodexAppModule(prefix);
        if (!module) continue;
        for (const key of Object.keys(module)) {
          const fn = module[key];
          if (typeof fn !== "function") continue;
          let src = "";
          try { src = String(fn); } catch {}
          if (!src.includes("authMethod") || !src.includes("chatgpt")) continue;
          if (fn.__codexDictationPatched === codexDictationSupportVersion) continue;
          const original = fn;
          const wrapped = function(...args) {
            try {
              const result = original.apply(this, args);
              if (result === false) {
                const hasApikey = args.some(arg => arg && typeof arg === "object" && (arg.authMethod === "apikey" || arg.authMethod === "apiKey"));
                if (hasApikey) return true;
                if (typeof codexPlusSettings === "function" && codexPlusSettings().serviceTierControls) return true;
              }
              return result;
            } catch (e) {
              return original.apply(this, args);
            }
          };
          wrapped.__codexDictationPatched = codexDictationSupportVersion;
          try { module[key] = wrapped; } catch {}
          sendCodexPlusDiagnostic("dictation_support_patched", { prefix, key, version: codexDictationSupportVersion });
          window.__codexDictationSupportPatched = codexDictationSupportVersion;
          return;
        }
      } catch {}
    }
    // Fallback: DOM enforcement for voice button when module patch not found
    try {
      if (!window.__codexDictationDomPatched) {
        window.__codexDictationDomPatched = true;
        const enforceVoice = () => {
          const selectors = ['button[aria-label*="Voice"]','button[aria-label*="Dictation"]','button[aria-label*="voice"]','[data-testid*="voice"]','[data-testid*="dictation"]','button:has(svg)'];
          // generic: find buttons with microphone icon
          document.querySelectorAll('button').forEach(btn => {
            const label = (btn.getAttribute("aria-label") || btn.textContent || "").toLowerCase();
            if (label.includes("voice") || label.includes("dictation") || label.includes("microphone") || label.includes("mic")) {
              if (btn.hasAttribute("disabled")) {
                btn.removeAttribute("disabled");
                btn.setAttribute("aria-disabled","false");
                btn.style.opacity = "";
                btn.style.pointerEvents = "";
              }
            }
          });
        };
        setInterval(enforceVoice, 1500);
        enforceVoice();
      }
    } catch {}
  }

  async function loadBackendSettingsState() {
    const seq = codexPlusBackendSettingsSeq;
    try {
      const settings = await postJson("/settings/get", {});
      if (!settings || typeof settings !== "object" || (!("launchMode" in settings) && !("enhancementsEnabled" in settings) && !("providerSyncEnabled" in settings))) {
        throw new Error("invalid backend settings response");
      }
      if (seq !== codexPlusBackendSettingsSeq) {
        return false;
      }
      const includedNativeModels = codexPlusBackendSettings.codexAppIncludeNativeModels !== false;
      codexPlusBackendSettings = { ...codexPlusBackendSettings, ...settings };
      codexPlusBackendSettingsLoaded = true;
      if (includedNativeModels !== (codexPlusBackendSettings.codexAppIncludeNativeModels !== false)) refreshCodexModelQueries();
      return true;
    } catch (_) {
      return false;
    }
  }

  async function loadBackendSettings() {
    const loaded = await loadBackendSettingsState();
    if (loaded && codexRemoteSessionProviderOverrideEnabled()) {
      void loadCodexModelCatalog();
    }
    refreshCodexPlusBackendToggles();
    if (loaded) syncOfficialUsagePolicy();
    return loaded;
  }

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
  // 单独跟踪「读过了没有」：scripts 为空既可能是真没有脚本，也可能是还没读到。
  // 不区分就会在无后端时把「正在读取」直接显示成「未发现」。
  let codexPlusUserScriptsLoaded = false;
  // 市场清单。为空 + 未加载 = 还在拉；加载过为空 = 市场里确实没东西。
  let codexPlusScriptMarket = { scripts: [], loaded: false, loading: false, message: "" };
  // 「拓展」页左面板的搜索关键词，纯前端过滤。
  let codexPlusExtensionsQuery = "";
  // 当前选中的拓展（左面板点开后右侧显示详情）。空 = 还没选。
  let codexPlusExtensionsSelected = null;
  // 默认扩展图标：VSCode codicon 的 `extensions` 字形（\eae6），
  // 从本机 VSCode 的 codicon.ttf 抽出轮廓后归一到 16x16 视口。
  // 市场清单目前没有图标字段，所有市场条目都用它；本地脚本同理。
  const codexPlusDefaultExtensionIconPath = "M15.0 4.95 Q15.0 4.37 14.63 3.99 L12.01 1.37 Q11.63 1.0 11.05 1.0 Q10.46 1.0 10.08 1.37 L8.0 3.46 L8.0 3.3 Q8.0 2.71 7.6 2.31 Q7.2 1.91 6.61 1.91 L2.39 1.91 Q1.8 1.91 1.4 2.31 Q1.0 2.71 1.0 3.3 L1.0 13.61 Q1.0 14.2 1.4 14.6 Q1.8 15.0 2.39 15.0 L12.7 15.0 Q13.24 15.0 13.66 14.6 Q14.09 14.2 14.09 13.61 L14.09 9.39 Q14.09 8.8 13.66 8.4 Q13.24 8.0 12.7 8.0 L12.54 8.0 L14.63 5.92 Q15.0 5.54 15.0 4.95 Z M2.39 2.87 L6.61 2.87 Q6.77 2.87 6.93 3.0 Q7.09 3.14 7.09 3.3 L7.09 8.0 L1.91 8.0 L1.91 3.3 Q1.91 3.14 2.04 3.0 Q2.18 2.87 2.39 2.87 Z M1.91 13.61 L1.91 8.91 L7.09 8.91 L7.09 14.09 L2.39 14.09 Q2.18 14.09 2.04 13.96 Q1.91 13.82 1.91 13.61 Z M13.13 9.39 L13.13 13.61 Q13.13 13.82 13.0 13.96 Q12.86 14.09 12.7 14.09 L8.0 14.09 L8.0 8.91 L12.7 8.91 Q12.86 8.91 13.0 9.07 Q13.13 9.23 13.13 9.39 Z M8.0 8.0 L8.0 6.45 L9.55 8.0 Z M13.93 5.27 L11.37 7.84 Q11.21 8.0 11.02 8.0 Q10.83 8.0 10.73 7.84 L8.11 5.27 Q8.0 5.11 8.0 4.93 Q8.0 4.74 8.11 4.63 L10.73 2.02 Q10.83 1.91 11.02 1.91 Q11.21 1.91 11.37 2.02 L13.93 4.63 Q14.09 4.74 14.09 4.93 Q14.09 5.11 13.93 5.27 Z";
  let codexPlusBackendStatus = window.__codexPlusBackendStatus || { status: "checking", message: "正在检查后端…" };
  let codexPlusBackendCheckSeq = 0;
  let codexPlusBackendCheckInFlight = false;
  let codexPlusBackendFailureCount = 0;
  const CODEX_PLUS_BACKEND_FAILURE_THRESHOLD = 3;
  // 桥接通道（binding）与后端可用性分开统计：HTTP 回落成功会让后端状态保持绿色，
  // 但桥接持续失败时必须把降级呈现出来，否则启动器侧的重注入修复循环对用户完全不可见（issue #2169）。
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
    const labelFallback = status === "ok" ? "后端已连接" : status === "degraded" ? "桥接降级，自动修复中" : status === "checking" ? "正在检查后端…" : "未连接";
    const label = document.querySelector("[data-codex-backend-status]");
    if (label) {
      label.dataset.status = status;
      label.textContent = status === "degraded" ? labelFallback : (codexPlusBackendStatus.message || labelFallback);
    }
    document.querySelectorAll("[data-codex-backend-indicator]").forEach((indicator) => {
      indicator.dataset.status = status;
      indicator.title = status === "ok" ? "后端已连接" : status === "degraded" ? "后端可达，桥接降级，正在自动修复" : status === "checking" ? "正在检查后端" : "未连接";
    });
    const sidebarStatus = document.querySelector(`#${codexPlusSidebarNavId} .codex-plus-sidebar-nav-status`);
    if (sidebarStatus) {
      sidebarStatus.dataset.status = status;
      sidebarStatus.title = status === "ok" ? "后端已连接" : status === "degraded" ? "后端可达，桥接降级，正在自动修复" : status === "checking" ? "正在检查后端" : "未连接";
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

  /**
   * 「拓展」页面左面板：搜索框 + 已安装/市场两个分组。
   *
   * 点击复用已有的事件委托：已安装走向 `data-codex-user-script-key` 的开关，
   * 市场项走 `data-codex-market-install`。搜索是纯前端过滤，不发请求。
   */
  function renderCodexPlusExtensionsNav() {
    const { installed, market } = codexPlusExtensionsEntries();
    const shownInstalled = filterCodexPlusExtensionsEntries(installed);
    const shownMarket = filterCodexPlusExtensionsEntries(market);
    const loading = codexPlusScriptMarket.loading && !codexPlusScriptMarket.loaded;
    const searching = !!codexPlusExtensionsQuery.trim();

    const itemHtml = (entry) => {
      const selected = codexPlusExtensionsSelected?.kind === entry.kind
        && codexPlusExtensionsSelected?.key === entry.key;
      const marketItem = codexPlusExtensionMarketItem(entry);
      // 条目形态对齐 VSCode 扩展列表：大图标 + 名称行 + 简介行 + 底部作者/操作行。
      // 图标优先用市场清单的 icon，没有就用默认字形（见 extensionIconMarkup）。
      const icon = `
        <span class="codex-plus-extensions-icon" aria-hidden="true">
          ${extensionIconMarkup(marketItem?.icon)}
        </span>
      `;
      // 选中项高亮；点击整行选中并在右侧显示详情，不再直接切换开关。
      const base = `class="codex-plus-page-nav-item" data-active="${String(selected)}"`;
      if (entry.kind === "market") {
        const blurb = entry.item?.description || entry.meta || "";
        return `
          <button type="button" ${base} data-codex-extensions-select="market:${escapeHtml(entry.key)}" title="${escapeHtml(entry.name)}">
            <span class="codex-plus-extensions-item-body">
              <span class="codex-plus-extensions-item-header">
                ${icon}
                <span class="codex-plus-extensions-item-name">${escapeHtml(entry.name)}</span>
                ${entry.installed ? `<span class="codex-plus-extensions-icon-badge" data-badge="installed" title="已安装">✓</span>` : ""}
              </span>
              ${blurb ? `<span class="codex-plus-extensions-item-description">${escapeHtml(blurb)}</span>` : ""}
              <span class="codex-plus-extensions-item-footer">
                <span class="codex-plus-extensions-item-publisher">${escapeHtml(entry.meta || "")}</span>
                <span class="codex-plus-extensions-item-actions">
                  <span class="codex-plus-extensions-item-button" data-codex-market-install="${escapeHtml(entry.key)}">安装</span>
                </span>
              </span>
            </span>
          </button>
        `;
      }
      const blurb = marketItem?.description || "";
      return `
        <button type="button" ${base} data-codex-extensions-select="installed:${escapeHtml(entry.key)}" title="${escapeHtml(entry.name)}">
          <span class="codex-plus-extensions-item-body">
            <span class="codex-plus-extensions-item-header">
              ${icon}
              <span class="codex-plus-extensions-item-name">${escapeHtml(entry.name)}</span>
              <span class="codex-plus-extensions-item-state" data-state="${entry.enabled ? "on" : "off"}" title="${entry.enabled ? "已启用" : "已禁用"}"></span>
            </span>
            ${blurb ? `<span class="codex-plus-extensions-item-description">${escapeHtml(blurb)}</span>` : ""}
            <span class="codex-plus-extensions-item-footer">
              <span class="codex-plus-extensions-item-publisher">${escapeHtml(entry.meta || "")}</span>
              <span class="codex-plus-extensions-item-actions"></span>
            </span>
          </span>
        </button>
      `;
    };

    const group = (title, entries, emptyText, count, headAction = "") => {
      // 只在「搜索无匹配」时省略分组；否则空分组要留着显示占位文案，
      // 不然「正在读取拓展…」和加载失败提示都会被一起藏掉，面板全空。
      if (!entries.length && searching) return "";
      const body = entries.length
        ? entries.map(itemHtml).join("")
        : `<div class="codex-plus-page-nav-empty">${escapeHtml(emptyText)}</div>`;
      return `
        <div class="codex-plus-page-nav-group">
          <div class="codex-plus-page-nav-group-head">
            <span>${escapeHtml(title)}</span>
            <span class="codex-plus-page-nav-group-tail">
              ${count ? `<span class="codex-plus-page-nav-group-count">${count}</span>` : ""}
              ${headAction}
            </span>
          </div>
          ${body}
        </div>
      `;
    };

    const marketEmpty = loading
      ? "正在读取拓展…"
      : (codexPlusScriptMarket.message || "市场里没有可安装的拓展。");
    const anyShown = shownInstalled.length || shownMarket.length;
    const hint = searching && !anyShown
      ? `<div class="codex-plus-page-nav-empty">没有匹配「${escapeHtml(codexPlusExtensionsQuery)}」的拓展。</div>`
      : "";

    return `
      <div class="codex-plus-page-search">
        <input type="search" class="codex-plus-page-search-input" data-codex-extensions-search="true"
          placeholder="搜索拓展" value="${escapeHtml(codexPlusExtensionsQuery)}" spellcheck="false" />
      </div>
      ${hint}
      ${group("已安装", shownInstalled, codexPlusUserScriptsLoaded ? "未发现已安装的拓展。" : "正在读取用户拓展…", installed.length)}
      ${group("市场", shownMarket, marketEmpty, market.length,
        `<button type="button" class="codex-plus-page-nav-group-action" data-codex-market-refresh="true" title="刷新拓展">刷新</button>`)}
    `;
  }

  /** 左面板内容变了就整块重绘（搜索、安装完成、脚本状态变化都会走到这）。 */
  function refreshCodexPlusExtensionsView() {
    if (codexPlusActiveEntry() !== "extensions") return;
    const body = document.querySelector("[data-codex-plus-page-nav-body]");
    if (body) {
      const query = document.querySelector("[data-codex-extensions-search]")?.value;
      if (typeof query === "string") codexPlusExtensionsQuery = query;
      body.innerHTML = renderCodexPlusExtensionsNav();
      // 重绘会丢焦点，搜索时要把光标放回去，否则每敲一个字就断。
      if (codexPlusExtensionsQuery) {
        const input = body.querySelector("[data-codex-extensions-search]");
        if (input) {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      }
    }
    const detail = document.querySelector("[data-codex-plus-extensions-detail]");
    if (detail) detail.innerHTML = renderCodexPlusExtensionsDetail();
  }

  /**
   * 解析当前选中项，拿到本地脚本与市场条目两边的信息。
   *
   * 已安装的市场脚本，本地清单里有 `market_id`，据此把市场的描述/作者等补上；
   * 纯本地脚本则只有本地那几个字段。
   */
  function codexPlusExtensionsSelectionDetail() {
    const sel = codexPlusExtensionsSelected;
    if (!sel) return null;
    const local = sel.kind === "installed"
      ? (codexPlusUserScripts.scripts || []).find((script) => script.key === sel.key) || null
      : null;
    const marketId = sel.kind === "market" ? sel.key : (local?.market_id || "");
    const marketItem = marketId
      ? (codexPlusScriptMarket.scripts || []).find((item) => item.id === marketId) || null
      : null;
    return { sel, local, marketItem };
  }

  function extensionIconSvg() {
    return `<svg viewBox="0 0 16 16" fill="currentColor"><path d="${codexPlusDefaultExtensionIconPath}"/></svg>`;
  }

  /**
   * 条目图标：市场清单给了 `icon` 就用它，否则回退 VSCode 的默认扩展字形。
   *
   * 回退是必须的——清单里的老条目没有这个字段，而且 icon 指的是外链，
   * 加载失败时若不兜底就会留一块空白。失败替换交给委托监听（见 handleExtensionIconError），
   * 不用内联 onerror，避免在字符串拼 HTML 时引入另一处转义面。
   */
  function extensionIconMarkup(icon) {
    const url = String(icon || "").trim();
    if (!url) return extensionIconSvg();
    return `<img class="codex-plus-extensions-icon-img" src="${escapeHtml(url)}" alt="" loading="lazy" />`;
  }

  /**
   * 图标加载失败时换回默认字形。
   *
   * `error` 事件不冒泡，只能在捕获阶段用委托收到；换掉节点本身即可，
   * 再失败也不会递归——替换出来的 svg 不触发 error。
   */
  function handleExtensionIconError(event) {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains("codex-plus-extensions-icon-img")) return;
    const holder = document.createElement("span");
    holder.innerHTML = extensionIconSvg();
    const svg = holder.firstElementChild;
    if (svg) img.replaceWith(svg);
  }

  /** 右上角详情：图标 + 名称 + 介绍 + 操作。形态对齐 VSCode 的扩展详情页。 */
  function renderCodexPlusExtensionsDetail() {
    const detail = codexPlusExtensionsSelectionDetail();
    if (!detail) {
      return `<div class="codex-plus-extensions-detail-empty">从左侧选择一个拓展查看详情。</div>`;
    }
    const { sel, local, marketItem } = detail;
    const name = marketItem?.name || local?.name || sel.key;
    const version = marketItem?.version || local?.version || "";
    const author = marketItem?.author || "";
    const description = marketItem?.description || "";
    const tags = marketItem?.tags || [];
    const requirements = marketItem?.requirements || [];
    const limitations = marketItem?.limitations || [];
    const homepage = marketItem?.homepage || local?.homepage || "";
    const isInstalled = sel.kind === "installed";
    const updateAvailable = isInstalled && marketItem && version && local?.version && local.version !== version;

    // 头部：图标 + 名称 + 发布者/版本行，操作按钮靠右。对齐 VSCode 扩展编辑器的头部。
    const publisherLine = [
      author ? escapeHtml(author) : "",
      version ? `v${escapeHtml(version)}` : "",
      local ? `${local.source === "builtin" ? "内置" : "用户"} · ${escapeHtml(userScriptStatusLabel(local.status))}` : "",
    ].filter(Boolean).join('<span class="codex-plus-extensions-detail-sep">·</span>');

    const actions = [];
    if (isInstalled) {
      actions.push(`
        <button type="button" class="codex-plus-toggle" data-codex-user-script-key="${escapeHtml(local?.key || "")}" data-enabled="${String(!!local?.enabled)}"><span></span></button>
      `);
      // 内置脚本在只读目录里，删不掉；只给用户目录的脚本提供卸载。
      if (local?.source === "user") {
        actions.push(`<button type="button" class="codex-plus-extensions-detail-button" data-codex-extensions-uninstall="${escapeHtml(local.key)}">卸载</button>`);
      }
    } else if (marketItem) {
      actions.push(`<button type="button" class="codex-plus-extensions-detail-button codex-plus-extensions-detail-primary" data-codex-market-install="${escapeHtml(marketItem.id)}">安装</button>`);
    }

    // VSCode 的详情正文是「标题 + 正文」的滚动区，这里用同样的分区结构。
    const list = (title, items) => items.length
      ? `<div class="codex-plus-extensions-detail-section"><div class="codex-plus-extensions-detail-section-title">${escapeHtml(title)}</div><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
      : "";

    return `
      <div class="codex-plus-extensions-detail-head">
        <div class="codex-plus-extensions-detail-icon" aria-hidden="true">${extensionIconMarkup(marketItem?.icon)}</div>
        <div class="codex-plus-extensions-detail-heading">
          <div class="codex-plus-extensions-detail-title">${escapeHtml(name)}</div>
          ${publisherLine ? `<div class="codex-plus-extensions-detail-meta">${publisherLine}</div>` : ""}
          ${updateAvailable ? `<div class="codex-plus-extensions-detail-update">有新版本 v${escapeHtml(version)} 可更新</div>` : ""}
        </div>
        <div class="codex-plus-extensions-detail-actions">${actions.join("")}</div>
      </div>
      <div class="codex-plus-extensions-detail-body">
        ${description ? `<div class="codex-plus-extensions-detail-description">${escapeHtml(description)}</div>` : ""}
        ${tags.length ? `<div class="codex-plus-extensions-detail-tags">${tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
        ${list("使用要求", requirements)}
        ${list("已知限制", limitations)}
        ${homepage ? `<div class="codex-plus-extensions-detail-link"><a href="${escapeHtml(homepage)}" target="_blank" rel="noreferrer">${escapeHtml(homepage)}</a></div>` : ""}
        ${local?.error ? `<div class="codex-plus-extensions-detail-error">${escapeHtml(local.error)}</div>` : ""}
      </div>
    `;
  }

  /** 卸载用户脚本：删文件 + 清记录，然后刷新两侧。 */
  async function uninstallUserScript(key) {
    if (!key) return;
    await postJson("/user-scripts/delete", { key });
    if (codexPlusExtensionsSelected?.kind === "installed" && codexPlusExtensionsSelected.key === key) {
      codexPlusExtensionsSelected = null;
    }
    await loadUserScripts();
    refreshCodexPlusExtensionsView();
  }

  /** 左面板的导航项。Codex++ 页面切分组，「拓展」页面列脚本。 */
  function renderCodexPlusPageNavItems(tab) {
    if (tab === codexPlusExtensionsTab) return renderCodexPlusExtensionsNav();
    return [
      { key: "home", label: "主页" },
      { key: "sponsor", label: "推荐内容" },
    ].map((item) => `
      <button type="button" class="codex-plus-page-nav-item" data-codex-plus-page-nav="${item.key}" data-active="${String(tab === item.key)}">${item.label}</button>
    `).join("");
  }

  /**
   * 页面模式下把单栏内容改造成两栏：左面板 + 右内容区。
   *
   * 只搬动已有的 .codex-plus-modal-body，不重建里面那些 data-codex-* 挂载点，
   * 免得 renderUserScripts / 各类 toggle 的 querySelector 找不到目标。
   */
  function installCodexPlusPageLayout(overlay, tab) {
    if (!overlay || overlay.querySelector(".codex-plus-page-layout")) return;
    const content = overlay.querySelector(".codex-plus-modal-content");
    const body = content?.querySelector(".codex-plus-modal-body");
    if (!content || !body) return;
    const layout = document.createElement("div");
    layout.className = "codex-plus-page-layout";
    const main = document.createElement("div");
    main.className = "codex-plus-page-main";
    // 只有「拓展」需要左面板（它是脚本列表）。主页和推荐内容都是单栏内容页，
    // 页面切换交给图标栏那三个入口，再列一遍就是重复。
    if (tab === codexPlusExtensionsTab) {
      const nav = document.createElement("div");
      nav.className = "codex-plus-page-nav";
      nav.innerHTML = `
        <div class="codex-plus-page-nav-header"><div class="codex-plus-page-nav-title">${codexPlusPageTitle(tab)}</div></div>
        <div class="codex-plus-page-nav-body" data-codex-plus-page-nav-body="true">${renderCodexPlusPageNavItems(tab)}</div>
      `;
      layout.appendChild(nav);
    }
    content.appendChild(layout);
    layout.appendChild(main);
    main.appendChild(body);
  }

  /** 页面标题：每个 rail 入口一个名字，和图标栏上的标签保持一致。 */
  function codexPlusPageTitle(tab) {
    if (tab === codexPlusExtensionsTab) return "拓展";
    if (tab === codexPlusSponsorTab) return "推荐内容";
    return "Codex++";
  }

  /** 左面板内容随当前分组刷新（切 tab 后调用）。 */
  function refreshCodexPlusPageNav(tab) {
    const body = document.querySelector("[data-codex-plus-page-nav-body]");
    if (!body) return;
    const title = document.querySelector(".codex-plus-page-nav-title");
    if (title) title.textContent = tab === codexPlusExtensionsTab ? "拓展" : "Codex++";
    body.innerHTML = renderCodexPlusPageNavItems(tab);
  }

  /**
   * 脚本清单变化后同步左面板。
   *
   * 原来这里还要往「用户脚本」区块的开关与目录文本里写值，那个区块已经删掉，
   * 脚本列表现在只存在于拓展页左面板，所以只剩刷新这一件事。
   */
  function renderUserScripts() {
    // 左面板也要跟着刷新，否则脚本的启停/状态变化不会反映到列表上。
    if (codexPlusActiveEntry() === "extensions") refreshCodexPlusPageNav(codexPlusExtensionsTab);
  }

  async function loadUserScripts(path = "/user-scripts/list", payload = {}) {
    const requestPayload = path === "/user-scripts/list"
      ? { ...payload, runtime_status: window.__codexPlusUserScripts?.scripts || {} }
      : payload;
    const result = await postJson(path, requestPayload);
    if (result?.scripts) {
      codexPlusUserScripts = result;
      codexPlusUserScriptsLoaded = true;
      renderUserScripts();
      // 已安装状态变了，市场的「已安装/有更新」标记也要跟着刷新。
      if (codexPlusActiveEntry() === "extensions") refreshCodexPlusExtensionsView();
    }
  }

  /**
   * 拉市场清单。
   *
   * 清单与「已安装」状态都由后端合并好（见 script_market::market_scripts_payload），
   * 前端只需合并本地脚本清单来显示来源与状态。
   */
  async function loadScriptMarket(force = false) {
    if (codexPlusScriptMarket.loading) return;
    if (codexPlusScriptMarket.loaded && !force) return;
    codexPlusScriptMarket = { ...codexPlusScriptMarket, loading: true };
    if (codexPlusActiveEntry() === "extensions") refreshCodexPlusExtensionsView();
    const result = await postJson("/script-market/list", {});
    if (Array.isArray(result?.scripts)) {
      codexPlusScriptMarket = {
        scripts: result.scripts,
        loaded: true,
        loading: false,
        message: result.message || "",
      };
    } else {
      codexPlusScriptMarket = {
        ...codexPlusScriptMarket,
        loaded: true,
        loading: false,
        message: result?.message || "拓展加载失败",
      };
    }
    if (codexPlusActiveEntry() === "extensions") refreshCodexPlusExtensionsView();
  }

  async function installScriptFromMarket(id) {
    if (!id) return;
    const result = await postJson("/script-market/install", { id });
    if (Array.isArray(result?.scripts)) {
      codexPlusScriptMarket = {
        scripts: result.scripts,
        loaded: true,
        loading: false,
        message: result.message || "",
      };
    }
    // 后端装完会把本地清单一起带回来，省一次往返。
    if (result?.user_scripts?.scripts) {
      codexPlusUserScripts = result.user_scripts;
      codexPlusUserScriptsLoaded = true;
      renderUserScripts();
    } else {
      await loadUserScripts();
    }
    if (codexPlusActiveEntry() === "extensions") refreshCodexPlusExtensionsView();
  }

  /**
   * 市场条目与本地脚本合并后的视图。
   *
   * 本地有市场装来的脚本（带 market_id），据此判断「已安装」并给出卸载入口；
   * 「市场」分组只列还没装的，避免同一脚本出现两次。
   */
  function codexPlusExtensionsEntries() {
    const local = codexPlusUserScripts.scripts || [];
    const localByMarketId = new Map(
      local.filter((script) => script.market_id).map((script) => [script.market_id, script]),
    );
    const installed = local.map((script) => ({
      kind: "installed",
      key: script.key,
      name: script.name || script.key,
      meta: `${script.source === "builtin" ? "内置" : script.market_id ? "市场" : "用户"} · ${userScriptStatusLabel(script.status)}`,
      enabled: !!script.enabled,
      script,
    }));
    const market = (codexPlusScriptMarket.scripts || [])
      .filter((item) => !localByMarketId.has(item.id))
      .map((item) => ({
        kind: "market",
        key: item.id,
        name: item.name || item.id,
        meta: `${item.author || "未知作者"} · v${item.version}`,
        item,
      }));
    const available = (codexPlusScriptMarket.scripts || []).filter((item) => localByMarketId.has(item.id));
    return { installed, market, available, localByMarketId };
  }

  /**
   * 取条目对应的市场清单项。
   *
   * 市场条目自带 `item`；已安装条目只有本地脚本（`script`），要靠脚本上的
   * `market_id` 回查，否则拿不到图标、简介、标签。纯本地脚本两者都没有。
   */
  function codexPlusExtensionMarketItem(entry) {
    if (entry.kind === "market") return entry.item || null;
    const marketId = entry.script?.market_id;
    if (!marketId) return null;
    return (codexPlusScriptMarket.scripts || []).find((item) => item.id === marketId) || null;
  }

  function filterCodexPlusExtensionsEntries(entries) {
    const query = codexPlusExtensionsQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => {
      const marketItem = codexPlusExtensionMarketItem(entry);
      return [entry.name, entry.meta, marketItem?.description, ...(marketItem?.tags || [])]
        .filter(Boolean)
        .some((text) => String(text).toLowerCase().includes(query));
    });
  }

  const codexPlusAdsUrl = "/ads";
  let codexPlusAds = [];
  let codexPlusAdsLoaded = false;

  function isCodexPlusAdExpired(ad) {
    if (!ad.expires_at) return false;
    const expiresAt = Date.parse(ad.expires_at);
    return Number.isFinite(expiresAt) && expiresAt < Date.now();
  }

  function normalizeCodexPlusAds(payload) {
    if (!payload || !Array.isArray(payload.ads)) return [];
    // 只留赞助商推荐。上游清单里的 normal 条目在前端没有归属（页面不再有分组），
    // 放进来只会让「有数据但渲染不出东西」的状态变得难以判断。
    return payload.ads.filter((ad) => {
      return ad && ad.type === "sponsor" && ad.title && ad.description && ad.url && !isCodexPlusAdExpired(ad);
    }).map((ad) => ({
      id: String(ad.id || ad.title),
      type: ad.type,
      title: String(ad.title),
      description: String(ad.description),
      url: String(ad.url),
      image: ad.image ? String(ad.image) : "",
      expires_at: ad.expires_at ? String(ad.expires_at) : "",
      highlights: Array.isArray(ad.highlights) ? ad.highlights.map((item) => String(item)).filter(Boolean) : [],
    }));
  }

  function formatCodexPlusAdTitle(title) {
    const value = String(title || "");
    return value.split(/[｜|]/, 1)[0].trim() || value;
  }

  /** 推荐卡片的右上角外链箭头，跟 VSCode/Codex 的「新窗口打开」同一语义。 */
  const codexPlusAdArrowIcon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 10.5 10.5 5.5"/><path d="M6.5 5.5h4v4"/></svg>';

  function renderCodexPlusAdGroup() {
    const ads = codexPlusAds;
    if (!ads.length) return `<div class="codex-plus-ad-empty">暂无推荐内容。</div>`;
    return ads.map((ad) => {
      const name = formatCodexPlusAdTitle(ad.title);
      // 底部那条优惠信息：取第一个亮点。没有就不渲染整条，免得留一段空白。
      const promo = (ad.highlights || []).find(Boolean) || "";
      // 没有配图时用名称首字当占位，比空一块更整齐。
      const icon = ad.image
        ? `<img class="codex-plus-ad-icon" src="${escapeHtml(ad.image)}" alt="" loading="lazy" />`
        : `<span class="codex-plus-ad-icon codex-plus-ad-icon-fallback" aria-hidden="true">${escapeHtml(name.slice(0, 1))}</span>`;
      return `
        <a class="codex-plus-ad-card" data-codex-plus-ad-url="${escapeHtml(ad.url)}" href="${escapeHtml(ad.url)}" rel="noreferrer" title="${escapeHtml(name)}">
          <span class="codex-plus-ad-main">
            ${icon}
            <span class="codex-plus-ad-text">
              <span class="codex-plus-ad-title">${escapeHtml(name)}</span>
              <span class="codex-plus-ad-description">${escapeHtml(ad.description)}</span>
            </span>
            <span class="codex-plus-ad-arrow" aria-hidden="true">${codexPlusAdArrowIcon}</span>
          </span>
          ${promo ? `<span class="codex-plus-ad-promo">${escapeHtml(promo)}</span>` : ""}
        </a>
      `;
    }).join("");
  }

  function renderCodexPlusAds() {
    if (!codexPlusAdsLoaded) return `<div class="codex-plus-ad-empty">推荐内容加载中…</div>`;
    if (!codexPlusAds.length) return `<div class="codex-plus-ad-empty">暂无推荐内容。</div>`;
    // 只有赞助商推荐这一个分组，所以不再套一层分组标题，直接铺卡片。
    return `<div class="codex-plus-ad-list">${renderCodexPlusAdGroup()}</div>`;
  }

  function cacheBustCodexPlusAdUrl(url, version) {
    return `${url}${url.includes("?") ? "&" : "?"}v=${version}`;
  }

  async function directFetchCodexPlusAds() {
    const urls = [
      "https://raw.githubusercontent.com/BigPizzaV3/Ad-List/main/ads.json",
      "https://cdn.jsdelivr.net/gh/BigPizzaV3/Ad-List@main/ads.json",
    ];
    let lastError = null;
    const cacheBust = Date.now();
    for (const url of urls) {
      try {
        const response = await fetch(cacheBustCodexPlusAdUrl(url, cacheBust), {
          headers: { "Accept": "application/json" },
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("ad list unavailable");
  }

  async function fetchCodexPlusAds() {
    try {
      const localPayload = await postJson(codexPlusAdsUrl, {});
      codexPlusAds = normalizeCodexPlusAds(localPayload?.ads ? localPayload : localPayload?.payload);
      if (!codexPlusAds.length) codexPlusAds = normalizeCodexPlusAds(await directFetchCodexPlusAds());
    } catch (error) {
      sendCodexPlusDiagnostic("ads_fetch_failed", {
        errorName: error?.name || "",
        errorMessage: error?.message || String(error),
      });
      codexPlusAds = [];
    } finally {
      codexPlusAdsLoaded = true;
      const panel = document.querySelector('[data-codex-plus-panel="sponsor"] .codex-plus-ad-remote');
      if (panel) panel.innerHTML = renderCodexPlusAds();
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
    const providerLabel = codexPlusRelayApiKeys.providerName || codexPlusRelayApiKeys.providerId || "未命名";
    summary.textContent = codexPlusRelayApiKeys.enabled
      ? `当前供应商：${providerLabel}`
      : `当前供应商：${providerLabel}（未启用供应商配置切换）`;
    const keys = Array.isArray(codexPlusRelayApiKeys.keys) ? codexPlusRelayApiKeys.keys : [];
    if (!keys.length) {
      list.innerHTML = '<div class="codex-plus-api-key-empty">当前供应商没有可切换的命名 Key，请先在管理工具中添加。</div>';
      return;
    }
    const options = keys.map((entry) => `<option value="${escapeHtml(entry.id)}"${entry.id === codexPlusRelayApiKeys.activeKeyId ? " selected" : ""}>${escapeHtml(entry.name || "未命名 Key")}</option>`).join("");
    // 总开关关闭时后端只改 Key 的落点，所以这里照常可选；只有切换进行中才禁用。
    const switchingInFlight = codexPlusRelayApiKeySwitching;
    const switchOffHint = codexPlusRelayApiKeys.enabled ? "" : `
      <div class="codex-plus-api-key-empty">未启用供应商配置切换：这里只更换当前 Key，模型、上下文等其它配置保持不变。</div>`;
    // 下拉框的选中项按 live 里的 Key 匹配；匹配不上说明实际在用的 Key 不在命名列表里。
    const liveMismatchHint = codexPlusRelayApiKeys.liveKeyMatched === false
      ? '<div class="codex-plus-api-key-empty">Codex 实际在用的 Key 不在这个列表里（可能被其它工具改过）；选中任意一项会把它写进当前配置。</div>'
      : "";
    list.innerHTML = `
      <select class="codex-plus-api-key-select" data-codex-relay-api-key-select="true" aria-label="切换 API Key"${switchingInFlight ? " disabled" : ""}>
        ${options}
      </select>${switchOffHint}${liveMismatchHint}`;
    refreshCodexRelayApiKeyBadges();
  }

  async function loadRelayApiKeys(force = false) {
    // 面板每次打开都重建 DOM，重新读取时命中缓存也要重画一次，
    // 否则界面会一直停在模板里的“正在读取当前供应商…”。
    renderRelayApiKeys();
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
    // 归一化后再比对：panel 用的是 extensions，而旧调用点仍传 userScripts，
    // 不统一就会两边都对不上、所有 panel 全被隐藏。
    const normalized = codexPlusModalTab(tab);
    document.querySelectorAll(".codex-plus-modal-content").forEach((modal) => {
      modal.dataset.codexPlusActiveTab = normalized;
    });
    document.querySelectorAll("[data-codex-plus-panel]").forEach((panel) => {
      panel.hidden = codexPlusModalTab(panel.getAttribute("data-codex-plus-panel")) !== normalized;
    });
    if (normalized === codexPlusExtensionsTab) {
      loadUserScripts();
      // 市场清单拉过一次就缓存，切换分组不再重复请求；失败后可从界面手动刷新。
      void loadScriptMarket();
    }
    refreshCodexPlusPageNav(normalized);
  }

  /** 两个 rail 入口各自对应一个页面，激活态要分别判断，不能只看页面开着没有。 */
  function codexPlusActiveEntry() {
    const overlay = document.querySelector(`.${codexPlusPageClass}`);
    if (!overlay) return null;
    const tab = overlay.querySelector(".codex-plus-modal-content")?.dataset?.codexPlusActiveTab;
    if (tab === codexPlusExtensionsTab) return "extensions";
    if (tab === codexPlusSponsorTab) return "sponsor";
    return "home";
  }

  function setCodexPlusSidebarNavActive(active, entry = "home") {
    const nav = document.getElementById(codexPlusSidebarNavId);
    const button = nav?.querySelector("button");
    if (button) {
      const on = Boolean(active) && entry === "home";
      button.dataset.active = String(on);
      button.setAttribute("aria-current", on ? "page" : "false");
    }
    [
      [codexPlusRailNavId, "home"],
      [codexPlusRailExtensionsId, "extensions"],
      [codexPlusRailSponsorId, "sponsor"],
    ].forEach(([id, name]) => {
      const railButton = document.querySelector(`#${id} > button`);
      if (!railButton) return;
      const on = Boolean(active) && entry === name;
      railButton.dataset.active = String(on);
      railButton.setAttribute("aria-current", on ? "page" : "false");
      // 原生 rail 按钮的选中色由 data-selected 驱动（且需无 data-suppress-active-style）。
      if (on) railButton.setAttribute("data-selected", "");
      else railButton.removeAttribute("data-selected");
    });
    syncCodexPlusRailNativeSelection();
  }

  /**
   * 我们的页面是叠加在 Codex 上的，Codex 不知道，所以它自己那个 destination
   * 的选中态会一直留着，表现为 rail 上同时亮两个。页面打开时给根节点打标记，
   * 由 CSS 把原生选中项压成未选中；关掉即移除标记，原生状态自动恢复。
   *
   * 未选中的颜色取自当前主题下真实的未选中项，避免把深浅色写死。
   */
  function syncCodexPlusRailNativeSelection() {
    const root = document.documentElement;
    if (!root) return;
    if (!document.querySelector(`.${codexPlusPageClass}`)) {
      root.removeAttribute("data-codex-plus-page-open");
      root.style.removeProperty("--codex-plus-rail-dim");
      return;
    }
    const rail = document.querySelector(codexPlusRailSelector);
    const unselected = rail?.querySelector(`${codexPlusRailDestinationSelector}:not([aria-current="page"])`);
    const dim = unselected ? getComputedStyle(unselected).color : "";
    if (dim) root.style.setProperty("--codex-plus-rail-dim", dim);
    root.setAttribute("data-codex-plus-page-open", "");
  }

  function positionCodexPlusPage(overlay) {
    if (!overlay?.classList?.contains(codexPlusPageClass)) return;
    const sidebar = document.querySelector("aside.app-shell-left-panel");
    const rect = sidebar?.getBoundingClientRect?.();
    const rail = document.querySelector(codexPlusRailSelector);
    const railRect = rail?.getBoundingClientRect?.();
    // 新版：页面要顶替原生侧边栏——从图标栏右边界起铺满，把宽面板整个盖住，
    // 而不是并排在其右侧多出一列（那样会变成「图标栏 + 会话列表 + 我们的面板」三段）。
    // 旧版没有图标栏，我们的入口就在 aside 内部，此时退回 aside 右边界。
    const left = railRect && railRect.width > 0
      ? Math.max(0, railRect.right)
      : (rect && rect.width > 0 ? Math.max(0, rect.right) : 0);
    // 量出来的是视觉坐标，而 overlay 在缩放空间里布局，所以统一折算成布局坐标。
    // CSS 的 calc(100vw / zoom - left) 用的也是这个空间的量，两边才配得上。
    const zoom = codexPlusWindowZoom();
    const layoutLeft = zoom === 1 ? left : left / zoom;
    overlay.style.setProperty("--codex-plus-page-left", `${layoutLeft}px`);
    overlay.style.left = `${layoutLeft}px`;
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

  /**
   * 取 Codex 当前的界面缩放系数。
   *
   * Codex 的界面缩放的实现是给内层布局节点设 CSS `zoom`（例如 1.2），而不是改
   * documentElement，所以固定在 body 下的 overlay 不会自动跟随。这里把它读出来，
   * 由 applyCodexPlusZoom 自己套上。
   */
  function codexPlusWindowZoom() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(codexPlusWindowZoomVar);
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) && value > 0 ? value : 1;
  }

  /**
   * 让 overlay 跟随 Codex 的界面缩放，并保持满屏。
   *
   * 直接给 fixed 元素设 zoom 的话，它自身的 `inset: 0` / `100vw` 都还是按未缩放的
   * 视口算，再乘 zoom 就溢出（实测 zoom=1.2 时 100vw 得到 2072px，视口只有 1727）。
   * 所以 overlay 自身的尺寸改用 `calc(100vw / var(--codex-plus-zoom))` 抵消，
   * 内部子元素则用百分比——它们在缩放空间里，百分比本来就对。
   *
   * 字号不在这里动：由 CSS 跟随 zoom 自然放大，与原生行为一致。
   */
  function applyCodexPlusZoom(overlay) {
    if (!overlay?.style) return 1;
    const zoom = codexPlusWindowZoom();
    overlay.style.setProperty("--codex-plus-zoom", String(zoom));
    if (zoom === 1) {
      overlay.style.removeProperty("zoom");
      return 1;
    }
    overlay.style.setProperty("zoom", String(zoom));
    return zoom;
  }

  /**
   * 用 Codex 自己的语义令牌刷新 overlay 的变量。
   *
   * 早先这里内联写死了一套 zinc 调色板（深色正文 #f3f4f6、次要 #a1a1aa），
   * 内联优先级最高，把样式表里本来正确的令牌链整个盖掉了，表现为我们的文字
   * 比原生偏白偏冷。现在改成读宿主算好的值——取不到才回落到兜底色，
   * 这样浅色/深色主题都跟原生同源，也不会在 Codex 调色板变动后失配。
   */
  function applyCodexPlusTheme(overlay) {
    if (!overlay?.style) return;
    const light = codexPlusHostUsesLightTheme();
    const host = getComputedStyle(document.documentElement);
    const read = (names, fallback) => {
      for (const name of names) {
        const value = host.getPropertyValue(name).trim();
        if (value) return value;
      }
      return fallback;
    };
    const variables = {
      "--codex-plus-bg-primary": read(
        ["--color-token-bg-primary", "--token-bg-primary", "--app-color-background-surface"],
        light ? "#ffffff" : "#141414",
      ),
      "--codex-plus-bg-secondary": read(
        ["--color-token-bg-secondary", "--token-bg-secondary", "--color-surface-secondary"],
        light ? "#f7f7f7" : "#2f2f2f",
      ),
      "--codex-plus-bg-elevated": read(
        ["--color-token-dropdown-background", "--color-surface-elevated-secondary", "--color-token-bg-elevated-secondary"],
        light ? "#ffffff" : "#2f2f2f",
      ),
      "--codex-plus-bg-hover": read(
        ["--color-token-interactive-bg-secondary-hover", "--color-background-primary-soft-hover", "--token-list-hover-background"],
        light ? "rgba(0,0,0,.06)" : "rgba(255,255,255,.08)",
      ),
      "--codex-plus-bg-selected": read(
        ["--color-token-interactive-bg-secondary-selected", "--color-background-primary-soft-active"],
        light ? "rgba(0,0,0,.08)" : "rgba(255,255,255,.12)",
      ),
      "--codex-plus-text": read(
        ["--color-token-text-primary", "--color-text-primary", "--token-text-primary"],
        light ? "#171717" : "#dfdfdf",
      ),
      "--codex-plus-text-secondary": read(
        ["--color-token-text-secondary", "--color-text-secondary-solid", "--color-text-secondary"],
        light ? "#5d5d5d" : "rgba(255,255,255,.71)",
      ),
      "--codex-plus-text-tertiary": read(
        ["--color-token-text-tertiary", "--color-text-tertiary"],
        light ? "#8a8a8a" : "rgba(255,255,255,.498)",
      ),
      "--codex-plus-border": read(
        ["--color-token-border-default", "--color-token-border", "--color-border-primary-outline"],
        light ? "rgba(0,0,0,.12)" : "rgba(255,255,255,.084)",
      ),
      "--codex-plus-border-subtle": read(
        ["--color-token-border-subtle", "--color-border-disabled"],
        light ? "rgba(0,0,0,.08)" : "rgba(255,255,255,.06)",
      ),
      "--codex-plus-danger": read(
        ["--color-text-danger", "--color-token-text-error"],
        light ? "#dc2626" : "#ff6764",
      ),
      "--codex-plus-success": read(
        ["--color-text-success", "--app-color-text-success"],
        light ? "#15803d" : "#40c977",
      ),
      "--codex-plus-warning": read(
        ["--color-text-warning", "--color-text-caution-surface"],
        light ? "#a16207" : "#ffc300",
      ),
    };
    Object.entries(variables).forEach(([name, value]) => overlay.style.setProperty(name, value));
    overlay.dataset.codexPlusTheme = light ? "light" : "dark";
  }

  /**
   * 规范化页面/tab 名。
   *
   * 用户脚本从 Codex++ 弹窗里拆出来成了独立的「拓展」页面，
   * 这里把旧名 userScripts 也映射过去，避免存量调用点失效。
   */
  function codexPlusModalTab(tab) {
    if (tab === "extensions" || tab === "userScripts") return codexPlusExtensionsTab;
    if (tab === "sponsor") return "sponsor";
    return "home";
  }

  function openCodexPlusModal(options = {}) {
    const pageMode = options.page === true;
    const initialTab = codexPlusModalTab(options.tab);
    document.querySelectorAll(".codex-plus-modal-overlay").forEach((node) => node.remove());
    document.querySelectorAll(`.${codexPlusPageClass}, [data-codex-plus-dialog="true"]`).forEach((node) => node.remove());
    const overlay = document.createElement("div");
    overlay.className = pageMode ? codexPlusPageClass : "codex-plus-modal-overlay";
    overlay.dataset.codexPlusPage = String(pageMode);
    applyCodexPlusTheme(overlay);
    // 跟随 Codex 的界面缩放。必须在写 innerHTML 之前设好，否则内部那些
    // calc(100% / var(--codex-plus-zoom-inverse)) 会先按 1 算一遍再被 zoom 放大。
    applyCodexPlusZoom(overlay);
    overlay.innerHTML = `
      <div class="codex-plus-modal-content" role="dialog" aria-modal="true" aria-label="Codex++">
        <div class="codex-plus-modal-header">
          <div class="codex-plus-modal-title"><span class="codex-plus-backend-indicator" data-codex-backend-indicator="true" data-status="checking"></span><span data-codex-plus-version="true">Codex++ ${codexPlusVersion}</span></div>
          ${pageMode ? "" : `<button type="button" class="codex-plus-modal-close" aria-label="关闭">×</button>`}
        </div>
        <div class="codex-plus-modal-body">
          <div class="codex-plus-panel" data-codex-plus-panel="home">
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">后端连接</div><div class="codex-plus-row-description">每 5 秒检查一次 launcher 后端状态。</div></div>
              <div class="codex-plus-backend-status">
                <div class="codex-plus-backend-label" data-codex-backend-status="true" data-status="checking">正在检查后端…</div>
              </div>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">Codex增强</div><div class="codex-plus-row-description">关闭后停用删除、导出、插件相关和菜单位置增强。</div></div>
              <button type="button" class="codex-plus-toggle" data-codex-backend-setting="enhancementsEnabled"><span></span></button>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">插件市场解锁</div><div class="codex-plus-row-description">${codexPlusBackendSettings.launchMode === "relay" ? "兼容增强模式下无需开启；ChatGPT 登录态会保留官方插件市场。" : "API Key 模式下扩展插件市场请求，尽量显示完整插件列表。"}</div></div>
              <button type="button" class="codex-plus-toggle" data-codex-plus-setting="pluginMarketplaceUnlock" ${codexPlusBackendSettings.launchMode === "relay" ? 'disabled data-relay-unneeded="true"' : ""}><span></span></button>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">模型白名单解锁</div><div class="codex-plus-row-description">从环境变量和 Codex config.toml 中的中转站 /v1/models 拉取模型，并补进模型选择列表。</div></div>
              <button type="button" class="codex-plus-toggle" data-codex-plus-setting="modelWhitelistUnlock"><span></span></button>
            </div>

            <!-- fragment contract: extension menu mount follows 提出问题: \${renderCodexPlusExtensionMenuRows()} -->
            <!-- overlay.addEventListener("click", (event) => handleCodexPlusExtensionMenuClick(target)); data-codex-open-devtools -->
