  let codexModelCatalog = { status: "loading", model: "", default_model: "", model_provider: "", codex_model_provider: "", provider_name: "", models: [], sources: [], responses_api: { status: "unknown", message: "" } };
  let codexModelCatalogLoadedAt = 0;
  let codexModelCatalogPromise = null;
  let codexModelCatalogRetryAt = 0;
  let codexModelCatalogFailures = 0;
  let codexModelWhitelistRefreshTimer = 0;
  let codexModelWhitelistRefreshUntil = 0;
  let codexModelWhitelistLastScanAt = 0;
  const codexPlusModelListRequestIds = new Set();

  if (window.__CODEX_PLUS_TEST_SERVICE_TIER__) {
    window.__codexPlusServiceTierTest = {
      applyServiceTierOverride: (method, params, threadIdHint = "") => applyCodexServiceTierRequestOverride(method, params, threadIdHint),
      applyProviderOverride: (method, params) => applyCodexRemoteSessionProviderOverride(method, params),
      remoteSessionStartedThreadId: (value) => codexRemoteSessionStartedThreadId(value),
      observeRemoteSessionNotification: (value) => observeCodexRemoteSessionNotification(value),
      installRemoteSessionRecoveryListener: () => installCodexRemoteSessionRecoveryListener(),
      installRemoteSessionDispatcherSubscription: (dispatcher, assetPrefix = "test") => installCodexRemoteSessionDispatcherSubscription(dispatcher, assetPrefix),
      dispatchMessage: (dispatcher, type, payload) => dispatchCodexPlusMessage(dispatcher, type, payload),
      requestOverride: (message) => codexServiceTierRequestOverride(message),
      diagnostics: () => [...(window.__codexPlusServiceTierTestDiagnostics || [])],
      statusSummary: (state = {}) => {
        const summaryState = { ...codexServiceTierState, ...state };
        return serviceTierStatusMessage(
          summaryState.controlMode,
          summaryState.threadMode,
          summaryState.effectiveMode,
          summaryState.defaultMode,
          summaryState.effectiveServiceTier,
          summaryState.serviceTierSource
        );
      },
      resolveInheritedServiceTier: () => resolveInheritedServiceTier(),
      currentModelName: () => codexServiceTierCurrentModelName(),
      fastAvailability: (modelName = codexServiceTierCurrentModelName()) => codexServiceTierFastAvailability(modelName),
      modelDescriptor: (modelName) => codexPlusModelDescriptor(modelName),
      setModelCatalog: (catalog = {}) => {
        codexModelCatalog = {
          status: "ok",
          model: "",
          default_model: "",
          model_provider: "",
          codex_model_provider: "",
          provider_name: "",
          models: [],
          sources: [],
          responses_api: { status: "unknown", message: "" },
          ...catalog,
        };
        codexModelCatalogLoadedAt = Date.now();
        codexModelCatalogPromise = null;
      },
      setBackendSettings: (settings = {}) => {
        codexPlusBackendSettings = { ...codexPlusBackendSettings, ...settings };
        codexPlusBackendSettingsLoaded = true;
      },
      providerPatchEnabled: () => codexRemoteSessionProviderPatchEnabled(),
      providerNormalizationEnabled: () => codexRemoteSessionProviderNormalizationEnabled(),
      setServiceTierState: (state = {}) => {
        codexServiceTierState = { ...codexServiceTierState, ...state };
      },
      setThreadState: (state = {}) => {
        localStorage.setItem(codexThreadServiceTierKey, JSON.stringify({
          version: codexThreadServiceTierVersion,
          mode: "inherit",
          defaultMode: "inherit",
          entries: {},
          ...state,
        }));
      },
      settingStorageFromModule: codexSettingStorageFromModule,
      stateApiFromModule: codexStateApiFromModule,
      dispatcherFromModule: codexServiceTierDispatcherFromModule,
      patchAppServerClient: patchAppServerModelRequestClient,
    };
    return;
  }

  function codexPlusModelUnlockEnabled() {
    return !!codexPlusSettings().modelWhitelistUnlock;
  }

  function codexPlusModelNames() {
    return uniqueValues([
      codexModelCatalog.default_model,
      codexModelCatalog.model,
      ...(Array.isArray(codexModelCatalog.models) ? codexModelCatalog.models : []),
    ]);
  }

  async function loadCodexModelCatalog(force = false) {
    if (codexModelCatalogPromise) return codexModelCatalogPromise;
    if (!force && Date.now() < codexModelCatalogRetryAt) return codexModelCatalog;
    if (!force && codexModelCatalogLoadedAt && Date.now() - codexModelCatalogLoadedAt < 10000) return codexModelCatalog;
    codexModelCatalogPromise = postJson("/codex-model-catalog", {})
      .then((result) => {
        const changed = JSON.stringify(result) !== JSON.stringify(codexModelCatalog);
        codexModelCatalog = result && typeof result === "object" ? result : { status: "failed", model: "", default_model: "", model_provider: "", codex_model_provider: "", provider_name: "", models: [], sources: [], responses_api: { status: "unknown", message: "" } };
        codexModelCatalogLoadedAt = Date.now();
        if (changed) {
          renderCodexPlusMenu();
          scheduleCodexModelWhitelistRefresh();
          refreshCodexModelQueries();
        }
        return codexModelCatalog;
      })
      .catch((error) => {
        codexModelCatalog = { status: "failed", message: String(error?.message || error), model: "", default_model: "", model_provider: "", codex_model_provider: "", provider_name: "", models: [], sources: [], responses_api: { status: "unknown", message: "" } };
        codexModelCatalogLoadedAt = Date.now();
        return codexModelCatalog;
      })
      .finally(() => {
        codexModelCatalogFailures = codexModelCatalog.status === "failed" ? codexModelCatalogFailures + 1 : 0;
        codexModelCatalogRetryAt = codexModelCatalogFailures
          ? Date.now() + Math.min(60000, 5000 * 2 ** Math.min(codexModelCatalogFailures - 1, 4)) : 0;
        codexModelCatalogPromise = null;
      });
    return codexModelCatalogPromise;
  }

  function codexPlusModelMetadata(modelName) {
    const metadata = codexModelCatalog.modelMetadata || codexModelCatalog.model_metadata;
    const normalizedName = codexServiceTierModelFromValue(modelName);
    const exact = metadata && typeof metadata === "object" ? metadata[normalizedName] : null;
    const matchedKey = !exact && metadata && typeof metadata === "object"
      ? Object.keys(metadata).find((key) => key.toLowerCase() === normalizedName.toLowerCase())
      : null;
    const value = exact || (matchedKey ? metadata[matchedKey] : null);
    return value && typeof value === "object" ? value : null;
  }

  function modelReasoningEfforts(modelName) {
    const supported = codexPlusModelMetadata(modelName)?.supportedReasoningEfforts;
    if (Array.isArray(supported) && supported.length > 0) {
      const efforts = supported.map((entry) => ({ ...entry }));
      const hasMax = efforts.some((e) => e.reasoningEffort === "max");
      const hasUltra = efforts.some((e) => e.reasoningEffort === "ultra");
      if (!hasMax) efforts.push({ reasoningEffort: "max", description: "Maximum reasoning depth for the hardest problems" });
      if (!hasUltra) {
        const shouldAddUltra = /sol|terra|gpt-5\.6|gpt-5\.5|gpt-5\.4|deepseek/i.test(String(modelName || ""));
        if (shouldAddUltra || efforts.length >= 4) efforts.push({ reasoningEffort: "ultra", description: "Maximum reasoning with automatic task delegation" });
      }
      return efforts;
    }
    return ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} effort` }));
  }

  function applyCodexPlusModelMetadata(descriptor, modelName) {
    const metadata = codexPlusModelMetadata(modelName);
    if (!descriptor || !metadata) return false;
    let changed = false;
    for (const key of ["displayName", "description", "defaultReasoningEffort", "contextWindow", "maxContextWindow", "context_window", "max_context_window"]) {
      const valid = typeof metadata[key] === "string" ? !!metadata[key] : Number.isFinite(metadata[key]) && metadata[key] > 0;
      if (valid && descriptor[key] !== metadata[key]) {
        descriptor[key] = metadata[key];
        changed = true;
      }
    }
    if (Array.isArray(metadata.supportedReasoningEfforts) && metadata.supportedReasoningEfforts.length > 0) {
      const nextEfforts = modelReasoningEfforts(modelName);
      if (JSON.stringify(descriptor.supportedReasoningEfforts || []) !== JSON.stringify(nextEfforts)) {
        descriptor.supportedReasoningEfforts = nextEfforts;
        changed = true;
      }
    }
    return changed;
  }

  function codexPlusModelDescriptor(modelName) {
    const metadata = codexPlusModelMetadata(modelName);
    return {
      model: modelName,
      id: modelName,
      slug: modelName,
      name: modelName,
      displayName: metadata?.displayName || modelName,
      description: metadata?.description || codexModelCatalog.provider_name || codexModelCatalog.model_provider || "",
      __codexPlusInjected: true,
      hidden: false,
      isDefault: false,
      visibility: "list",
      supportedInApi: true,
      supported_in_api: true,
      priority: 1000,
      additionalSpeedTiers: metadata?.additionalSpeedTiers || [],
      serviceTiers: metadata?.serviceTiers || [],
      availabilityNux: null,
      upgrade: null,
      defaultReasoningEffort: metadata?.defaultReasoningEffort || "medium",
      supportedReasoningEfforts: modelReasoningEfforts(modelName),
      contextWindow: metadata?.contextWindow,
      maxContextWindow: metadata?.maxContextWindow,
      context_window: metadata?.context_window,
      max_context_window: metadata?.max_context_window,
    };
  }

  function sortModelChoices(models, nameOf, preferredModels = []) {
    const compare = new Intl.Collator("en", { numeric: true, sensitivity: "base" }).compare;
    const preferredOrder = new Map();
    preferredModels.forEach((model) => {
      const name = nameOf(model);
      if (!preferredOrder.has(name)) preferredOrder.set(name, preferredOrder.size);
    });
    const entries = models.map((model) => ({
      model,
      name: nameOf(model),
      parts: nameOf(model).trim().replace(/[._\s]+/g, "-").match(/\d+|\D+/g) || [],
    }));
    entries.sort((left, right) => {
      const leftPreferred = preferredOrder.get(left.name);
      const rightPreferred = preferredOrder.get(right.name);
      if (leftPreferred !== undefined || rightPreferred !== undefined) {
        if (leftPreferred === undefined) return 1;
        if (rightPreferred === undefined) return -1;
        return leftPreferred - rightPreferred;
      }
      const length = Math.min(left.parts.length, right.parts.length);
      for (let index = 0; index < length; index += 1) {
        const leftPart = left.parts[index];
        const rightPart = right.parts[index];
        const numeric = /^\d+$/.test(leftPart) && /^\d+$/.test(rightPart);
        const order = numeric ? compare(rightPart, leftPart) : compare(leftPart, rightPart);
        if (order) return order;
      }
      return right.parts.length - left.parts.length;
    });
    const changed = entries.some((entry, index) => entry.model !== models[index]);
    if (changed) models.splice(0, models.length, ...entries.map((entry) => entry.model));
    return changed;
  }

  function modelArrayLooksPatchable(value, allowEmpty = false) {
    return Array.isArray(value)
      && (allowEmpty || value.length > 0)
      && value.every((item) => item && typeof item === "object" && typeof item.model === "string");
  }

  function stringArrayLooksPatchable(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
  }

  function patchModelNameArray(models) {
    if (!stringArrayLooksPatchable(models)) return false;
    const customModels = codexPlusModelNames();
    if (!customModels.length) return false;
    const preferredModels = models.slice();
    let changed = false;
    customModels.forEach((modelName) => {
      if (!models.includes(modelName)) {
        models.push(modelName);
        changed = true;
      }
    });
    return sortModelChoices(models, (name) => name, preferredModels) || changed;
  }

  function patchModelArray(models, allowEmpty = false) {
    if (!modelArrayLooksPatchable(models, allowEmpty)) return false;
    const customModels = codexPlusModelNames();
    const preferredModels = models.filter((item) => !item.__codexPlusInjected);
    let changed = false;
    const sourceModels = new Set(customModels);
    const authoritative = codexPlusSettings().includeNativeModels === false
      && codexModelCatalog.status === "ok"
      && codexModelCatalog.model_provider && codexModelCatalog.model_provider !== "openai"
      && codexModelCatalog.sources?.some((source) => source.status === "ok" && source.models > 0
        && ["config", "relay_profile_model_list"].includes(source.type));
    // 用户取消混入原生模型且第三方目录成功加载后，才按供应商清单筛选。
    for (let index = models.length - 1; index >= 0; index -= 1) {
      if ((authoritative || models[index].__codexPlusInjected) && !sourceModels.has(models[index].model)) {
        models.splice(index, 1);
        changed = true;
      }
    }
    const existing = new Map(models.map((item) => [item.model, item]));
    models.forEach((item) => {
      if (customModels.includes(item.model)) {
        if (item.hidden !== false) {
          item.hidden = false;
          changed = true;
        }
        if (applyCodexPlusModelMetadata(item, item.model)) changed = true;
      }
    });
    customModels.forEach((modelName) => {
      if (!existing.has(modelName)) {
        models.push(codexPlusModelDescriptor(modelName));
        changed = true;
      }
    });
    if (customModels.length && codexModelCatalog.status === "ok") {
      if (sortModelChoices(models, (item) => item.model, preferredModels)) changed = true;
      models.forEach((item, index) => {
        if (item.priority !== index) { item.priority = index; changed = true; }
      });
    }
    return changed;
  }

  function patchModelContainer(value) {
    if (!value || typeof value !== "object") return false;
    let changed = false;
    if (patchModelArray(value.models, "defaultModel" in value || "availableModels" in value)) changed = true;
    if (patchModelNameArray(value.models)) changed = true;
    if (patchModelArray(value.data)) changed = true;
    if (patchModelArray(value.result)) changed = true;
    if (patchModelArray(value.pages?.[0]?.data)) changed = true;
    if (patchModelArray(value.result?.data)) changed = true;
    if (patchModelArray(value.result?.models)) changed = true;
    if (patchModelArray(value.message?.result?.data)) changed = true;
    if (patchModelArray(value.message?.result?.models)) changed = true;
    const names = codexPlusModelNames();
    if (value.availableModels instanceof Set) {
      names.forEach((name) => {
        if (!value.availableModels.has(name)) {
          value.availableModels.add(name);
          changed = true;
        }
      });
    }
    if (value.available_models instanceof Set) {
      names.forEach((name) => {
        if (!value.available_models.has(name)) {
          value.available_models.add(name);
          changed = true;
        }
      });
    }
    if (Array.isArray(value.availableModels)) {
      names.forEach((name) => {
        if (!value.availableModels.includes(name)) {
          value.availableModels.push(name);
          changed = true;
        }
      });
    }
    if (Array.isArray(value.available_models)) {
      names.forEach((name) => {
        if (!value.available_models.includes(name)) {
          value.available_models.push(name);
          changed = true;
        }
      });
    }
    if (Array.isArray(value.hiddenModels)) {
      const before = value.hiddenModels.length;
      value.hiddenModels = value.hiddenModels.filter((name) => !names.includes(name));
      if (value.hiddenModels.length !== before) changed = true;
    }
    if (Array.isArray(value.hidden_models)) {
      const before = value.hidden_models.length;
      value.hidden_models = value.hidden_models.filter((name) => !names.includes(name));
      if (value.hidden_models.length !== before) changed = true;
    }
    return changed;
  }

  function modelJsonResponseLooksPatchable(payload) {
    if (!payload || typeof payload !== "object") return false;
    const descriptorArrays = [
      payload.models,
      payload.data,
      payload.result,
      payload.pages?.[0]?.data,
      payload.result?.data,
      payload.result?.models,
      payload.message?.result?.data,
      payload.message?.result?.models,
    ];
    if (descriptorArrays.some((value) => modelArrayLooksPatchable(value))) return true;
    const hasModelContainerSignal = "defaultModel" in payload
      || "default_model" in payload
      || "availableModels" in payload
      || "available_models" in payload
      || "hiddenModels" in payload
      || "hidden_models" in payload
      || "modelMetadata" in payload
      || "model_metadata" in payload;
    return hasModelContainerSignal && Array.isArray(payload.models)
      && payload.models.every((value) => typeof value === "string");
  }

  // 补丁失败的唯一出口。
  //
  // 这些 catch 挂在消息/响应这类高频路径上：以前只把错误 push 进
  // window.__codexPlusModelPatchFailures，而全仓没有任何地方读它 —— Codex 升级
  // 导致模型补丁失效时，用户只看到"模型列表不对"，诊断日志里一行都没有。
  // 现在既保留一份有上限的现场记录，也送进诊断通道（/diagnostics/log）。
  const CODEX_PLUS_PATCH_FAILURE_LIMIT = 20;

  function recordCodexPlusPatchFailure(windowKey, scope, error) {
    const detail = String(error?.stack || error);
    const failures = (window[windowKey] = window[windowKey] || []);
    failures.push(`${scope}: ${detail}`);
    if (failures.length > CODEX_PLUS_PATCH_FAILURE_LIMIT) {
      failures.splice(0, failures.length - CODEX_PLUS_PATCH_FAILURE_LIMIT);
    }
    sendCodexPlusDiagnostic("model_patch_failed", { scope, error: detail });
  }

  async function patchModelJsonResponse(payload) {
    if (!codexPlusModelUnlockEnabled()) return payload;
    if (!modelJsonResponseLooksPatchable(payload)) return payload;
    if (!codexPlusModelNames().length) await loadCodexModelCatalog();
    try {
      patchModelContainer(payload);
    } catch (error) {
      recordCodexPlusPatchFailure("__codexPlusModelPatchFailures", "model-json-response", error);
    }
    return payload;
  }

  function installModelJsonResponsePatch() {
    if (window.__codexPlusModelJsonResponsePatchInstalled === "1") return;
    window.__codexPlusModelJsonResponsePatchInstalled = "1";
    window.__codexPlusModelJsonResponseOriginals = window.__codexPlusModelJsonResponseOriginals || {};
    const originals = window.__codexPlusModelJsonResponseOriginals;
    originals.responseJson = originals.responseJson || Response.prototype.json;
    if (typeof originals.responseJson !== "function") return;
    Response.prototype.json = async function codexPlusPatchedResponseJson(...args) {
      const payload = await originals.responseJson.apply(this, args);
      // 仅对模型端点保留兼容拦截，其他响应不进入模型目录加载流程。
      if (!/\/(?:v\d+\/)?models(?:[/?#]|$)|\/model\/list(?:[/?#]|$)/i.test(this.url || "")) return payload;
      return await patchModelJsonResponse(payload);
    };
  }

  function patchStatsigModelDynamicConfig(config) {
    const names = codexPlusModelNames();
    const value = config?.value;
    if (!names.length || !value || typeof value !== "object") return config;
    const availableModels = Array.isArray(value.available_models) ? [...value.available_models] : [];
    let changed = false;
    names.forEach((name) => {
      if (!availableModels.includes(name)) {
        availableModels.push(name);
        changed = true;
      }
    });
    if (!changed) return config;
    const nextValue = { ...value, available_models: availableModels };
    try {
      config.value = nextValue;
    } catch {
      return { ...config, value: nextValue };
    }
    return config;
  }

  function statsigClients() {
    const root = window.__STATSIG__ || globalThis.__STATSIG__;
    if (!root || typeof root !== "object") return [];
    const clients = [root.firstInstance, typeof root.instance === "function" ? root.instance() : null];
    if (root.instances && typeof root.instances === "object") clients.push(...Object.values(root.instances));
    return clients.filter((client, index, array) => client && typeof client === "object" && array.indexOf(client) === index);
  }

  function patchStatsigModelWhitelist() {
    let ready = false;
    statsigClients().forEach((client) => {
      if (typeof client.getDynamicConfig !== "function") return;
      if (!client.__codexPlusModelWhitelistPatched) {
        const originalGetDynamicConfig = client.getDynamicConfig.bind(client);
        client.getDynamicConfig = (name, options) => {
          const result = originalGetDynamicConfig(name, options);
          return String(name) === "107580212" ? patchStatsigModelDynamicConfig(result) : result;
        };
        client.__codexPlusModelWhitelistPatched = true;
      }
      try {
        patchStatsigModelDynamicConfig(client.getDynamicConfig("107580212", { disableExposureLog: true }));
        ready = true;
      } catch {
      }
    });
    return ready;
  }

  function patchAppServerModelMessages() {
    if (window.__codexPlusModelMessagePatchInstalled) return;
    window.__codexPlusModelMessagePatchInstalled = true;
    window.addEventListener("codex-message-from-view", (event) => {
      try {
        const detail = event?.detail;
        const request = detail?.request;
        if (detail?.type === "mcp-request" && request?.method === "model/list") {
          request.params = { ...(request.params || {}), includeHidden: true };
          if (request.id != null) {
            const requestId = String(request.id);
            codexPlusModelListRequestIds.add(requestId);
            if (codexPlusModelListRequestIds.size > 64) {
              codexPlusModelListRequestIds.delete(codexPlusModelListRequestIds.values().next().value);
            }
            window.setTimeout(() => codexPlusModelListRequestIds.delete(requestId), 30_000);
          }
        }
      } catch (error) {
        recordCodexPlusPatchFailure("__codexPlusModelPatchFailures", "mcp-model-list-request", error);
      }
    }, true);

    window.addEventListener("message", (event) => {
      try {
        patchMcpModelResponseData(event?.data);
      } catch (error) {
        recordCodexPlusPatchFailure("__codexPlusModelPatchFailures", "mcp-model-response", error);
      }
    }, true);
  }

  function patchMcpModelResponseData(data) {
    if (!codexPlusModelUnlockEnabled()) return false;
    if (data?.type !== "mcp-response") return false;
    const message = data.message || data.response;
    const requestId = message?.id != null ? String(message.id) : "";
    if (codexPlusModelListRequestIds.size === 0 || !codexPlusModelListRequestIds.has(requestId)) return false;
    codexPlusModelListRequestIds.delete(requestId);
    let changed = false;
    if (patchModelArray(message?.result?.data, true)) changed = true;
    if (patchModelArray(message?.result?.models, true)) changed = true;
    return changed;
  }

  function appServerModelRequestMethod(method, params) {
    if (method === "send-cli-request-for-host" && params?.method) return String(params.method);
    if (method === "vscode://codex/list-plugins") return "list-plugins";
    if (method === "vscode://codex/plugin/install") return "install-plugin";
    if (method === "vscode://codex/plugin/uninstall") return "uninstall-plugin";
    if (method === "plugin/list") return "list-plugins";
    if (method === "plugin/install") return "install-plugin";
    if (method === "plugin/uninstall") return "uninstall-plugin";
    return String(method || "");
  }

  function cloneModelResult(result) {
    if (result == null || typeof result !== "object") return result;
    try {
      if (typeof structuredClone === "function") return structuredClone(result);
    } catch {
    }
    const cloneArray = (value) => Array.isArray(value)
      ? value.map((item) => item && typeof item === "object" ? { ...item } : item)
      : value;
    if (Array.isArray(result)) return cloneArray(result);
    const patched = { ...result };
    for (const key of ["data", "models", "result"]) {
      if (Array.isArray(patched[key])) patched[key] = cloneArray(patched[key]);
    }
    return patched;
  }

  function patchAppServerModelResult(method, result) {
    if (method !== "list-models-for-host" && method !== "model/list") return result;
    const patched = cloneModelResult(result);
    try {
      if (Array.isArray(patched)) patchModelArray(patched, true);
      if (Array.isArray(patched?.data)) patchModelArray(patched.data, true);
      if (Array.isArray(patched?.models)) patchModelArray(patched.models, true);
      sendCodexPlusDiagnostic("model_app_server_result_patched", {
        method,
        modelCount: Array.isArray(patched?.data) ? patched.data.length : Array.isArray(patched?.models) ? patched.models.length : Array.isArray(patched) ? patched.length : null,
      });
    } catch (error) {
      recordCodexPlusPatchFailure("__codexPlusModelPatchFailures", "app-server-model-result", error);
    }
    return patched;
  }

  function codexPerModelContextEnabled() {
    const profile = codexRemoteSessionActiveProfile();
    if (!profile) return false;
    return [profile.modelWindows, profile.modelAutoCompact, profile.modelMetadata]
      .some((value) => typeof value === "string" && value.trim() && value.trim() !== "{}");
  }

  function codexThreadModelRequestState(method, params, result) {
    const requestMethod = String(method || "");
    const threadId = String(
      params?.threadId
      || params?.conversationId
      || result?.thread?.id
      || result?.threadId
      || ""
    ).trim();
    const model = String(params?.model || result?.thread?.model || "").trim();
    return { requestMethod, threadId, model };
  }

  async function refreshCodexThreadModelBeforeTurn(client, originalSendRequest, method, params, options) {
    if (String(method || "") !== "turn/start" || !codexPerModelContextEnabled()) return null;
    const { threadId, model } = codexThreadModelRequestState(method, params);
    if (!threadId || !model) return null;
    const previousModel = client.__codexPlusThreadModels?.get(threadId) || "";
    if (!previousModel || previousModel === model) return null;
    let resumeParams = { threadId, model };
    resumeParams = applyCodexRemoteSessionProviderOverride("thread/resume", resumeParams);
    try {
      await originalSendRequest("thread/resume", resumeParams, options);
      client.__codexPlusThreadModels.set(threadId, model);
      sendCodexPlusDiagnostic("thread_model_context_refreshed", {
        threadId,
        from: previousModel,
        to: model,
      });
      return true;
    } catch (error) {
      sendCodexPlusDiagnostic("thread_model_context_refresh_failed", {
        threadId,
        from: previousModel,
        to: model,
        errorName: error?.name || "",
        errorMessage: error?.message || String(error),
      });
      return false;
    }
  }

  function patchAppServerModelRequestClient(client) {
    if (!client || typeof client.sendRequest !== "function") return false;
    if (client.__codexPlusModelRequestPatch === codexAppServerModelRequestPatchVersion) return true;
    const originalSendRequest = client.__codexPlusModelOriginalSendRequest || client.sendRequest.bind(client);
    client.__codexPlusModelOriginalSendRequest = originalSendRequest;
    client.__codexPlusThreadModels = client.__codexPlusThreadModels || new Map();
    client.sendRequest = async function codexPlusModelPatchedSendRequest(method, params, options) {
      const requestMethod = appServerModelRequestMethod(String(method || ""), params);
      let providerRefreshFailed = false;
      if (codexRemoteSessionProviderRequestMethod(requestMethod)
          && codexRemoteSessionProviderPatchEnabled()
          && window.__codexSessionDeleteBridge) {
        const settingsLoaded = await loadBackendSettingsState();
        providerRefreshFailed = !settingsLoaded;
        if (providerRefreshFailed) {
          sendCodexPlusDiagnostic("remote_session_provider_refresh_failed", {});
        }
      } else if (codexRemoteSessionProviderRequestMethod(requestMethod)
          && codexRemoteSessionProviderOverrideEnabled()
          && !codexRemoteSessionTargetProvider()) {
        await loadCodexModelCatalog();
      }
      const nextParams = providerRefreshFailed
        ? params
        : applyCodexRemoteSessionProviderOverride(requestMethod, params);
      const modelContextRefresh = await refreshCodexThreadModelBeforeTurn(
        client,
        originalSendRequest,
        method,
        nextParams,
        options
      );
      const result = await originalSendRequest(method, nextParams, options);
      const threadState = codexThreadModelRequestState(requestMethod, nextParams, result);
      if (modelContextRefresh !== false && threadState.threadId && threadState.model
          && ["thread/start", "thread/resume", "turn/start"].includes(threadState.requestMethod)) {
        client.__codexPlusThreadModels.set(threadState.threadId, threadState.model);
      }
      if (!codexPlusModelUnlockEnabled()
          || !["list-models-for-host", "model/list"].includes(requestMethod)
          || (client.__codexPlusHostId && client.__codexPlusHostId !== "local")) return result;
      await loadCodexModelCatalog();
      return patchAppServerModelResult(requestMethod, result);
    };
    client.__codexPlusModelRequestPatch = codexAppServerModelRequestPatchVersion;
    return true;
  }

  const appServerModelRequestPatchMaxMisses = 8;
  let appServerModelRequestPatchMissCount = 0;
  let appServerModelRequestPatchDisabled = false;
  let appServerModelRequestPatchPromise = null;
  let appServerModelRequestPatchRetryTimer = 0;

  function scheduleAppServerModelRequestPatchRetry() {
    if (!codexRemoteSessionProviderPatchEnabled()) return;
    if (appServerModelRequestPatchRetryTimer) return;
    appServerModelRequestPatchRetryTimer = window.setTimeout(() => {
      appServerModelRequestPatchRetryTimer = 0;
      installAppServerModelRequestPatch();
    }, Math.min(30000, 250 * 2 ** Math.min(Math.max(0, appServerModelRequestPatchMissCount - 1), 7)));
  }

  function noteAppServerModelRequestPatchMiss(event, detail) {
    appServerModelRequestPatchMissCount += 1;
    // 模块改名或尚未加载时只记录首次失败，远程供应商兼容层逐步退避重试。
    // 其他情况在多次失败后停用本层，保留 Statsig 和模型响应补充。
    if (appServerModelRequestPatchMissCount === 1) {
      sendCodexPlusDiagnostic(event, detail);
    }
    if (codexRemoteSessionProviderPatchEnabled()) {
      scheduleAppServerModelRequestPatchRetry();
      return;
    }
    if (appServerModelRequestPatchMissCount >= appServerModelRequestPatchMaxMisses && !appServerModelRequestPatchDisabled) {
      appServerModelRequestPatchDisabled = true;
      sendCodexPlusDiagnostic("model_app_server_request_patch_skipped", {
        misses: appServerModelRequestPatchMissCount,
        lastEvent: event,
      });
    }
  }

  function installAppServerModelRequestPatch() {
    if (window.__codexPlusAppServerModelRequestPatchInstalled === codexAppServerModelRequestPatchVersion) return;
    if (appServerModelRequestPatchDisabled) return;
    if (appServerModelRequestPatchPromise) return;
    if (appServerModelRequestPatchRetryTimer) return;
    const patch = async () => {
      try {
        const { modules, candidates, sources, discovery } = await loadAppServerRequestCandidates();
        if (modules.length === 0) {
          noteAppServerModelRequestPatchMiss("model_app_server_request_patch_skipped", {
            reason: "app_server_request_assets_missing",
          });
          return;
        }
        let patchedCount = 0;
        for (const candidate of candidates) {
          try {
            if (patchAppServerModelRequestClient(candidate)) patchedCount += 1;
          } catch {
            // 不可写的候选对象不应阻断后面的 RPC 适配客户端。
          }
        }
        if (patchedCount > 0) {
          clearTimeout(appServerModelRequestPatchRetryTimer);
          appServerModelRequestPatchRetryTimer = 0;
          appServerModelRequestPatchMissCount = 0;
          window.__codexPlusAppServerModelRequestPatchInstalled = codexAppServerModelRequestPatchVersion;
          sendCodexPlusDiagnostic("model_app_server_request_patch_installed", {
            moduleCount: modules.length,
            candidateCount: candidates.length,
            patchedCount,
            sources,
            discovery,
          });
        } else {
          noteAppServerModelRequestPatchMiss("model_app_server_request_patch_not_found", {
            moduleCount: modules.length,
            candidateCount: candidates.length,
            sources,
            discovery,
          });
        }
      } catch (error) {
        noteAppServerModelRequestPatchMiss("model_app_server_request_patch_failed", {
          errorName: error?.name || "",
          errorMessage: error?.message || String(error),
        });
      }
    };
    appServerModelRequestPatchPromise = patch().finally(() => {
      appServerModelRequestPatchPromise = null;
    });
    void appServerModelRequestPatchPromise;
  }

  function ensureCodexModelWhitelistInstalls() {
    if (codexPlusModelUnlockEnabled()
        || (codexPlusBackendSettingsLoaded && codexRemoteSessionProviderPatchEnabled())) {
      installAppServerModelRequestPatch();
    }
    void installDictationSupportPatch();
    if (!codexPlusModelUnlockEnabled()) return;
    installModelJsonResponsePatch();
    patchAppServerModelMessages();
  }

  function runCodexModelWhitelistRefreshPass() {
    if (!codexPlusModelUnlockEnabled() || !codexPlusModelNames().length) return false;
    try {
      installAppServerModelRequestPatch();
      return patchStatsigModelWhitelist();
    } catch (error) {
      recordCodexPlusPatchFailure("__codexPlusModelPatchFailures", "model-whitelist-refresh", error);
    }
    return false;
  }

  function scheduleCodexModelWhitelistRefresh(durationMs = 2500) {
    if (!codexPlusModelUnlockEnabled()) return;
    codexModelWhitelistRefreshUntil = Math.max(codexModelWhitelistRefreshUntil, Date.now() + durationMs);
    if (codexModelWhitelistRefreshTimer) return;
    sendCodexPlusDiagnostic("model_whitelist_refresh_scheduled", { durationMs });
    let delay = 120;
    const tick = () => {
      codexModelWhitelistRefreshTimer = 0;
      if (runCodexModelWhitelistRefreshPass()) return;
      if (Date.now() < codexModelWhitelistRefreshUntil) {
        codexModelWhitelistRefreshTimer = window.setTimeout(tick, delay);
        delay = Math.min(delay * 2, 1000);
      }
    };
    tick();
  }

  function refreshCodexModelWhitelistFromScan() {
    // 连续页面变更共用刷新预算；目录变化仍会立即触发独立的补充流程。
    const now = Date.now();
    if (codexModelWhitelistLastScanAt && now - codexModelWhitelistLastScanAt < 1000) return;
    codexModelWhitelistLastScanAt = now;
    ensureCodexModelWhitelistInstalls();
    if (!codexPlusModelUnlockEnabled()) return;
    void loadCodexModelCatalog();
    runCodexModelWhitelistRefreshPass();
  }
