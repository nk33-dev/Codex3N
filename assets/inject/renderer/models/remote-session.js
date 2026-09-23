  function codexRemoteSessionActiveProfile() {
    if (!codexPlusBackendSettings.relayProfilesEnabled) return null;
    const profiles = Array.isArray(codexPlusBackendSettings.relayProfiles)
      ? codexPlusBackendSettings.relayProfiles
      : [];
    const activeId = String(codexPlusBackendSettings.activeRelayId || "");
    return profiles.find((item) => String(item?.id || "") === activeId) || null;
  }

  function codexRemoteSessionProviderPatchEnabled() {
    const profile = codexRemoteSessionActiveProfile();
    if (!profile) return false;
    const relayMode = String(profile.relayMode || "");
    return relayMode === "pureApi"
      || (relayMode === "official" && !!profile.officialMixApiKey);
  }

  function codexRemoteSessionProviderNormalizationEnabled() {
    if (!codexRemoteSessionProviderPatchEnabled()) return false;
    const profile = codexRemoteSessionActiveProfile();
    if (String(profile?.relayMode || "") !== "official") return false;
    const sessionProvider = String(
      codexPlusBackendSettings.activeRelaySessionProvider || "custom"
    ).trim().toLowerCase();
    return sessionProvider !== "openai";
  }

  function codexRemoteSessionProviderOverrideEnabled() {
    const profile = codexRemoteSessionActiveProfile();
    if (!profile) return false;
    const relayMode = String(profile.relayMode || "");
    if (relayMode === "pureApi") return true;
    return codexRemoteSessionProviderNormalizationEnabled();
  }

  function codexRelayConfigModelProvider(configContents) {
    const text = String(configContents || "");
    const match = /(?:^|\n)\s*model_provider\s*=\s*["']([^"'\n]+)["']/m.exec(text);
    return match ? String(match[1]).trim() : "";
  }

  function codexRemoteSessionTargetProvider() {
    const profile = codexRemoteSessionActiveProfile();
    const relayMode = String(profile?.relayMode || "");
    // 解析中继实际写进 config.toml 的 model_provider（比如
    // `model_provider = "deepseek"` 配 [model_providers.deepseek]），而不是
    // 假定每个 pureApi 中继都叫 "custom"——那会让恢复会话报
    // "Model provider `custom` not found"。
    //
    // 顺序上先看 profile.configContents 再看 activeRelayCodexProvider：后者是
    // 全局缓存，切换供应商后可能还是上一个的值；profile 是当前这次调用现取的，
    // 更可信。反过来会让 pureApi 恢复会话拿到陈旧 provider。
    const fromConfig = codexRelayConfigModelProvider(profile?.configContents || "");
    if (fromConfig) return fromConfig;
    // pureApi 且 profile 自己没声明供应方时回到 "custom"，不去读可能陈旧的全局缓存。
    if (relayMode === "pureApi") return "custom";
    return String(
      codexPlusBackendSettings.activeRelayCodexProvider
      || codexModelCatalog?.codex_model_provider
      || codexModelCatalog?.codexModelProvider
      || codexModelCatalog?.model_provider
      || codexModelCatalog?.modelProvider
      || (String(profile?.relayMode || "") === "pureApi" ? "custom" : "")
      || ""
    ).trim();
  }

  function codexRemoteSessionProviderRequestMethod(method) {
    // app-server restores persisted model/provider/reasoning for thread/resume only
    // when the caller supplies none of those overrides.
    return [
      "thread/start",
      "start-conversation",
      "start-thread-for-host",
      "thread-prewarm-start",
      "prewarm-thread-start-for-host",
      "turn/start",
    ].includes(String(method || ""));
  }

  function applyCodexRemoteSessionProviderOverride(method, params) {
    const requestMethod = String(method || "");
    if (!codexRemoteSessionProviderRequestMethod(requestMethod)) return params;
    if (!codexRemoteSessionProviderOverrideEnabled()) return params;
    if (!params || typeof params !== "object" || Array.isArray(params)) return params;
    const profile = codexRemoteSessionActiveProfile();
    const pureApi = String(profile?.relayMode || "") === "pureApi";
    if (requestMethod === "turn/start" && !pureApi) return params;
    const hasModelProvider = Object.prototype.hasOwnProperty.call(params, "modelProvider")
      || Object.prototype.hasOwnProperty.call(params, "model_provider");
    if (requestMethod === "turn/start" && !hasModelProvider) return params;
    const targetProvider = codexRemoteSessionTargetProvider();
    if (!targetProvider || targetProvider === "openai") return params;
    const requestedProvider = String(params.modelProvider || params.model_provider || "").trim();
    if (requestedProvider && requestedProvider !== "openai" && requestedProvider !== targetProvider) {
      return params;
    }
    if (requestedProvider === targetProvider && !Object.prototype.hasOwnProperty.call(params, "model_provider")) {
      return params;
    }
    const nextParams = { ...params, modelProvider: targetProvider };
    delete nextParams.model_provider;
    sendCodexPlusDiagnostic("remote_session_provider_override_applied", {
      method: requestMethod,
      from: requestedProvider || "(missing)",
      to: targetProvider,
    });
    return nextParams;
  }

  function codexRemoteSessionStartedThreadId(value) {
    const queue = [{ value, depth: 0 }];
    const seen = new WeakSet();
    while (queue.length > 0) {
      const current = queue.shift();
      const candidate = current?.value;
      if (!candidate || typeof candidate !== "object") continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      const method = String(candidate.method || candidate.type || "");
      if (method === "thread/started") {
        const thread = candidate.params?.thread || candidate.thread || candidate.payload?.thread;
        const threadId = String(thread?.id || candidate.params?.threadId || candidate.threadId || "").trim();
        if (threadId) return threadId;
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
        // 只处理处于禁用状态的按钮，并用词边界匹配：以前是遍历页面上全部
        // <button> 再做子串匹配，其中裸 `"mic"` 会命中 dynamic / atomic /
        // economic / academic / comic 这类无关按钮，然后把这些按钮的 disabled
        // 也一并去掉，等于直接改坏宿主 UI 的按钮状态；顺带全量扫描的开销也更大。
        const voiceButtonPattern = /\bmic\b|voice|dictation|microphone/i;
        const enforceVoice = () => {
          document.querySelectorAll("button[disabled]").forEach((btn) => {
            const label = btn.getAttribute("aria-label")
              || btn.getAttribute("title")
              || btn.getAttribute("data-testid")
              || btn.textContent
              || "";
            if (!voiceButtonPattern.test(label)) return;
            btn.removeAttribute("disabled");
            btn.setAttribute("aria-disabled", "false");
            btn.style.opacity = "";
            btn.style.pointerEvents = "";
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
      if (includedNativeModels !== (codexPlusBackendSettings.codexAppIncludeNativeModels !== false)) {
        refreshCodexModelQueries();
      }
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
    if (loaded) void installExternalApiQuotaGate();
    return loaded;
  }

  let externalApiQuotaGateAttempted = false;
  async function installExternalApiQuotaGate() {
    window.__codexPlusExternalApiQuotaAllowed = (hostId) =>
      codexPlusBackendSettingsLoaded
      && window.__codexPlusApiQuotaGate?.permitsExternalApi(codexPlusBackendSettings, hostId) === true;
    if (externalApiQuotaGateAttempted || !window.__codexPlusApiQuotaGate) return;
    externalApiQuotaGateAttempted = true;
    try {
      const url = codexAppAssetUrl("app-primary-") || await codexAppAssetUrlFromScriptText("app-primary-");
      if (!url) return;
      const response = await fetch(url);
      if (!response.ok) return;
      const location = window.__codexPlusApiQuotaGate.locate(await response.text(), url);
      if (!location) return;
      window.__codexPlusApiQuotaBreakpoint = {
        ...location,
        condition: window.__codexPlusApiQuotaGate.condition(location),
      };
    } catch {
    }
  }
