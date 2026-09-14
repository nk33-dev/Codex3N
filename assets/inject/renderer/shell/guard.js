  // The launcher targets the Codex app page, but keep a renderer-side guard
  // so this bundle cannot create UI in embedded browser documents.
  const codexPlusIsNodeTestHarness = typeof process === "object" && !!process.versions?.node;
  if (!codexPlusIsNodeTestHarness && (window.top !== window || window.self !== window || !window.electronBridge || !/^app:\/\/\-\//i.test(window.location.href))) return;
  const codexPlusIsWindowsPlatform = /\bWindows\b/i.test(navigator.userAgent || "");

  function installCodexPlusFastStartup() {
    const config = window.__CODEX_PLUS_FAST_STARTUP__;
    if (!config || config.enabled !== true) return;
    if (window.__codexPlusFastStartupInstalled === "1") return;
    window.__codexPlusFastStartupInstalled = "1";
    const timeoutMs = Math.max(100, Math.min(Number(config.statsigTimeoutMs) || 800, 3000));
    const statsigHosts = new Set([
      "ab.chatgpt.com",
      "featureassets.org",
      "prodregistryv2.org",
      "api.statsigcdn.com",
      "statsigapi.net",
      "cloudflare-dns.com",
    ]);

    const isStatsigUrl = (input) => {
      try {
        const url = new URL(typeof input === "string" ? input : input?.url ?? "", window.location.href);
        return statsigHosts.has(url.hostname);
      } catch {
        return false;
      }
    };

    const timeoutSignal = (signal) => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      const clear = () => window.clearTimeout(timer);
      if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
      return { signal: controller.signal, clear };
    };

    const patchFetch = () => {
      if (typeof window.fetch !== "function" || window.fetch.__codexPlusFastStartupPatched) return;
      const originalFetch = window.fetch.bind(window);
      const patchedFetch = (input, init = undefined) => {
        if (!isStatsigUrl(input)) return originalFetch(input, init);
        const { signal, clear } = timeoutSignal(init?.signal);
        const nextInit = { ...(init || {}), signal };
        return originalFetch(input, nextInit).finally(clear);
      };
      patchedFetch.__codexPlusFastStartupPatched = true;
      window.fetch = patchedFetch;
    };

    const markStatsigReady = (client) => {
      if (!client || typeof client !== "object" || client.__codexPlusFastStartupReadyPatched) return;
      client.__codexPlusFastStartupReadyPatched = true;
      const markReady = () => {
        try {
          if (client.loadingStatus && client.loadingStatus !== "Ready") client.loadingStatus = "Ready";
        } catch {
        }
        try {
          if (typeof client.$emt === "function") client.$emt({ name: "values_updated" });
        } catch {
        }
      };
      if (typeof client.initializeAsync === "function") {
        const originalInitializeAsync = client.initializeAsync.bind(client);
        client.initializeAsync = (...args) => Promise.race([
          originalInitializeAsync(...args).catch(() => null),
          new Promise((resolve) => window.setTimeout(() => resolve(null), timeoutMs)),
        ]).finally(markReady);
      }
      markReady();
    };

    const statsigClients = () => {
      const root = window.__STATSIG__ || globalThis.__STATSIG__;
      if (!root || typeof root !== "object") return [];
      const clients = [root.firstInstance, typeof root.instance === "function" ? root.instance() : null];
      if (root.instances && typeof root.instances === "object") clients.push(...Object.values(root.instances));
      return clients.filter((client, index, array) => client && typeof client === "object" && array.indexOf(client) === index);
    };

    const patchStatsigRoot = () => statsigClients().forEach(markStatsigReady);

    patchFetch();
    patchStatsigRoot();
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      patchFetch();
      patchStatsigRoot();
      if (Date.now() - startedAt > 5000) window.clearInterval(timer);
    }, 50);
  }

