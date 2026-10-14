(() => {
  const url = new URL(window.location.href);
  const supported = window.top === window && (window.electronBridge && url.protocol === "app:"
    || url.protocol === "https:" && ["chatgpt.com", "chat.openai.com"].includes(url.hostname));
  if (!supported) return;
  window.__codexPlusConversationPerformance?.stop();

  function createConversationPerformance() {
    const turnSelector = '.thread-scroll-container [data-content-search-turn-key], main [data-testid="conversation-turn"]';
    const boundarySelector = '[data-content-search-turn-key], [data-testid="conversation-turn"]';
    const properties = ["content-visibility", "contain-intrinsic-block-size"];
    const managed = new Map();
    let frame = 0, enabled = false, disposed = false, composing = false;
    const observer = new MutationObserver((records) => {
      if (document.hidden) return;
      if (records.some((record) => {
        if (record.target?.closest?.(boundarySelector)) return false;
        return [...record.addedNodes, ...record.removedNodes].some((node) => node.nodeType === 1
          && (node.matches(boundarySelector) || node.querySelector(boundarySelector)));
      })) schedule();
    });

    function restore(node, saved) {
      for (const property of properties) {
        // 宿主或用户脚本后来修改过的样式由它们自己管理。
        if (node.style.getPropertyValue(property) !== saved.applied[property]) continue;
        const original = saved.original[property];
        if (original.value) node.style.setProperty(property, original.value, original.priority);
        else node.style.removeProperty(property);
      }
      managed.delete(node);
    }

    function sync() {
      frame = 0;
      if (!enabled || disposed || document.hidden || composing) return;
      const turns = [...document.querySelectorAll(turnSelector)];
      const panes = new Map();
      for (const turn of turns) {
        const pane = turn.closest?.(".thread-scroll-container, main") || document;
        if (!panes.has(pane)) panes.set(pane, []);
        panes.get(pane).push(turn);
      }
      const historical = new Set([...panes.values()].flatMap((items) => items.length >= 40 ? items.slice(0, -2) : []));
      for (const [node, saved] of managed) {
        if (!historical.has(node) || !node.isConnected) restore(node, saved);
      }
      const updates = [];
      for (const node of historical) {
        if (managed.has(node) || node.style.getPropertyValue("content-visibility")) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const computed = getComputedStyle(node);
        if (computed.contentVisibility !== "visible" || ["absolute", "fixed"].includes(computed.position)) continue;
        if (computed.display === "block") {
          const first = node.firstElementChild, last = node.lastElementChild;
          const startOpen = Number.parseFloat(computed.paddingBlockStart) === 0 && Number.parseFloat(computed.borderBlockStartWidth) === 0;
          const endOpen = Number.parseFloat(computed.paddingBlockEnd) === 0 && Number.parseFloat(computed.borderBlockEndWidth) === 0;
          // 布局包含会改变子节点外边距折叠；这类消息保留原生布局。
          if (startOpen && first && Number.parseFloat(getComputedStyle(first).marginBlockStart) !== 0
              || endOpen && last && Number.parseFloat(getComputedStyle(last).marginBlockEnd) !== 0) continue;
        }
        const height = Number.parseFloat(computed.blockSize);
        if (!Number.isFinite(height) || height <= 0) continue;
        const original = Object.fromEntries(properties.map((property) => [property, {
          value: node.style.getPropertyValue(property), priority: node.style.getPropertyPriority(property),
        }]));
        updates.push({ node, original, height });
      }
      // 先读完尺寸再写样式，保留历史高度；最新两条持续按原生方式渲染。
      for (const { node, original, height } of updates) {
        const applied = { "content-visibility": "auto", "contain-intrinsic-block-size": `auto ${height}px` };
        for (const property of properties) node.style.setProperty(property, applied[property]);
        managed.set(node, { original, applied });
      }
    }

    function schedule() {
      if (frame || !enabled || disposed || document.hidden || composing) return;
      frame = requestAnimationFrame(sync);
    }
    function visibility() {
      if (document.hidden) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else schedule();
    }
    function composition(event) {
      composing = event.type === "compositionstart";
      if (composing) {
        cancelAnimationFrame(frame);
        frame = 0;
      } else schedule();
    }
    function setEnabled(value) {
      const next = value === true && CSS.supports("content-visibility", "auto")
        && CSS.supports("contain-intrinsic-block-size", "auto 1px");
      if (disposed || enabled === next) return;
      enabled = next;
      if (enabled) {
        observer.observe(document.documentElement || document, { childList: true, subtree: true });
        document.addEventListener("visibilitychange", visibility);
        document.addEventListener("compositionstart", composition, true);
        document.addEventListener("compositionend", composition, true);
        window.addEventListener("blur", composition);
        schedule();
      } else {
        observer.disconnect();
        cancelAnimationFrame(frame);
        frame = 0;
        composing = false;
        document.removeEventListener("visibilitychange", visibility);
        document.removeEventListener("compositionstart", composition, true);
        document.removeEventListener("compositionend", composition, true);
        window.removeEventListener("blur", composition);
        for (const [node, saved] of managed) restore(node, saved);
      }
    }
    return { setEnabled, stop() { setEnabled(false); disposed = true; } };
  }

  window.__codexPlusConversationPerformance = createConversationPerformance();
  window.__codexPlusConversationPerformance.setEnabled(window.__CODEX_PLUS_PERFORMANCE_ENABLED__ === true);
})();
