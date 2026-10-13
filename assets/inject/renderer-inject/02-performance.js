  function createCodexPlusPerformanceDiagnostics(options = {}) {
    const now = () => performance.now();
    const rpcMethods = new Set(["thread/list", "thread/read", "thread/resume", "thread/turns/list", "thread/turns/items/list", "turn/start", "skills/list", "plugin/list"]);
    const phases = new Set(["scanLightweight", "scanDeferred", "layout", "floatingScan"]);
    const rowSelector = "[data-app-action-sidebar-thread-id]";
    const contentSelector = ".thread-scroll-container [data-content-search-turn-key], .thread-scroll-container [data-message-author-role], .thread-scroll-container [data-testid='conversation-turn']";
    let active = false, timer = 0, frame = 0, observer = null, pending = null, serial = 0;
    let startedAt = 0, report = null;
    const version = (value) => /^[a-zA-Z0-9.+_-]{1,64}$/.test(String(value || "")) ? String(value) : "unknown";
    const route = () => String(window.location?.href || "");
    const content = () => document.querySelector(contentSelector);
    const contentKey = (node) => node?.getAttribute?.("data-content-search-turn-key") || "";
    const visible = (node) => {
      if (!node?.isConnected || document.hidden) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight
        && getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).display !== "none";
    };
    function finishSwitch(status) {
      if (!pending) return;
      report.switches.push({
        sequence: pending.sequence,
        status,
        contentVisibleMs: status === "visible" ? Math.round((now() - pending.at) * 10) / 10 : null,
      });
      pending = null;
    }
    function checkContent() {
      frame = 0;
      if (!active || !pending) return;
      if (document.hidden) { finishSwitch("hidden"); return; }
      const node = content();
      const row = document.querySelector(`${rowSelector}[data-app-action-sidebar-thread-active="true"], ${rowSelector}[aria-current="page"], ${rowSelector}[aria-current="true"], ${rowSelector}[data-state="active"], ${rowSelector}[aria-selected="true"]`);
      const selected = row?.getAttribute("data-app-action-sidebar-thread-id");
      const routed = route() !== pending.route && route().includes(encodeURIComponent(pending.target));
      const belongs = routed || selected === pending.target;
      const changed = node !== pending.node || contentKey(node) !== pending.key;
      if (belongs && changed && visible(node)) {
        // 两帧只确认新内容获得过绘制机会，不代表完整历史加载完成。
        pending.visibleFrames += 1;
        if (pending.visibleFrames >= 2) { finishSwitch("visible"); return; }
      } else pending.visibleFrames = 0;
      if (now() - pending.at >= 10000) { finishSwitch("unconfirmed"); return; }
      frame = requestAnimationFrame(checkContent);
    }
    function onNavigation(event) {
      if (!active || document.hidden || report.switches.length >= 200) return;
      if (event.type === "keydown" && (event.isComposing || !["Enter", " "].includes(event.key))) return;
      const row = event.target?.closest?.(rowSelector);
      const target = row?.getAttribute("data-app-action-sidebar-thread-id");
      if (!target || row.getAttribute("data-app-action-sidebar-thread-active") === "true") return;
      finishSwitch("superseded");
      const node = content();
      pending = { sequence: ++serial, at: now(), target, route: route(), node, key: contentKey(node), visibleFrames: 0 };
      if (!frame) frame = requestAnimationFrame(checkContent);
    }
    function snapshot() {
      return report ? JSON.parse(JSON.stringify(report)) : null;
    }
    function stop() {
      if (!active) return snapshot();
      active = false;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      timer = frame = 0;
      if (observer) {
        recordLongTasks(observer.takeRecords());
        observer.disconnect();
      }
      observer = null;
      document.removeEventListener("click", onNavigation, true);
      document.removeEventListener("keydown", onNavigation, true);
      finishSwitch("unconfirmed");
      report.durationMs = Math.min(60000, Math.round(now() - startedAt));
      report.active = false;
      report.versions = {
        official: version(options.officialVersion?.()),
        injected: version(window.__CODEX_PLUS_VERSION__),
        repository: version(options.repositoryVersion),
      };
      options.publish?.(snapshot());
      return snapshot();
    }
    function recordLongTasks(entries) {
      for (const entry of entries || []) {
        if (entry.startTime < startedAt || entry.startTime > startedAt + 60000) continue;
        report.longTasks.count += 1;
        report.longTasks.totalMs += entry.duration;
        report.longTasks.maxMs = Math.max(report.longTasks.maxMs, entry.duration);
      }
    }
    function start(durationMs = 60000) {
      stop();
      startedAt = now();
      serial = 0;
      report = {
        schema: 1, active: true, durationMs: 0,
        versions: {}, switches: [], spans: {},
        longTasks: { count: 0, totalMs: 0, maxMs: 0 },
        capabilities: { contentVisibility: "dom-two-frames", rpcTiming: false, injectionTiming: false, longTasks: false },
        missing: ["rpcTiming", "injectionTiming", "requestQueueTiming", "processResources"],
      };
      active = true;
      try {
        if (typeof PerformanceObserver === "function" && PerformanceObserver.supportedEntryTypes?.includes("longtask")) {
          observer = new PerformanceObserver((list) => { if (active) recordLongTasks(list.getEntries()); });
          observer.observe({ type: "longtask" });
          report.capabilities.longTasks = true;
        } else report.missing.push("longTasks");
      } catch { report.missing.push("longTasks"); }
      document.addEventListener("click", onNavigation, true);
      document.addEventListener("keydown", onNavigation, true);
      timer = setTimeout(stop, Math.min(60000, Math.max(1, Number(durationMs) || 60000)));
      return snapshot();
    }
    function begin(name, rpc = false) {
      if (!active || now() - startedAt >= 60000 || !(rpc ? rpcMethods : phases).has(name)) return null;
      if (rpc) {
        report.capabilities.rpcTiming = true;
        report.missing = report.missing.filter((item) => item !== "rpcTiming");
      } else {
        report.capabilities.injectionTiming = true;
        report.missing = report.missing.filter((item) => item !== "injectionTiming");
      }
      const current = report, at = now();
      let completed = false;
      return () => {
        if (completed || !active || current !== report || now() - startedAt > 60000) return;
        completed = true;
        const key = rpc ? `rpc:${name}` : name;
        const span = report.spans[key] ||= { count: 0, totalMs: 0, maxMs: 0 };
        const elapsed = now() - at;
        span.count += 1;
        span.totalMs += elapsed;
        span.maxMs = Math.max(span.maxMs, elapsed);
      };
    }
    return { start, stop, snapshot, begin };
  }
