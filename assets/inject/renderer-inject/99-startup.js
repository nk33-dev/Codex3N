    }).join("");
    // 整块包一层：dispose 后能一次性摘掉，测试也好定位。
    return `<div data-codex-plus-ext-menu="true">${rows}</div>`;
  }

  /**
   * 处理拓展菜单项的点击。
   *
   * 由 openCodexPlusModal 的委托监听调用；返回 true 表示已处理，调用方应 return。
   */
  function handleCodexPlusExtensionMenuClick(target) {
    const action = target?.closest?.("[data-codex-plus-ext-action]");
    if (action) {
      const id = action.getAttribute("data-codex-plus-ext-action") || "";
      const item = codexPlusRegistry.menuItems.get(id);
      if (!item) return true;
      runCodexPlusExtensionCallback(item.scriptKey, "menuItem.onActivate", () =>
        item.onActivate({ close: () => document.querySelector(".codex-plus-modal-close")?.click() }));
      return true;
    }
    const toggle = target?.closest?.("[data-codex-plus-ext-setting]");
    if (toggle) {
      const id = toggle.getAttribute("data-codex-plus-ext-setting") || "";
      const item = codexPlusRegistry.menuItems.get(id);
      if (!item) return true;
      const next = toggle.getAttribute("data-enabled") !== "true";
      toggle.setAttribute("data-enabled", String(next));
      toggle.setAttribute("aria-pressed", String(next));
      runCodexPlusExtensionCallback(item.scriptKey, "menuItem.onChange", () => item.onChange(next));
      return true;
