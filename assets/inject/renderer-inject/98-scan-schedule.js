
  /** 关闭当前拓展页面并执行其 onCleanup。 */
  function closeCodexPlusPage() {
    const cleanup = window.__codexPlusExtensionPageCleanup;
    window.__codexPlusExtensionPageCleanup = null;
    if (typeof cleanup === "function") {
      try {
        cleanup();
      } catch {}
    }
    window.removeEventListener("resize", window.__codexPlusPageResizeHandler);
    document.querySelectorAll(`.${codexPlusPageClass}`).forEach((node) => node.remove());
    setCodexPlusSidebarNavActive(false);
  }

  /** 拓展入口的 DOM 标记：用它反查注册表项，dispose 后据此清理。 */
  const codexPlusExtensionRailAttribute = "data-codex-plus-ext-rail";

  /** 拓展入口的稳定 id。用注册表 id 推导，dispose 与重建都能算回同一个值。 */
  function codexPlusExtensionRailElementId(entry) {
    return `codex-plus-ext-rail-${String(entry.id).replace(/[^\w-]/g, "_")}`;
  }

  /**
   * 图标栏上的拓展入口。
   *
   * 与内置的三个入口并列插在 primary 锚点之后。内置项由
   * installCodexPlusRailNavigation 负责，这里只补第三方项，靠 id 幂等。
   */
  function refreshCodexPlusRailNavigation() {
    const rail = document.querySelector(codexPlusRailSelector);
    if (!rail) return false;
    const entries = codexPlusExtensionItems(codexPlusRegistry.navEntries);
    // 注意值域：属性里存的是注册表 id，所以这里也必须用注册表 id 比对。
    // 若拿元素 id（codex-plus-ext-rail-xxx）去比，两边永远不等，每次刷新都会把
    // 自己的入口当孤儿删掉，表现为「点了入口高亮立刻消失」。
    const liveIds = new Set(entries.map((entry) => entry.id));
    // 先清掉已不在注册表里的入口。dispose 之后没人来删 DOM，必须在这里收口，
    // 否则用户点一个已经注销的入口会什么都不发生。
    document.querySelectorAll(`[${codexPlusExtensionRailAttribute}]`).forEach((node) => {
      if (!liveIds.has(node.getAttribute(codexPlusExtensionRailAttribute) || "")) node.remove();
    });
    if (!entries.length) return false;
    const anchor = codexPlusRailPrimaryAnchor(rail);
    const host = anchor?.parentElement || rail;
    const template = codexPlusRailTemplateButton(rail);
    let cursor = anchor;
    // 内置三项先占位，第三方从它们之后开始排。
    [codexPlusRailNavId, codexPlusRailExtensionsId, codexPlusRailSponsorId].forEach((id) => {
      const node = document.getElementById(id);
      if (node) cursor = node;
    });
    entries.forEach((entry) => {
      const elementId = codexPlusExtensionRailElementId(entry);
      let wrapper = document.getElementById(elementId);
      if (!wrapper || wrapper.parentElement !== host) {
        wrapper?.remove();
        wrapper = createCodexPlusRailButton({
          id: elementId,
          template,
          label: entry.label || entry.id,
          iconMarkup: codexPlusExtensionIconMarkup(entry),
          withStatus: false,
          onActivate: () => {
            // 注册时若带了 pageId 就打开对应页面；否则交给拓展自己的 onActivate。
            const navigate = () => {
              if (entry.pageId && codexPlusRegistry.pages.has(entry.pageId)) {
                entry.navId = elementId;
                openCodexPlusExtensionPage(entry.pageId);
              } else if (typeof entry.onActivate === "function") {
                runCodexPlusExtensionCallback(entry.scriptKey, "navEntry.onActivate", () => entry.onActivate());
              }
            };
            navigate();
          },
        });
        if (!wrapper) return;
        // 这个属性是 dispose 后清理 DOM 的唯一线索，必须写。只靠
        // data-codex-plus-ext 认不出「这是 rail 入口」还是别的什么扩展节点。
        wrapper.setAttribute(codexPlusExtensionRailAttribute, entry.id);
        markCodexPlusExtensionNode(wrapper, entry.scriptKey);
        markCodexPlusExtensionNode(wrapper.firstElementChild || wrapper, entry.scriptKey);
      }
      if (cursor?.nextSibling) {
        if (cursor.nextSibling !== wrapper) host.insertBefore(wrapper, cursor.nextSibling);
      } else if (cursor) {
        host.appendChild(wrapper);
      }
      cursor = wrapper;
    });
    return true;
  }

  /**
   * 拓展注册的菜单项。
   *
   * 接入方式是「在 home 面板末尾追加一块」而不是把内置的一百多行模板拆成数组——
   * 拆模板动的是内置 UI 主干，出问题会影响所有人；追加只影响新内容，回滚时删掉
   * 这个调用即可。
   *
   * 每次 openCodexPlusModal 都会重新调用，所以不需要在别处维护刷新逻辑。
   */
  function renderCodexPlusExtensionMenuRows() {
    const items = codexPlusExtensionItems(codexPlusRegistry.menuItems);
    if (!items.length) return "";
    const rows = items.map((item) => {
      const title = escapeHtml(item.label || item.id);
      const description = escapeHtml(item.description || "");
      // 有 onChange 的渲染成开关，否则渲染成动作按钮。
      let control;
      if (typeof item.onChange === "function") {
        const enabled = typeof item.toggleValue === "function" ? item.toggleValue() === true : false;
        control = `<button type="button" class="codex-plus-toggle" data-codex-plus-ext-setting="${escapeHtml(item.id)}" data-enabled="${String(enabled)}" aria-pressed="${String(enabled)}"><span></span></button>`;
      } else {
        control = `<button type="button" class="codex-plus-action-button" data-codex-plus-ext-action="${escapeHtml(item.id)}">${escapeHtml(item.buttonLabel || "打开")}</button>`;
      }
      return `<div class="codex-plus-row" data-codex-plus-ext-row="${escapeHtml(item.id)}">`
        + `<div><div class="codex-plus-row-title">${title}</div>`
        + (description ? `<div class="codex-plus-row-description">${description}</div>` : "")
        + `</div>${control}</div>`;
