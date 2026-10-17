  function patchCodexPlusGitWorkerPerformance(worker) {
    if (worker?.workerId !== "git" || typeof worker.request !== "function"
        || !(worker.allEventListeners instanceof Set)) return null;
    const original = worker.request;
    const entries = new Map();
    let revision = 0, disposed = false;
    const invalidate = () => { revision += 1; entries.clear(); };
    const clone = (value) => structuredClone(value);

    function waitForEntry(entry, signal) {
      entry.waiters += 1;
      return new Promise((resolve, reject) => {
        let finished = false;
        const finish = (callback, value) => {
          if (finished) return;
          finished = true;
          signal?.removeEventListener("abort", abort);
          entry.waiters -= 1;
          callback(value);
        };
        const abort = () => {
          finish(reject, new DOMException("Git 查询已取消", "AbortError"));
          if (!entry.settled && entry.waiters === 0) {
            if (entries.get(entry.key) === entry) entries.delete(entry.key);
            entry.controller.abort();
          }
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        entry.promise.then((value) => {
          try { finish(resolve, clone(value)); } catch (error) { finish(reject, error); }
        }, (error) => finish(reject, error));
      });
    }

    const patched = function codexPlusGitPerformanceRequest(request) {
      const params = request?.params;
      // watchForGitInit 会安装监听；只合并无副作用的本机仓库识别。
      if (disposed || request?.method !== "stable-metadata" || !params?.cwd
          || params.watchForGitInit === true || !["durable", "local"].includes(params.hostConfig?.id)
          || request.signal?.aborted) {
        invalidate();
        return Reflect.apply(original, this, arguments);
      }
      const key = JSON.stringify([params.cwd, params.hostConfig, params.watchForGitInit]);
      let entry = entries.get(key);
      if (entry?.settled && entry.expiresAt <= Date.now()) {
        entries.delete(key);
        entry = null;
      }
      if (!entry) {
        const currentRevision = revision;
        entry = { key, controller: new AbortController(), waiters: 0, settled: false, expiresAt: 0 };
        const created = entry;
        entries.set(key, created);
        if (entries.size > 64) entries.delete(entries.keys().next().value);
        created.promise = Promise.resolve().then(() => original.call(worker, { ...request, signal: created.controller.signal })).then((value) => {
          created.settled = true;
          const valid = value && typeof value.root === "string" && typeof value.commonDir === "string";
          if (!disposed && currentRevision === revision && valid && entries.get(key) === created) {
            created.expiresAt = Date.now() + 2000;
          } else if (entries.get(key) === created) entries.delete(key);
          return value;
        }, (error) => {
          created.settled = true;
          if (entries.get(key) === created) entries.delete(key);
          throw error;
        });
      }
      return waitForEntry(entry, request.signal);
    };
    worker.request = patched;
    worker.allEventListeners.add(invalidate);
    window.addEventListener("focus", invalidate);
    document.addEventListener("visibilitychange", invalidate);
    return () => {
      disposed = true;
      invalidate();
      if (worker.request === patched) worker.request = original;
      worker.allEventListeners.delete(invalidate);
      window.removeEventListener("focus", invalidate);
      document.removeEventListener("visibilitychange", invalidate);
    };
  }

  let codexPlusGitPerformanceInstalling = false;
  let codexPlusGitPerformanceRetryAt = 0;
  async function installCodexPlusGitPerformance() {
    if (codexPlusGitPerformanceInstalling || window.__codexPlusGitPerformanceCleanup || codexPlusScanDisposed
        || codexPlusBackendSettings.enhancementsEnabled === false || !codexPlusIsWindowsPlatform
        || Date.now() < codexPlusGitPerformanceRetryAt) return;
    codexPlusGitPerformanceInstalling = true;
    codexPlusGitPerformanceRetryAt = Date.now() + 30000;
    try {
      const module = await loadOptionalCodexAppModule("app-shared-");
      if (codexPlusScanDisposed || codexPlusBackendSettings.enhancementsEnabled === false || !module) return;
      // 导出名随构建变化，按已核对的 worker 工厂结构识别。
      const factories = Object.values(module).filter((candidate) => {
        if (typeof candidate !== "function") return false;
        const source = String(candidate);
        return /case\s*[`'"]git[`'"]/.test(source) && /case\s*[`'"]computer-use[`'"]/.test(source)
          && source.includes("new ") && source.includes(".set(");
      });
      if (factories.length !== 1) {
        codexPlusGitPerformanceRetryAt = Number.POSITIVE_INFINITY;
        return;
      }
      const cleanup = patchCodexPlusGitWorkerPerformance(factories[0]("git"));
      codexPlusGitPerformanceRetryAt = Number.POSITIVE_INFINITY;
      if (cleanup) window.__codexPlusGitPerformanceCleanup = () => {
        cleanup();
        window.__codexPlusGitPerformanceCleanup = null;
        codexPlusGitPerformanceRetryAt = 0;
      };
    } catch {
      // 宿主不具备这套客户端时沿用原生查询。
    } finally {
      codexPlusGitPerformanceInstalling = false;
    }
  }

  function createCodexPlusLowPowerAnimations() {
    const saved = new Map(), pseudoAnimations = new Map();
    let observer = null, frame = 0, enabled = false;
    const restore = (node, state) => {
      if (node.style.getPropertyValue("animation-play-state") === state.applied) {
        if (state.value) node.style.setProperty("animation-play-state", state.value, state.priority);
        else node.style.removeProperty("animation-play-state");
      }
    };
    function refresh() {
      frame = 0;
      if (!enabled || document.hidden) return;
      // 暂停会改写计算样式；先还原再读取，避免旧的循环槽位影响新的有限动画。
      observer?.disconnect();
      for (const [node, state] of saved) restore(node, state);
      saved.clear();
      const targets = new Set();
      for (const animation of document.getAnimations()) {
        if (typeof CSSAnimation === "undefined" || !(animation instanceof CSSAnimation)
            || animation.effect?.getTiming().iterations !== Infinity) continue;
        const node = animation.effect.target;
        if (!node?.style) continue;
        if (animation.effect.pseudoElement) {
          if (!pseudoAnimations.has(animation) && animation.playState === "running") {
            pseudoAnimations.set(animation, true);
            animation.pause();
          }
        } else targets.add(node);
      }
      for (const [node, state] of saved) {
        if (!targets.has(node)) { restore(node, state); saved.delete(node); }
      }
      for (const node of targets) {
        const computed = getComputedStyle(node);
        const iterations = computed.animationIterationCount.split(",").map((s) => s.trim());
        const names = computed.animationName.split(",");
        const states = computed.animationPlayState.split(",").map((s) => s.trim());
        let state = saved.get(node);
        if (!state) {
          state = { value: node.style.getPropertyValue("animation-play-state"), priority: node.style.getPropertyPriority("animation-play-state"), applied: "" };
          saved.set(node, state);
        }
        const applied = names.map((_, i) => iterations[i % iterations.length] === "infinite" ? "paused" : states[i % states.length]).join(", ");
        state.applied = applied;
        if (node.style.getPropertyValue("animation-play-state") !== applied) node.style.setProperty("animation-play-state", applied, "important");
      }
      for (const [animation] of pseudoAnimations) {
        if (animation.effect?.getTiming().iterations !== Infinity && animation.playState === "paused") animation.play();
        if (animation.effect?.getTiming().iterations !== Infinity || animation.playState === "idle" || animation.playState === "finished") pseudoAnimations.delete(animation);
      }
      observer?.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
    }
    const schedule = () => { if (enabled && !document.hidden && !frame) frame = requestAnimationFrame(refresh); };
    function setEnabled(next) {
      if (enabled === next) return;
      enabled = next;
      if (enabled) {
        observer = new MutationObserver(schedule);
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
        document.addEventListener("animationstart", schedule, true);
        document.addEventListener("visibilitychange", schedule);
        schedule();
      } else {
        observer?.disconnect(); observer = null;
        cancelAnimationFrame(frame); frame = 0;
        document.removeEventListener("animationstart", schedule, true);
        document.removeEventListener("visibilitychange", schedule);
        for (const [node, state] of saved) restore(node, state);
        saved.clear();
        for (const [animation] of pseudoAnimations) if (animation.playState === "paused") animation.play();
        pseudoAnimations.clear();
      }
    }
    return { setEnabled };
  }

  function syncCodexPlusLowPower() {
    window.__codexPlusLowPowerAnimations ||= createCodexPlusLowPowerAnimations();
    window.__codexPlusLowPowerAnimations.setEnabled(codexPlusBackendSettings.enhancementsEnabled !== false && codexPlusBackendSettings.codexAppLowPower === true);
  }
