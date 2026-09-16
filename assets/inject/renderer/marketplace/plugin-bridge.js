  const codexPluginRemoteOnlyMarketplaceKinds = new Set(["created-by-me-remote", "shared-with-me"]);

  function pluginMarketplaceRequestProfile(params) {
    const marketplaceKinds = Array.isArray(params?.marketplaceKinds)
      ? Array.from(new Set(params.marketplaceKinds.map((kind) => restorePluginMarketplaceName(kind))))
      : [];
    const hasRemoteOnlyKind = marketplaceKinds.some((kind) => codexPluginRemoteOnlyMarketplaceKinds.has(kind));
    const hasLocalKind = marketplaceKinds.includes("local");
    const hasOtherKind = marketplaceKinds.some(
      (kind) => !codexPluginRemoteOnlyMarketplaceKinds.has(kind) && kind !== "vertical"
    );
    return {
      marketplaceKinds,
      remoteOnly: hasRemoteOnlyKind && !hasLocalKind && !hasOtherKind,
    };
  }

  function patchPluginMarketplaceRequestParams(method, params) {
    if (method === "list-plugins") {
      if (!params || typeof params !== "object") return params;
    } else {
      return params;
    }
    const next = { ...params };
    const requestProfile = pluginMarketplaceRequestProfile(next);
    const requestCwds = Array.isArray(next.cwds)
      ? next.cwds.filter((cwd) => typeof cwd === "string" && cwd.trim())
      : [];
    if (requestCwds.length > 0) {
      window.__codexPluginMarketplaceLastCwds = Array.from(new Set(requestCwds));
    } else if (!requestProfile.remoteOnly && Array.isArray(window.__codexPluginMarketplaceLastCwds) && window.__codexPluginMarketplaceLastCwds.length > 0) {
      next.cwds = [...window.__codexPluginMarketplaceLastCwds];
    }
    const hadMarketplaceKinds = Object.prototype.hasOwnProperty.call(next, "marketplaceKinds");
    const broadCatalogRequest = codexPluginUsesBroadCatalogKinds()
      && (!hadMarketplaceKinds || next.marketplaceKinds == null);
    const remoteCatalogUnavailable = window.__codexPluginMarketplaceRemoteCatalogUnavailable === true;
    if (broadCatalogRequest && !remoteCatalogUnavailable) {
      sendCodexPlusDiagnostic("plugin_marketplace_request_expanded", {
        hadMarketplaceKinds,
        marketplaceKinds: hadMarketplaceKinds ? next.marketplaceKinds : null,
        broadCatalogPreserved: true,
        cwdCount: Array.isArray(next.cwds) ? next.cwds.length : 0,
        cwdRestored: requestCwds.length === 0 && Array.isArray(next.cwds) && next.cwds.length > 0,
        remoteCatalogUnavailable,
        remoteOnly: requestProfile.remoteOnly,
      });
      return next;
    }
    let nextKinds = Array.isArray(next.marketplaceKinds)
      ? next.marketplaceKinds.map((kind) => restorePluginMarketplaceName(kind))
      : ["local"];
    if (!requestProfile.remoteOnly && remoteCatalogUnavailable) {
      nextKinds = nextKinds.filter((kind) => kind !== "created-by-me-remote" && kind !== "shared-with-me");
    }
    if (!requestProfile.remoteOnly) {
      if (!nextKinds.includes("local")) nextKinds.push("local");
      if (!nextKinds.includes("vertical")) nextKinds.push("vertical");
    }
    next.marketplaceKinds = Array.from(new Set(nextKinds));
    sendCodexPlusDiagnostic("plugin_marketplace_request_expanded", {
      hadMarketplaceKinds,
      marketplaceKinds: next.marketplaceKinds,
      broadCatalogPreserved: false,
      cwdCount: Array.isArray(next.cwds) ? next.cwds.length : 0,
      cwdRestored: requestCwds.length === 0 && Array.isArray(next.cwds) && next.cwds.length > 0,
      remoteCatalogUnavailable,
      remoteOnly: requestProfile.remoteOnly,
    });
    return next;
  }

  function displayNameForPluginMarketplaceName(name, fallback) {
    if (name === "openai-bundled") return "OpenAI插件1(Codex++)";
    if (name === "openai-curated") return "OpenAI插件2(Codex++)";
    if (name === "openai-primary-runtime") return "OpenAI插件3(Codex++)";
    if (name === "openai-api-curated") return "OpenAI插件4(Codex++)";
    // 内置插件包的注册名。曾经叫 openai-curated-remote，但那是 codex 的保留名，
    // 注册在它下面会被静默忽略，已改为 codex-plus-curated；旧名保留以兼容
    // 尚未升级的配置。
    if (name === "codex-plus-curated" || name === "openai-curated-remote") return "OpenAI插件5(Codex++)";
    return fallback;
  }

  function patchPluginMarketplaceObject(marketplace) {
    if (!marketplace || typeof marketplace !== "object" || marketplace.__codexPlusMarketplaceUnlockPatched) return false;
    const displayName = displayNameForPluginMarketplaceName(marketplace.name, marketplace.displayName || marketplace.title || marketplace.label || marketplace.name);
    if (!displayName || displayName === marketplace.name) return false;
    marketplace.displayName = displayName;
    marketplace.title = displayName;
    marketplace.label = displayName;
    if (marketplace.interface && typeof marketplace.interface === "object") {
      marketplace.interface = {
        ...marketplace.interface,
        displayName,
        name: displayName,
        title: displayName,
        label: displayName,
      };
    } else {
      marketplace.interface = { displayName, name: displayName, title: displayName, label: displayName };
    }
    marketplace.__codexPlusMarketplaceUnlockPatched = true;
    return true;
  }

  function cloneCodexPluginMarketplace(value) {
    if (!value || typeof value !== "object") return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  }

  function pluginMarketplacePluginKey(plugin) {
    if (!plugin || typeof plugin !== "object") return "";
    return String(plugin.name || plugin.id || plugin.pluginName || "").trim();
  }

  function normalizeLocalPluginMarketplacePlugin(plugin, marketplaceName) {
    const cloned = cloneCodexPluginMarketplace(plugin);
    if (!cloned || typeof cloned !== "object") return null;
    const name = String(cloned.name || cloned.id || cloned.pluginName || "").trim();
    if (!name) return null;
    if (!cloned.name) cloned.name = name;
    if (!cloned.id) cloned.id = `${name}@${marketplaceName}`;
    if (!cloned.marketplaceName) cloned.marketplaceName = marketplaceName;
    if (!cloned.marketplacePath) cloned.marketplacePath = marketplaceName;
    if (!cloned.interface || typeof cloned.interface !== "object") cloned.interface = {};
    if (!cloned.interface.displayName) cloned.interface.displayName = name;
    if (!Array.isArray(cloned.keywords)) cloned.keywords = [];
    return cloned;
  }

  function mergePluginMarketplacePlugins(target, source) {
    if (!target || !source || !Array.isArray(source.plugins)) return 0;
    if (!Array.isArray(target.plugins)) target.plugins = [];
    const marketplaceName = restorePluginMarketplaceName(target.name || source.name || "");
    const existing = new Set(target.plugins.map(pluginMarketplacePluginKey).filter(Boolean));
    let added = 0;
    source.plugins.forEach((plugin) => {
      const key = pluginMarketplacePluginKey(plugin);
      if (!key || existing.has(key)) return;
      const cloned = normalizeLocalPluginMarketplacePlugin(plugin, marketplaceName);
      if (!cloned) return;
      target.plugins.push(cloned);
      existing.add(key);
      added += 1;
    });
    return added;
  }

  function mergeLocalPluginMarketplaces(result) {
    if (!result || typeof result !== "object" || !Array.isArray(result.marketplaces)) {
      return { addedMarketplaces: 0, addedPlugins: 0 };
    }
    const localMarketplaces = Array.isArray(window.__CODEX_PLUS_PLUGIN_MARKETPLACES__)
      ? window.__CODEX_PLUS_PLUGIN_MARKETPLACES__
      : [];
    if (!localMarketplaces.length) return { addedMarketplaces: 0, addedPlugins: 0 };
    const byName = new Map();
    result.marketplaces.forEach((marketplace) => {
      const name = restorePluginMarketplaceName(marketplace?.name || "");
      if (name) byName.set(name, marketplace);
    });
    let addedMarketplaces = 0;
    let addedPlugins = 0;
    localMarketplaces.forEach((marketplace) => {
      const name = restorePluginMarketplaceName(marketplace?.name || "");
      if (!name) return;
      const existing = byName.get(name);
      if (existing) {
        addedPlugins += mergePluginMarketplacePlugins(existing, marketplace);
        return;
      }
      const cloned = cloneCodexPluginMarketplace(marketplace);
      if (!cloned) return;
      cloned.plugins = Array.isArray(cloned.plugins)
        ? cloned.plugins.map((plugin) => normalizeLocalPluginMarketplacePlugin(plugin, name)).filter(Boolean)
        : [];
      result.marketplaces.push(cloned);
      byName.set(name, cloned);
      addedMarketplaces += 1;
      addedPlugins += Array.isArray(cloned.plugins) ? cloned.plugins.length : 0;
    });
    if (addedMarketplaces > 0 || addedPlugins > 0) {
      sendCodexPlusDiagnostic("plugin_marketplace_local_merged", { addedMarketplaces, addedPlugins });
    }
    return { addedMarketplaces, addedPlugins };
  }

  function restorePluginMarketplaceName(name) {
    if (name === "codex-plus-openai-bundled") return "openai-bundled";
    if (name === "codex-plus-openai-curated") return "openai-curated";
    if (name === "codex-plus-openai-primary-runtime") return "openai-primary-runtime";
    if (name === "codex-plus-openai-api-curated") return "openai-api-curated";
    if (name === "codex-plus-openai-curated-remote") return "openai-curated-remote";
    return name;
  }

  function codexPluginOfficialMarketplaceName(name) {
    const restored = restorePluginMarketplaceName(name);
    return restored === "openai-bundled" || restored === "openai-curated" || restored === "openai-primary-runtime" || restored === "openai-api-curated" || restored === "openai-curated-remote";
  }

  const codexPluginFilterSourceCache = new WeakMap();

  function codexPluginFilterCallbackSource(callback) {
    if (codexPluginFilterSourceCache.has(callback)) {
      return codexPluginFilterSourceCache.get(callback);
    }
    let source = "";
    try {
      source = Function.prototype.toString.call(callback);
    } catch {
    }
    codexPluginFilterSourceCache.set(callback, source);
    return source;
  }

  function isCodexPluginBuildFlavorFilter(callback, sample, filtered = null) {
    if (!Array.isArray(sample) || sample.length === 0 || typeof callback !== "function") return false;
    if (!sample.some((plugin) => codexPluginOfficialMarketplaceName(plugin?.marketplaceName))) return false;
    const source = codexPluginFilterCallbackSource(callback);
    if (!source) return false;
    const isKnownFilterSource = source.includes("!u(e.marketplaceName)||e.marketplaceName===r")
      || source.includes("!ne(e.marketplaceName)||e.marketplaceName===n")
      || source.includes("!Eu(e.marketplaceName)||e.marketplaceName===n");
    if (!isKnownFilterSource) return false;
    return sample.some((plugin) => codexPluginOfficialMarketplaceName(plugin?.marketplaceName)
      && (Array.isArray(filtered) ? !filtered.includes(plugin) : !callback(plugin)));
  }

  function isCodexPluginMarketplaceHiddenFilter(callback, sample, filtered = null) {
    if (!Array.isArray(sample) || sample.length === 0 || typeof callback !== "function") return false;
    if (!sample.some((marketplace) => codexPluginOfficialMarketplaceName(marketplace?.name))) return false;
    const source = codexPluginFilterCallbackSource(callback);
    if (!source) return false;
    if (!source.includes("!t.includes(e.name)")) return false;
    return sample.some((marketplace) => codexPluginOfficialMarketplaceName(marketplace?.name)
      && (Array.isArray(filtered) ? !filtered.includes(marketplace) : !callback(marketplace)));
  }

  function installPluginBuildFlavorFilterPatch() {
    if (window.__codexPluginBuildFlavorFilterPatch === codexPluginMarketplaceUnlockVersion) return;
    if (pluginPatchDisabledInRelayMode()) return;
    if (!codexPlusSettings().pluginMarketplaceUnlock) return;
    const originalFilter = Array.prototype.__codexPluginBuildFlavorOriginalFilter || Array.prototype.filter;
    if (!Array.prototype.__codexPluginBuildFlavorOriginalFilter) {
      Object.defineProperty(Array.prototype, "__codexPluginBuildFlavorOriginalFilter", {
        value: originalFilter,
        configurable: true,
        writable: true,
      });
    }
    if (Array.prototype.filter.__codexPluginBuildFlavorPatched === codexPluginMarketplaceUnlockVersion) {
      window.__codexPluginBuildFlavorFilterPatch = codexPluginMarketplaceUnlockVersion;
      return;
    }
    const patchedFilter = function codexPluginBuildFlavorFilterPatch(callback, thisArg) {
      const filtered = originalFilter.call(this, callback, thisArg);
      if (filtered.length === this.length) return filtered;
      if (isCodexPluginBuildFlavorFilter(callback, this, filtered)) {
        sendCodexPlusDiagnostic("plugin_build_flavor_filter_bypassed", { pluginCount: this.length });
        return Array.from(this);
      }
      if (isCodexPluginMarketplaceHiddenFilter(callback, this, filtered)) {
        sendCodexPlusDiagnostic("plugin_marketplace_hidden_filter_bypassed", { marketplaceCount: this.length });
        return Array.from(this);
      }
      return filtered;
    };
    patchedFilter.__codexPluginBuildFlavorPatched = codexPluginMarketplaceUnlockVersion;
    Array.prototype.filter = patchedFilter;
    window.__codexPluginBuildFlavorFilterPatch = codexPluginMarketplaceUnlockVersion;
    sendCodexPlusDiagnostic("plugin_build_flavor_filter_patch_installed", {});
  }

  function restorePluginMarketplaceRequestParams(params, method = "") {
    if (!params || typeof params !== "object") return params;
    let next = params;
    if (Array.isArray(params.marketplaceKinds)) {
      const nextKinds = params.marketplaceKinds.map((kind) => {
        if (kind === "remote:openai-curated") return "openai-curated";
        return restorePluginMarketplaceName(kind);
      });
      next = { ...next, marketplaceKinds: Array.from(new Set(nextKinds)) };
    }
    if (method === "install-plugin") {
      next = next === params ? { ...params } : { ...next };
      if (next.remoteMarketplaceName) next.remoteMarketplaceName = restorePluginMarketplaceName(next.remoteMarketplaceName);
      if (typeof next.marketplacePath === "string" && next.marketplacePath.startsWith("remote:")) {
        const remoteMarketplaceName = next.marketplacePath.slice("remote:".length);
        delete next.marketplacePath;
        next.remoteMarketplaceName = restorePluginMarketplaceName(remoteMarketplaceName);
      }
    }
    return next;
  }

  function patchPluginMarketplaceResult(method, result, options = {}) {
    if (method !== "list-plugins") return result;
    const mergeLocal = options.mergeLocal !== false;
    let patchedCount = 0;
    try {
      const pluginMarketplaceCounts = {};
      if (Array.isArray(result?.marketplaces)) {
        if (mergeLocal) mergeLocalPluginMarketplaces(result);
        result.marketplaces.forEach((marketplace) => {
          if (Array.isArray(marketplace?.plugins)) {
            marketplace.plugins.forEach((plugin) => {
              const name = plugin?.marketplaceName || marketplace?.name || "";
              if (name) pluginMarketplaceCounts[name] = (pluginMarketplaceCounts[name] || 0) + 1;
            });
          }
          if (patchPluginMarketplaceObject(marketplace)) patchedCount += 1;
        });
        sendCodexPlusDiagnostic("plugin_marketplace_response_debug", {
          marketplaces: result.marketplaces.map((marketplace) => ({
            name: marketplace?.name || "",
            path: marketplace?.path || null,
            displayName: marketplace?.displayName || marketplace?.interface?.displayName || null,
            pluginCount: Array.isArray(marketplace?.plugins) ? marketplace.plugins.length : null,
            remoteMarketplaceName: marketplace?.remoteMarketplaceName || null,
          })),
          pluginMarketplaceCounts,
          mergeLocal,
        });
      }
      if (patchedCount > 0) {
        sendCodexPlusDiagnostic("plugin_marketplace_response_expanded", { patchedCount });
      }
    } catch (error) {
      sendCodexPlusDiagnostic("plugin_marketplace_response_patch_failed", {
        errorName: error?.name || "",
        errorMessage: error?.message || String(error),
      });
    }
    return result;
  }

  function pluginMarketplaceErrorText(value, visited = new WeakSet(), depth = 0) {
    if (typeof value === "string") return value;
    if (!value || typeof value !== "object" || depth > 4 || visited.has(value)) return "";
    visited.add(value);
    const parts = [];
    for (const key of ["message", "error", "detail", "cause", "data", "response"]) {
      const text = pluginMarketplaceErrorText(value[key], visited, depth + 1);
      if (text) parts.push(text);
    }
    return parts.join(" ");
  }

  function pluginMarketplaceRemoteAuthError(value) {
    const text = pluginMarketplaceErrorText(value).toLowerCase();
    return text.includes("chatgpt authentication required for remote plugin catalog") && text.includes("api key auth is not supported");
  }

  function markPluginMarketplaceRemoteCatalogUnavailable(error) {
    window.__codexPluginMarketplaceRemoteCatalogUnavailable = true;
    sendCodexPlusDiagnostic("plugin_marketplace_remote_auth_fallback", {
      errorMessage: pluginMarketplaceErrorText(error),
      rememberedCwdCount: Array.isArray(window.__codexPluginMarketplaceLastCwds)
        ? window.__codexPluginMarketplaceLastCwds.length
        : 0,
    });
  }

  function pluginMarketplaceFallbackResult(mergeLocal = true) {
    return patchPluginMarketplaceResult("list-plugins", {
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    }, { mergeLocal });
  }

  function localPluginMarketplaceFallbackResult() {
    return pluginMarketplaceFallbackResult(true);
  }

  function remoteOnlyPluginMarketplaceFallbackResult() {
    return pluginMarketplaceFallbackResult(false);
  }

  function patchPluginMarketplaceRequestClient(client) {
    if (!client || typeof client.sendRequest !== "function") return false;
    if (client.__codexPluginMarketplaceUnlockPatch === codexPluginMarketplaceUnlockVersion) return true;
    if (!client.__codexPluginMarketplaceRawSendRequest) {
      // 原始方法本身留给还原用；绑定副本只给包装器调用。
      client.__codexPluginMarketplaceRawSendRequest = client.sendRequest;
    }
    const originalSendRequest = client.__codexPluginMarketplaceOriginalSendRequest || client.sendRequest.bind(client);
    client.__codexPluginMarketplaceOriginalSendRequest = originalSendRequest;
    client.sendRequest = async function codexPluginMarketplacePatchedSendRequest(method, params, options) {
      const requestMethod = appServerModelRequestMethod(String(method || ""), params);
      const restoredRequestParams = restorePluginMarketplaceRequestParams(params, requestMethod);
      const requestProfile = pluginMarketplaceRequestProfile(restoredRequestParams);
      const requestParams = patchPluginMarketplaceRequestParams(requestMethod, restoredRequestParams);
      if (requestMethod === "install-plugin") {
        sendCodexPlusDiagnostic("plugin_install_request_debug", {
          method: String(method || ""),
          requestMethod,
          originalMarketplacePath: params?.marketplacePath || null,
          originalRemoteMarketplaceName: params?.remoteMarketplaceName || null,
          originalPluginName: params?.pluginName || null,
          requestMarketplacePath: requestParams?.marketplacePath || null,
          requestRemoteMarketplaceName: requestParams?.remoteMarketplaceName || null,
          requestPluginName: requestParams?.pluginName || null,
        });
      }
      try {
        const result = await originalSendRequest(method, requestParams, options);
        return patchPluginMarketplaceResult(requestMethod, result, { mergeLocal: !requestProfile.remoteOnly });
      } catch (error) {
        if (requestMethod === "list-plugins" && pluginMarketplaceRemoteAuthError(error)) {
          markPluginMarketplaceRemoteCatalogUnavailable(error);
          return requestProfile.remoteOnly
            ? remoteOnlyPluginMarketplaceFallbackResult()
            : localPluginMarketplaceFallbackResult();
        }
        if (requestMethod === "install-plugin") {
          sendCodexPlusDiagnostic("plugin_install_request_failed", {
            method: String(method || ""),
            requestMethod,
            requestMarketplacePath: requestParams?.marketplacePath || null,
            requestRemoteMarketplaceName: requestParams?.remoteMarketplaceName || null,
            requestPluginName: requestParams?.pluginName || null,
            errorName: error?.name || "",
            errorMessage: error?.message || String(error),
          });
        }
        throw error;
      }
    };
    client.__codexPluginMarketplaceUnlockPatch = codexPluginMarketplaceUnlockVersion;
    return true;
  }

  function patchPluginMarketplaceRequestMessage(message) {
    if (!message || typeof message !== "object") return message;
    if (message.type === "fetch" && typeof message.url === "string") {
      const requestMethod = appServerModelRequestMethod(message.url, message.body);
      if (requestMethod !== "list-plugins" && requestMethod !== "install-plugin") return message;
      let requestBody = message.body;
      let params = null;
      if (typeof requestBody === "string" && requestBody.trim()) {
        try {
          params = JSON.parse(requestBody);
        } catch {
          params = null;
        }
      } else if (requestBody && typeof requestBody === "object") {
        params = requestBody;
      }
      const restoredRequestParams = restorePluginMarketplaceRequestParams(params, requestMethod);
      const requestProfile = pluginMarketplaceRequestProfile(restoredRequestParams);
      const requestParams = patchPluginMarketplaceRequestParams(requestMethod, restoredRequestParams);
      if (requestMethod === "list-plugins" && message.requestId != null) {
        window.__codexPluginMarketplaceFetchRequestIds = window.__codexPluginMarketplaceFetchRequestIds || new Set();
        const requestId = String(message.requestId);
        window.__codexPluginMarketplaceFetchRequestIds.add(requestId);
        window.__codexPluginMarketplaceFetchRequestProfiles = window.__codexPluginMarketplaceFetchRequestProfiles || new Map();
        window.__codexPluginMarketplaceFetchRequestProfiles.set(requestId, requestProfile);
      }
      if (requestParams === params) return message;
      if (requestMethod === "install-plugin") {
        sendCodexPlusDiagnostic("plugin_install_request_debug", {
          method: message.url,
          requestMethod,
          originalMarketplacePath: params?.marketplacePath || null,
          originalRemoteMarketplaceName: params?.remoteMarketplaceName || null,
          originalPluginName: params?.pluginName || null,
          requestMarketplacePath: requestParams?.marketplacePath || null,
          requestRemoteMarketplaceName: requestParams?.remoteMarketplaceName || null,
          requestPluginName: requestParams?.pluginName || null,
        });
      }
      return {
        ...message,
        body: typeof requestBody === "string" ? JSON.stringify(requestParams) : requestParams,
      };
    }
    if (message.type === "mcp-request" && message.request && typeof message.request === "object") {
      const requestMethod = appServerModelRequestMethod(String(message.request.method || ""), message.request.params);
      if (requestMethod !== "list-plugins" && requestMethod !== "install-plugin") return message;
      const restoredRequestParams = restorePluginMarketplaceRequestParams(message.request.params, requestMethod);
      const requestProfile = pluginMarketplaceRequestProfile(restoredRequestParams);
      const requestParams = patchPluginMarketplaceRequestParams(requestMethod, restoredRequestParams);
      if (requestMethod === "list-plugins" && message.request.id != null) {
        window.__codexPluginMarketplaceRequestIds = window.__codexPluginMarketplaceRequestIds || new Set();
        const requestId = String(message.request.id);
        window.__codexPluginMarketplaceRequestIds.add(requestId);
        window.__codexPluginMarketplaceRequestProfiles = window.__codexPluginMarketplaceRequestProfiles || new Map();
        window.__codexPluginMarketplaceRequestProfiles.set(requestId, requestProfile);
      }
      if (requestParams === message.request.params) return message;
      if (requestMethod === "install-plugin") {
        sendCodexPlusDiagnostic("plugin_install_request_debug", {
          method: String(message.request.method || ""),
          requestMethod,
          originalMarketplacePath: message.request.params?.marketplacePath || null,
          originalRemoteMarketplaceName: message.request.params?.remoteMarketplaceName || null,
          originalPluginName: message.request.params?.pluginName || null,
          requestMarketplacePath: requestParams?.marketplacePath || null,
          requestRemoteMarketplaceName: requestParams?.remoteMarketplaceName || null,
          requestPluginName: requestParams?.pluginName || null,
        });
      }
      return { ...message, request: { ...message.request, params: requestParams } };
    }
    return message;
  }

  function patchPluginMarketplaceResponseData(data) {
    if (data?.type === "fetch-response") {
      const requestId = data.requestId != null ? String(data.requestId) : "";
      const requestIds = window.__codexPluginMarketplaceFetchRequestIds;
      const requestProfiles = window.__codexPluginMarketplaceFetchRequestProfiles;
      const requestProfile = requestProfiles instanceof Map ? requestProfiles.get(requestId) : null;
      if (requestIds instanceof Set && requestIds.size > 0) {
        if (!requestIds.has(requestId)) return false;
        requestIds.delete(requestId);
      }
      if (requestProfiles instanceof Map) requestProfiles.delete(requestId);
      if (typeof data.bodyJsonString !== "string" || !data.bodyJsonString.trim()) return false;
      try {
        let result = JSON.parse(data.bodyJsonString);
        if (pluginMarketplaceRemoteAuthError(result?.error || result)) {
          markPluginMarketplaceRemoteCatalogUnavailable(result?.error || result);
          const fallback = requestProfile?.remoteOnly
            ? remoteOnlyPluginMarketplaceFallbackResult()
            : localPluginMarketplaceFallbackResult();
          if (result && typeof result === "object" && Object.prototype.hasOwnProperty.call(result, "id")) {
            delete result.error;
            result.result = fallback;
          } else {
            result = fallback;
          }
        } else if (result && typeof result === "object") {
          const patchOptions = { mergeLocal: requestProfile?.remoteOnly !== true };
          patchPluginMarketplaceResult("list-plugins", result, patchOptions);
          patchPluginMarketplaceResult("list-plugins", result.data, patchOptions);
        }
        data.bodyJsonString = JSON.stringify(result);
        return true;
      } catch (error) {
        sendCodexPlusDiagnostic("plugin_marketplace_fetch_response_patch_failed", {
          errorName: error?.name || "",
          errorMessage: error?.message || String(error),
        });
      }
      return false;
    }
    if (data?.type !== "mcp-response") return false;
    const message = data.message || data.response;
    const method = String(message?.method || data.method || "");
    if (appServerModelRequestMethod(method) === "install-plugin") {
      clearPluginMarketplaceQueryCache();
    }
    const requestId = message?.id != null ? String(message.id) : "";
    const requestIds = window.__codexPluginMarketplaceRequestIds;
    const requestProfiles = window.__codexPluginMarketplaceRequestProfiles;
    const requestProfile = requestProfiles instanceof Map ? requestProfiles.get(requestId) : null;
    if (requestIds instanceof Set && requestIds.size > 0) {
      if (!requestIds.has(requestId)) return false;
      requestIds.delete(requestId);
    }
    if (requestProfiles instanceof Map) requestProfiles.delete(requestId);
    if (pluginMarketplaceRemoteAuthError(message?.error)) {
      markPluginMarketplaceRemoteCatalogUnavailable(message.error);
      delete message.error;
      message.result = requestProfile?.remoteOnly
        ? remoteOnlyPluginMarketplaceFallbackResult()
        : localPluginMarketplaceFallbackResult();
      return true;
    }
    const result = message?.result;
    if (!result || typeof result !== "object") return false;
    const patchOptions = { mergeLocal: requestProfile?.remoteOnly !== true };
    patchPluginMarketplaceResult("list-plugins", result, patchOptions);
    patchPluginMarketplaceResult("list-plugins", result.data, patchOptions);
    return true;
  }

  if (window.__CODEX_PLUS_TEST_PLUGIN_MARKETPLACE__) {
    window.__codexPlusPluginMarketplaceTest = {
      patchRequestParams: patchPluginMarketplaceRequestParams,
      patchRequestMessage: patchPluginMarketplaceRequestMessage,
      patchResponseData: patchPluginMarketplaceResponseData,
      remoteAuthError: pluginMarketplaceRemoteAuthError,
      localFallback: localPluginMarketplaceFallbackResult,
      remoteOnlyFallback: remoteOnlyPluginMarketplaceFallbackResult,
      requestProfile: pluginMarketplaceRequestProfile,
      isBuildFlavorFilter: isCodexPluginBuildFlavorFilter,
      isHiddenMarketplaceFilter: isCodexPluginMarketplaceHiddenFilter,
      setCodexAppVersion: (version) => {
        codexPlusBackendSettings.codexAppVersion = String(version || "");
      },
      remoteCatalogUnavailable: () => window.__codexPluginMarketplaceRemoteCatalogUnavailable === true,
      reset: () => {
        delete window.__codexPluginMarketplaceLastCwds;
        delete window.__codexPluginMarketplaceRemoteCatalogUnavailable;
        window.__codexPluginMarketplaceRequestIds = new Set();
        window.__codexPluginMarketplaceFetchRequestIds = new Set();
        window.__codexPluginMarketplaceRequestProfiles = new Map();
        window.__codexPluginMarketplaceFetchRequestProfiles = new Map();
      },
    };
    return;
  }

  function clearPluginMarketplaceQueryCache() {
    try {
      const queryClient = window.__REACT_QUERY_CLIENT__ || window.__codexQueryClient;
      if (queryClient && typeof queryClient.invalidateQueries === "function") {
        queryClient.invalidateQueries({ queryKey: ["plugins"] });
      }
    } catch {
    }
  }

  function installPluginMarketplaceBridgePatch() {
    if (window.__codexPluginMarketplaceBridgePatch === codexPluginMarketplaceUnlockVersion) return;
    if (pluginPatchDisabledInRelayMode()) return;
    if (!codexPlusSettings().pluginMarketplaceUnlock) return;
    installPluginMarketplaceWindowEventPatchOnly();
    const bridge = window.electronBridge;
    if (!bridge || typeof bridge.sendMessageFromView !== "function") {
      sendCodexPlusDiagnostic("plugin_marketplace_bridge_patch_not_found", {});
      return;
    }
    if (!bridge.__codexPluginMarketplaceOriginalSendMessageFromView) {
      const originalSendMessageFromView = bridge.sendMessageFromView;
      // 原始方法本身留给还原用；绑定副本只给包装器调用。
      bridge.__codexPluginMarketplaceRawSendMessageFromView = originalSendMessageFromView;
      bridge.__codexPluginMarketplaceOriginalSendMessageFromView = originalSendMessageFromView.bind(bridge);
      bridge.sendMessageFromView = function codexPluginMarketplacePatchedSendMessageFromView(message) {
        let nextMessage = message;
        try {
          nextMessage = patchPluginMarketplaceRequestMessage(message);
        } catch (error) {
          sendCodexPlusDiagnostic("plugin_marketplace_bridge_request_patch_failed", {
            errorName: error?.name || "",
            errorMessage: error?.message || String(error),
          });
        }
        return bridge.__codexPluginMarketplaceOriginalSendMessageFromView(nextMessage);
      };
    }
    bridge.__codexPluginMarketplaceBridgePatch = codexPluginMarketplaceUnlockVersion;
    window.__codexPluginMarketplaceBridgePatch = codexPluginMarketplaceUnlockVersion;
    sendCodexPlusDiagnostic("plugin_marketplace_bridge_patch_installed", {});
  }

  function installPluginMarketplaceWindowEventPatchOnly() {
    if (window.__codexPluginMarketplaceWindowEventPatch === codexPluginMarketplaceUnlockVersion) return;
    if (pluginPatchDisabledInRelayMode()) return;
    if (!codexPlusSettings().pluginMarketplaceUnlock) return;
    const originalDispatchEvent = window.__codexPluginMarketplaceOriginalDispatchEvent || window.dispatchEvent;
    if (!window.__codexPluginMarketplaceOriginalDispatchEvent) {
      window.__codexPluginMarketplaceOriginalDispatchEvent = originalDispatchEvent;
      window.dispatchEvent = function patchedCodexPluginMarketplaceDispatchEvent(event) {
        try {
          const detail = event?.detail;
          if (event?.type === "codex-message-from-view" && detail?.type === "mcp-request") {
            const patched = patchPluginMarketplaceRequestMessage(detail);
            if (patched !== detail) {
              Object.keys(detail).forEach((key) => delete detail[key]);
              Object.assign(detail, patched);
            }
          }
          if (event?.type === "message") patchPluginMarketplaceResponseData(event.data);
        } catch (error) {
          sendCodexPlusDiagnostic("plugin_marketplace_dispatch_event_patch_failed", {
            errorName: error?.name || "",
            errorMessage: error?.message || String(error),
          });
        }
        return originalDispatchEvent.call(this, event);
      };
    }
    if (!window.__codexPluginMarketplaceResponseListenerInstalled) {
      window.__codexPluginMarketplaceResponseListenerInstalled = true;
      // 保留引用：切到 relay 模式或关闭插件市场解锁后必须能把这个监听摘掉。
      window.__codexPluginMarketplaceResponseListener = (event) => {
        try {
          patchPluginMarketplaceResponseData(event?.data);
        } catch (error) {
          sendCodexPlusDiagnostic("plugin_marketplace_response_message_patch_failed", {
            errorName: error?.name || "",
            errorMessage: error?.message || String(error),
          });
        }
      };
      window.addEventListener("message", window.__codexPluginMarketplaceResponseListener, true);
    }
    window.__codexPluginMarketplaceWindowEventPatch = codexPluginMarketplaceUnlockVersion;
  }

  const pluginMarketplaceRequestPatchMaxMisses = 8;
  let pluginMarketplaceRequestPatchMissCount = 0;
  let pluginMarketplaceRequestPatchDisabled = false;
  let pluginMarketplaceRequestPatchPromise = null;

  function notePluginMarketplaceRequestPatchMiss(event, detail) {
    pluginMarketplaceRequestPatchMissCount += 1;
    // 和 installAppServerModelRequestPatch 里那段(issue #1324)是同一类问题,当时只修了 model 那一层。
    // 这个补丁在 scanDeferred() 里每轮都会跑,而早退守卫 __codexPluginMarketplaceUnlockInstalled
    // 只在 patchedCount > 0 时才写入。Codex 侧改名/移除对应 asset 后这层永远成功不了,
    // 守卫就永远不设,于是每轮 scan 都重新把全部 app asset fetch 一遍再跑正则匹配,
    // 而且没有 in-flight 去重,尝试之间还会并发堆叠。
    // 实测空闲状态下 530 次 fetch/秒(单个 asset 最高 265 次/秒),渲染进程 CPU 40%~60% 且持续爬升(issue #1960)。
    // 首次 miss 仍然上报,保证 telemetry 能定位原因,之后噤声;连续失败够多次就停掉这一层。
    // 这是优雅降级:插件市场解锁还有 bridge / window-event 两层补丁各自独立工作。
    if (pluginMarketplaceRequestPatchMissCount === 1) {
      sendCodexPlusDiagnostic(event, detail);
    }
    if (
      pluginMarketplaceRequestPatchMissCount >= pluginMarketplaceRequestPatchMaxMisses
      && !pluginMarketplaceRequestPatchDisabled
    ) {
      pluginMarketplaceRequestPatchDisabled = true;
      sendCodexPlusDiagnostic("plugin_marketplace_request_patch_skipped", {
        misses: pluginMarketplaceRequestPatchMissCount,
        lastEvent: event,
      });
    }
  }

  function installPluginMarketplaceRequestPatch() {
    if (window.__codexPluginMarketplaceUnlockInstalled === codexPluginMarketplaceUnlockVersion) return;
    if (pluginPatchDisabledInRelayMode()) return;
    if (!codexPlusSettings().pluginMarketplaceUnlock) return;
    if (pluginMarketplaceRequestPatchDisabled) return;
    // 上一轮还没跑完就不要再起一轮:loadAppServerRequestCandidates() 会把所有 app asset 拉一遍,
    // 没有这道去重时 scan 的频率直接变成并发 fetch 的频率。
    if (pluginMarketplaceRequestPatchPromise) return;
    const patch = async () => {
      try {
        const { modules, candidates, sources, discovery } = await loadAppServerRequestCandidates();
        let patchedCount = 0;
        for (const candidate of candidates) {
          if (patchPluginMarketplaceRequestClient(candidate)) {
            patchedCount += 1;
            // 记下改过的客户端，还原时不必再把全部 app asset 拉一遍。
            if (!window.__codexPluginMarketplacePatchedClients) {
              window.__codexPluginMarketplacePatchedClients = [];
            }
            window.__codexPluginMarketplacePatchedClients.push(candidate);
          }
        }
        if (patchedCount > 0) {
          window.__codexPluginMarketplaceUnlockInstalled = codexPluginMarketplaceUnlockVersion;
          pluginMarketplaceRequestPatchMissCount = 0;
          sendCodexPlusDiagnostic("plugin_marketplace_request_patch_installed", {
            moduleCount: modules.length,
            candidateCount: candidates.length,
            patchedCount,
            sources,
            discovery,
          });
        } else {
          notePluginMarketplaceRequestPatchMiss("plugin_marketplace_request_patch_not_found", {
            moduleCount: modules.length,
            candidateCount: candidates.length,
            sources,
            discovery,
          });
        }
      } catch (error) {
        notePluginMarketplaceRequestPatchMiss("plugin_marketplace_request_patch_failed", {
          errorName: error?.name || "",
          errorMessage: error?.message || String(error),
        });
      } finally {
        pluginMarketplaceRequestPatchPromise = null;
      }
    };
    pluginMarketplaceRequestPatchPromise = patch();
  }

  function pluginPatchDisabledInRelayMode() {
    return !codexPlusBackendSettingsLoaded || codexPlusBackendSettings.launchMode === "relay";
  }

  // 补丁还原。以前这里是个空函数，于是「切到 relay 模式 / 关掉插件市场解锁」之后
  // Array.prototype.filter、window.dispatchEvent、electronBridge.sendMessageFromView
  // 以及被改写的 RPC sendRequest 会一直保持被替换的状态：用户以为已经停用，实际仍在生效。
  // 每个还原函数返回是否真的撤掉了东西，只有撤掉了才上报诊断，避免每轮 scan 都刷日志。
  function restorePluginBuildFlavorFilterPatch() {
    let restored = false;
    try {
      const original = Array.prototype.__codexPluginBuildFlavorOriginalFilter;
      // 只撤我们自己装的那一层：filter 上带标记才说明当前生效的是本补丁。
      if (typeof original === "function" && Array.prototype.filter?.__codexPluginBuildFlavorPatched) {
        Array.prototype.filter = original;
        restored = true;
      }
      delete Array.prototype.__codexPluginBuildFlavorOriginalFilter;
      delete window.__codexPluginBuildFlavorFilterPatch;
    } catch {
    }
    return restored;
  }

  function restorePluginMarketplaceWindowEventPatch() {
    let restored = false;
    try {
      const original = window.__codexPluginMarketplaceOriginalDispatchEvent;
      if (typeof original === "function" && window.dispatchEvent !== original) {
        window.dispatchEvent = original;
        restored = true;
      }
      const listener = window.__codexPluginMarketplaceResponseListener;
      if (typeof listener === "function") {
        window.removeEventListener("message", listener, true);
        restored = true;
      }
      delete window.__codexPluginMarketplaceOriginalDispatchEvent;
      delete window.__codexPluginMarketplaceResponseListener;
      delete window.__codexPluginMarketplaceResponseListenerInstalled;
      delete window.__codexPluginMarketplaceWindowEventPatch;
    } catch {
    }
    return restored;
  }

  function restorePluginMarketplaceBridgePatch() {
    let restored = false;
    try {
      const bridge = window.electronBridge;
      if (bridge) {
        // 优先还原未经绑定的原方法，做到与打补丁前完全一致。
        const original = bridge.__codexPluginMarketplaceRawSendMessageFromView
          || bridge.__codexPluginMarketplaceOriginalSendMessageFromView;
        if (typeof original === "function" && bridge.sendMessageFromView !== original) {
          bridge.sendMessageFromView = original;
          restored = true;
        }
        delete bridge.__codexPluginMarketplaceRawSendMessageFromView;
        delete bridge.__codexPluginMarketplaceOriginalSendMessageFromView;
        delete bridge.__codexPluginMarketplaceBridgePatch;
      }
      delete window.__codexPluginMarketplaceBridgePatch;
    } catch {
    }
    return restored;
  }

  function restorePluginMarketplaceRequestPatch() {
    let restored = false;
    try {
      const clients = window.__codexPluginMarketplacePatchedClients;
      if (Array.isArray(clients)) {
        for (const client of clients) {
          try {
            // 优先还原未经绑定的原方法，做到与打补丁前完全一致。
            const original = client?.__codexPluginMarketplaceRawSendRequest
              || client?.__codexPluginMarketplaceOriginalSendRequest;
            if (typeof original === "function" && client.sendRequest !== original) {
              client.sendRequest = original;
              restored = true;
            }
            delete client.__codexPluginMarketplaceRawSendRequest;
            delete client.__codexPluginMarketplaceOriginalSendRequest;
          } catch {
          }
        }
      }
      delete window.__codexPluginMarketplacePatchedClients;
      delete window.__codexPluginMarketplaceUnlockInstalled;
    } catch {
    }
    // 放宽放弃状态，让「切回来」时最多再试满一轮 miss 上限，而不是永久失效。
    pluginMarketplaceRequestPatchMissCount = 0;
    pluginMarketplaceRequestPatchDisabled = false;
    pluginMarketplaceRequestPatchPromise = null;
    return restored;
  }

  function clearPluginPatchArtifacts() {
    const restored = [
      restorePluginBuildFlavorFilterPatch(),
      restorePluginMarketplaceWindowEventPatch(),
      restorePluginMarketplaceBridgePatch(),
      restorePluginMarketplaceRequestPatch(),
    ].some(Boolean);
    if (restored) {
      sendCodexPlusDiagnostic("plugin_marketplace_patches_cleared", {});
    }
  }
