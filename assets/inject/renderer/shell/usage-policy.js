  function officialUsagePolicy() {
    const profile = codexRemoteSessionActiveProfile();
    const official = String(profile?.relayMode || "") === "official";
    return {
      official,
      hideAlerts: official && window.__CODEX_PLUS_HIDE_OFFICIAL_USAGE_ALERT__ === true,
    };
  }
  function officialUsagePolicyKey(policy = officialUsagePolicy()) {
    if (!policy.official) return "off";
    return policy.hideAlerts ? "official-hide" : "official";
  }

  function isOfficialUsageStatus(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const rateLimit = value.rate_limit;
    if (!rateLimit || typeof rateLimit !== "object" || typeof rateLimit.allowed !== "boolean") return false;
    return typeof value.plan_type === "string"
      || typeof value.user_id === "string"
      || typeof value.account_id === "string";
  }

  function isImageGenerationUpsell(value) {
    return String(value?.banner_type || "") === "image_generation_limit_reached";
  }

  function isMainRateLimitQueryKey(queryKey) {
    return Array.isArray(queryKey)
      && queryKey[0] === "rate-limit-status"
      && queryKey[1] !== "image-generation";
  }

  // 低额度卡片、输入框横幅和发送锁都读 /wham/usage 这份状态。
  // 官登模式一律放开功能锁；提示字段只在勾选「关闭官方低额度提示」时清掉。
  // 百分比、重置时间、账号、积分和消费上限不动。图片额度横幅单独留下。
  function rewriteOfficialUsageStatus(value, policy = officialUsagePolicy()) {
    if (!policy.official || !isOfficialUsageStatus(value)) return null;
    const next = { ...value };
    let changed = false;
    if (value.rate_limit_reached_type != null) {
      next.rate_limit_reached_type = null;
      changed = true;
    }
    if (value.model_picker_upsell != null) {
      next.model_picker_upsell = null;
      changed = true;
    }
    const rateLimit = value.rate_limit;
    if (rateLimit.allowed !== true || rateLimit.limit_reached === true) {
      next.rate_limit = {
        ...rateLimit,
        allowed: true,
        limit_reached: false,
      };
      changed = true;
    }
    if (policy.hideAlerts) {
      if (value.sidebar_usage_warnings != null) {
        next.sidebar_usage_warnings = null;
        changed = true;
      }
      if (value.rate_limit_warning != null) {
        next.rate_limit_warning = null;
        changed = true;
      }
      if (value.rate_limit_upsell != null && !isImageGenerationUpsell(value.rate_limit_upsell)) {
        next.rate_limit_upsell = null;
        changed = true;
      }
    }
    return changed ? next : null;
  }

  function rewriteOfficialUsagePayload(value, policy = officialUsagePolicy()) {
    if (!value || typeof value !== "object") return value;
    if (isOfficialUsageStatus(value)) return rewriteOfficialUsageStatus(value, policy) || value;
    if (value.usage && value.usage !== value && isOfficialUsageStatus(value.usage)) {
      const usage = rewriteOfficialUsageStatus(value.usage, policy);
      return usage ? { ...value, usage } : value;
    }
    return value;
  }

  function looksLikeQueryClient(value) {
    return !!value
      && typeof value.getQueryCache === "function"
      && typeof value.setQueryData === "function";
  }

  // 图片额度使用同一条 /wham/usage，只能靠查询键 image-generation 排除。
  // 这里只在第一次挂上缓存时找客户端，不进每轮 DOM 扫描。
  function queryClientFromFiber(fiber) {
    const seen = new Set();
    const stack = [fiber];
    let visited = 0;
    while (stack.length && visited < 8000) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      visited += 1;
      const props = node.memoizedProps || node.pendingProps;
      if (looksLikeQueryClient(props?.client)) return props.client;
      if (looksLikeQueryClient(props?.value)) return props.value;
      if (looksLikeQueryClient(node.stateNode)) return node.stateNode;
      const state = node.memoizedState;
      if (state && typeof state === "object" && looksLikeQueryClient(state.memoizedState)) return state.memoizedState;
      if (node.child) stack.push(node.child);
      if (node.sibling) stack.push(node.sibling);
    }
    return null;
  }

  let officialUsageClient = null;

  function findCodexQueryClient() {
    const explicit = window.__REACT_QUERY_CLIENT__ || window.__codexQueryClient;
    if (looksLikeQueryClient(explicit)) return explicit;
    if (looksLikeQueryClient(officialUsageClient)) return officialUsageClient;
    const roots = [document.getElementById?.("root"), document.body, document.documentElement].filter(Boolean);
    for (const root of roots) {
      let key = "";
      try {
        key = Object.keys(root).find((name) => name.startsWith("__reactContainer$") || name.startsWith("__reactFiber$")) || "";
      } catch {
        key = "";
      }
      if (!key) continue;
      let fiber = root[key];
      if (fiber?.stateNode?.current) fiber = fiber.stateNode.current;
      const client = queryClientFromFiber(fiber);
      if (client) {
        officialUsageClient = client;
        return client;
      }
    }
    return null;
  }

  function mainRateLimitQueries(client) {
    const cache = client.getQueryCache?.();
    if (cache && typeof cache.findAll === "function") {
      return cache.findAll({ queryKey: ["rate-limit-status"] }).filter((query) => isMainRateLimitQueryKey(query?.queryKey));
    }
    if (typeof client.getQueriesData === "function") {
      return client.getQueriesData({ queryKey: ["rate-limit-status"] })
        .filter(([queryKey]) => isMainRateLimitQueryKey(queryKey))
        .map(([queryKey, data]) => ({ queryKey, state: { data } }));
    }
    return [];
  }

  let officialUsageRewriteDepth = 0;

  function patchOfficialUsageQueryClient(client) {
    if (!client || client.__codexPlusUsageRewrite || typeof client.setQueryData !== "function") return;
    const original = client.setQueryData;
    client.setQueryData = function codexPlusSetUsageQueryData(queryKey, updater, ...rest) {
      if (officialUsageRewriteDepth > 0 || !isMainRateLimitQueryKey(queryKey) || !officialUsagePolicy().official) {
        return original.call(this, queryKey, updater, ...rest);
      }
      const nextUpdater = typeof updater === "function"
        ? (previous) => rewriteOfficialUsagePayload(updater(previous))
        : rewriteOfficialUsagePayload(updater);
      officialUsageRewriteDepth += 1;
      try {
        return original.call(this, queryKey, nextUpdater, ...rest);
      } finally {
        officialUsageRewriteDepth -= 1;
      }
    };
    const cache = client.getQueryCache?.();
    if (cache && typeof cache.subscribe === "function") {
      cache.subscribe((event) => {
        if (officialUsageRewriteDepth > 0 || !officialUsagePolicy().official) return;
        const query = event?.query;
        if (!isMainRateLimitQueryKey(query?.queryKey)) return;
        const current = query.state?.data;
        const next = rewriteOfficialUsagePayload(current);
        if (next === current) return;
        client.setQueryData(query.queryKey, next);
      });
    }
    client.__codexPlusUsageRewrite = true;
  }

  function rewriteCachedOfficialUsage(client) {
    if (!client || !officialUsagePolicy().official) return;
    for (const query of mainRateLimitQueries(client)) {
      const current = query.state?.data;
      const next = rewriteOfficialUsagePayload(current);
      if (next !== current) client.setQueryData(query.queryKey, next);
    }
  }

  function invalidateMainRateLimitQueries(client) {
    if (!client || typeof client.invalidateQueries !== "function") return;
    for (const query of mainRateLimitQueries(client)) {
      try {
        client.invalidateQueries({ queryKey: query.queryKey });
      } catch {
      }
    }
  }

  let officialUsagePolicyApplied = "";
  let officialUsageClientTimer = null;

  function syncOfficialUsagePolicy() {
    const key = officialUsagePolicyKey();
    const client = findCodexQueryClient();
    if (client) {
      officialUsageClient = client;
      patchOfficialUsageQueryClient(client);
      if (officialUsageClientTimer) {
        clearTimeout(officialUsageClientTimer);
        officialUsageClientTimer = null;
      }
    } else if (!officialUsageClientTimer) {
      let attempts = 0;
      const retry = () => {
        attempts += 1;
        officialUsageClientTimer = null;
        if (findCodexQueryClient()) {
          syncOfficialUsagePolicy();
          return;
        }
        if (attempts < 20) officialUsageClientTimer = setTimeout(retry, 300);
      };
      officialUsageClientTimer = setTimeout(retry, 300);
      return;
    } else {
      return;
    }
    if (key === officialUsagePolicyApplied) {
      if (key !== "off") rewriteCachedOfficialUsage(client);
      return;
    }
    const previous = officialUsagePolicyApplied;
    officialUsagePolicyApplied = key;
    if (key === "off") {
      if (previous) invalidateMainRateLimitQueries(client);
      return;
    }
    rewriteCachedOfficialUsage(client);
    if (previous) invalidateMainRateLimitQueries(client);
  }

  if (window.__CODEX_PLUS_TEST_RATE_LIMIT_UNLOCK__) {
    window.__codexPlusRateLimitUnlockTest = {
      setBackendSettings: (settings) => {
        codexPlusBackendSettings = { ...codexPlusBackendSettings, ...settings };
        codexPlusBackendSettingsLoaded = true;
      },
      setHideAlerts: (hidden) => {
        window.__CODEX_PLUS_HIDE_OFFICIAL_USAGE_ALERT__ = hidden === true;
      },
      install: () => syncOfficialUsagePolicy(),
      policyKey: () => officialUsagePolicyKey(),
      isRateLimitQueryKey: (queryKey) => isMainRateLimitQueryKey(queryKey),
      rewrite: (value) => rewriteOfficialUsagePayload(value),
    };
  }
