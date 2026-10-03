      // 左面板点行 = 选中并在右侧显示详情。放在安装/卸载之后，
      // 免得点了行内的按钮又被当成一次选中。
      const extensionsSelect = target?.closest("[data-codex-extensions-select]");
      if (extensionsSelect) {
        const [kind, ...rest] = extensionsSelect.getAttribute("data-codex-extensions-select").split(":");
        codexPlusExtensionsSelected = { kind, key: rest.join(":") };
        refreshCodexPlusExtensionsView();
        return;
      }
      if (target?.closest("[data-codex-upstream-worktree-open]")) {
        if (!codexPlusSettings().upstreamWorktreeCreate) {
          showToast("Upstream worktree enhancement is disabled", null);
          return;
        }
        openUpstreamWorktreeDialog();
        return;
      }
      const toggle = target?.closest("[data-codex-plus-setting]");
      if (toggle) {
        if (toggle.disabled || toggle.dataset.pending === "true") return;
        const key = toggle.getAttribute("data-codex-plus-setting");
        setCodexPlusSetting(key, !codexPlusSettings()[key]);
        return;
      }
      const backendToggle = target?.closest("[data-codex-backend-setting]");
      if (backendToggle) {
        const key = backendToggle.getAttribute("data-codex-backend-setting");
        setBackendSetting(key, !codexPlusBackendSettings[key]);
        return;
      }
    }, true);
    // 图标加载失败的回退：error 不冒泡，只能捕获阶段委托。
    overlay.addEventListener("error", handleExtensionIconError, true);
    document.body.appendChild(overlay);
    if (pageMode) {
      positionCodexPlusPage(overlay);
      // 必须在 selectCodexPlusTab 之前建好两栏，否则刷新左面板时找不到容器。
      installCodexPlusPageLayout(overlay, initialTab);
      if (!window.__codexPlusPageResizeHandler) {
        window.__codexPlusPageResizeHandler = () => positionCodexPlusPage(document.querySelector(`.${codexPlusPageClass}`));
        window.addEventListener("resize", window.__codexPlusPageResizeHandler);
      }
    }
    if (!codexPlusAdsLoaded) fetchCodexPlusAds();
    selectCodexPlusTab(initialTab);
    // 必须在 selectCodexPlusTab 之后：激活态要靠 data-codex-plus-active-tab
    // 判断当前是 Codex++ 还是「拓展」，提前调用会永远落到 home 上。
    if (pageMode) setCodexPlusSidebarNavActive(true, codexPlusActiveEntry() || "home");
    renderCodexPlusMenu();
    refreshCodexPlusBackendToggles();
    renderBackendStatus();
    void loadCodexServiceTierState();
    loadUserScripts();
  }

  function openCodexPlusPage() {
    openCodexPlusModal({ page: true });
  }

  /** 「拓展」页面：从弹窗里拆出来的用户脚本，形态对齐 VSCode 的扩展面板。 */
  function openCodexPlusExtensions() {
    openCodexPlusModal({ page: true, tab: codexPlusExtensionsTab });
  }

  /** 「推荐内容」页面：从弹窗的二级 tab 提出来，成为图标栏上的一级入口。 */
  function openCodexPlusSponsor() {
    openCodexPlusModal({ page: true, tab: codexPlusSponsorTab });
  }

  function closeCodexPlusPage() {
    document.querySelectorAll(`.${codexPlusPageClass}`).forEach((node) => node.remove());
    setCodexPlusSidebarNavActive(false);
  }

  function closeCodexPlusPageAfterNativeNavigation() {
    clearTimeout(window.__codexPlusPageNavigationCloseTimer);
    window.__codexPlusPageNavigationCloseTimer = setTimeout(() => {
      window.__codexPlusPageNavigationCloseTimer = null;
      closeCodexPlusPage();
    }, 0);
  }

  function installCodexPlusPageNavigationCloseHandler() {
    document.removeEventListener("click", window.__codexPlusPageNavigationCloseHandler, true);
    window.__codexPlusPageNavigationCloseHandler = (event) => {
      if (!document.querySelector(`.${codexPlusPageClass}`)) return;
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      if (!target?.closest(selectors.sidebarThread)) return;
      // Let Codex's own click handler update its route before removing our page.
      closeCodexPlusPageAfterNativeNavigation();
    };
    document.addEventListener("click", window.__codexPlusPageNavigationCloseHandler, true);
  }

  function installCodexPlusSidebarNavigation() {
    document.querySelectorAll(`#${codexPlusMenuId}, [data-codex-plus-menu="true"]`).forEach((node) => node.remove());
    // 旧版的侧边栏会话列表在 aside 里带 role="navigation"。新版把这个 role 挪去了
    // 缩略图面板/演示目录，所以留一条限定在 aside 内的兜底。
    // 注意：新版图标栏也是 aside 里的 <nav>，且文档顺序在前，而 querySelector 的选择器
    // 列表是按文档顺序取首个命中项的——必须显式排除图标栏，否则会挂到它上面。
    const navigation = document.querySelector('aside.app-shell-left-panel nav[role="navigation"]')
      || Array.from(document.querySelectorAll("aside.app-shell-left-panel nav"))
        .find((nav) => !nav.hasAttribute("data-app-navigation-rail"))
      || null;
    if (!navigation) return;
    const navButtons = Array.from(navigation.querySelectorAll("button"));
    const pluginButton = navButtons.find((button) => {
      if (button.querySelector(selectors.pluginSvgPath)) return true;
      const label = (button.getAttribute("aria-label") || button.textContent || "").trim();
      return /^(插件|Plugins)$/i.test(label);
    });
    const insertionButton = pluginButton || navButtons.find((button) => {
      const label = (button.getAttribute("aria-label") || button.textContent || "").replace(/\s+/g, " ").trim();
      return /^(已安排|Scheduled|拉取请求|Pull requests|新对话|New chat)$/i.test(label);
    });
    if (navigation.dataset.codexPlusSidebarNavigationListener !== "true") {
      navigation.dataset.codexPlusSidebarNavigationListener = "true";
      navigation.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : event.target?.parentElement;
        if (target?.closest(`#${codexPlusSidebarNavId}`)) return;
        if (target?.closest("button, a")) closeCodexPlusPageAfterNativeNavigation();
      }, true);
    }
    let wrapper = document.getElementById(codexPlusSidebarNavId);
    const parent = insertionButton?.parentElement || navigation;
    if (!wrapper || wrapper.parentElement !== parent) {
      wrapper?.remove();
      wrapper = document.createElement("div");
      wrapper.id = codexPlusSidebarNavId;
      wrapper.dataset.codexPlusSidebarNav = "true";
      const button = (insertionButton || document.createElement("button")).cloneNode(true);
      if (!(button instanceof HTMLElement)) return;
      if (!button.className) button.className = "h-token-nav-row w-full flex items-center gap-2 px-3 py-2 text-sm";
      button.type = "button";
      button.removeAttribute("data-state");
      button.removeAttribute("aria-current");
      button.removeAttribute("disabled");
      button.removeAttribute("aria-disabled");
      button.setAttribute("aria-label", "Codex++");
      button.textContent = "";
      button.innerHTML = `<span class="codex-plus-sidebar-nav-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18M5.5 5.5l13 13M18.5 5.5l-13 13"/></svg></span><span class="truncate">Codex++</span><span class="codex-plus-sidebar-nav-status" data-status="${codexPlusBackendStatus.status || "checking"}" aria-hidden="true"></span>`;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        openCodexPlusPage();
      }, true);
      wrapper.appendChild(button);
      if (insertionButton?.nextSibling) {
        parent.insertBefore(wrapper, insertionButton.nextSibling);
      } else {
        parent.appendChild(wrapper);
      }
    }
    const status = wrapper.querySelector(".codex-plus-sidebar-nav-status");
    if (status) status.dataset.status = codexPlusBackendStatus.status || "checking";
    const active = !!document.querySelector(`.${codexPlusPageClass}`);
    setCodexPlusSidebarNavActive(active);
  }

  function removeCodexPlusRailNavigation() {
    [codexPlusRailNavId, codexPlusRailExtensionsId, codexPlusRailSponsorId].forEach((id) => document.getElementById(id)?.remove());
  }

  function detachCodexPlusSidebarNavigation() {
    document.getElementById(codexPlusSidebarNavId)?.remove();
  }

  /**
   * 挑一个原生 rail 按钮当模板。
   *
   * 优先 builtin:projects——它在 primary 区，且不像 builtin:library 那样会走
   * tooltip/triggerRef 的特殊分支。找不到就退回第一个可见 destination。
   */
  function codexPlusRailTemplateButton(rail) {
    const preferred = rail.querySelector(`${codexPlusRailDestinationSelector}[data-sidebar-destination="builtin:projects"]`);
    if (preferred) return preferred;
    const candidates = Array.from(rail.querySelectorAll(codexPlusRailDestinationSelector))
      .filter((node) => node.closest("nav") === rail);
    // 优先挑未选中的：clone 会把选中态的属性和配色一起带过来，
    // 表现为入口在没有任何页面打开时也显示成选中。
    const isSelected = (node) => node.getAttribute("aria-current") === "page" || node.hasAttribute("data-selected");
    return candidates.find((node) => !isSelected(node)) || candidates[0] || null;
  }

  function codexPlusRailPrimaryAnchor(rail) {
    const fixedIds = [
      'builtin:home',
      'builtin:customize',
    ];
    const buttons = Array.from(rail.querySelectorAll(codexPlusRailDestinationSelector));
    return buttons.find((node) => {
      const id = node.getAttribute("data-sidebar-destination") || "";
      return id && !fixedIds.includes(id);
    }) || null;
  }

  function createCodexPlusRailButton({ id, template, label, iconMarkup, withStatus, onActivate }) {
    const wrapper = document.createElement("div");
    wrapper.id = id;
    wrapper.dataset.codexPlusRail = id === codexPlusRailExtensionsId ? "extensions" : "home";
    // 模板拿不到时不回退到旧模式，而是自建一个按钮：rail 上 destination 可能在
    // 登录态/接口就绪前还是空的，那只是暂时状态，不该让入口整个消失。
    const button = template
      ? template.cloneNode(true)
      : document.createElement("button");
    if (!(button instanceof HTMLElement)) return null;
    button.type = "button";
    // 留着 data-sidebar-destination 会被 Codex 的自定义/排序逻辑当成真的 destination。
    button.removeAttribute("data-sidebar-destination");
    button.removeAttribute("data-state");
    button.removeAttribute("disabled");
    button.removeAttribute("aria-disabled");
    // 选中态由 data-selected 驱动，但它只在没有 data-suppress-active-style 时生效。
    // 模板若是未选中的按钮，会带着 suppress 过来，压制掉我们的选中样式——
    // 必须移除，否则按钮永远停在未选中的暗色。
    button.removeAttribute("data-suppress-active-style");
    // 起始为未选中；激活态由 setCodexPlusSidebarNavActive 切换 data-selected。
    button.removeAttribute("data-selected");
    button.removeAttribute("aria-current");
    button.setAttribute("aria-label", label);
    button.textContent = "";
    // 原生 rail 按钮是纯图标，没有文字标签，所以只放图标 + 状态点。
    button.innerHTML = `<span class="codex-plus-rail-icon" aria-hidden="true">${iconMarkup}</span>`
      + (withStatus
        ? `<span class="codex-plus-sidebar-nav-status" data-status="${codexPlusBackendStatus.status || "checking"}" aria-hidden="true"></span>`
        : "");
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onActivate();
    }, true);
    wrapper.appendChild(button);
    return wrapper;
  }

  /**
   * 把 Codex++ / 拓展两个入口挂到新版图标栏。
   *
   * Codex 的 rail 渲染晚于注入，所以这里每次 scan 都会被调用；靠 id 判存避免重复插入。
   */
  function installCodexPlusRailNavigation() {
    document.querySelectorAll(`#${codexPlusMenuId}, [data-codex-plus-menu="true"]`).forEach((node) => node.remove());
    const rail = document.querySelector(codexPlusRailSelector);
    if (!rail) return false;
    // 注意：模板按钮可能在 rail 还没渲染出 destination 时拿不到（登录态/接口未就绪）。
    // 那只是暂时状态，不能因此判定"没有 rail"而回退旧模式，否则入口会整个消失。
    const template = codexPlusRailTemplateButton(rail);

    // 旧逻辑把"点原生导航就关掉 Codex++ 页面"的监听挂在侧边栏的 navigation 上，
    // 但 rail 模式下那个函数会提前 return，监听压根装不上，所以这里补一份。
    if (rail.dataset.codexPlusRailNavigationListener !== "true") {
      rail.dataset.codexPlusRailNavigationListener = "true";
      rail.addEventListener("click", (event) => {
        const target = event.target instanceof Element ? event.target : event.target?.parentElement;
        if (target?.closest(`#${codexPlusRailNavId}, #${codexPlusRailExtensionsId}, #${codexPlusRailSponsorId}`)) return;
        // 拓展入口的 id 是动态生成的，不在上面三个之内。不排除它，点拓展入口会被
        // 当成「点了原生导航按钮」，刚打开的拓展页面立刻被关掉。
        if (target?.closest(`[${codexPlusExtensionConstants.extensionAttribute}]`)) return;
        if (target?.closest("button, a")) closeCodexPlusPageAfterNativeNavigation();
      }, true);
    }

    const icons = {
      home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M3 12h18M5.5 5.5l13 13M18.5 5.5l-13 13"/></svg>',
      // 「拓展」直接用 VSCode 的扩展字形（就是列表里默认图标那一份），
      // 和页面内部保持同一个符号，不再另画一个近似图形。
      extensions: `<svg viewBox="0 0 16 16" fill="currentColor"><path d="${codexPlusDefaultExtensionIconPath}"/></svg>`,
      // Lucide 的 megaphone：与 home 同一套 24 格线性风格，笔画宽度和端点也一致。
      sponsor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>',
    };

    const specs = [
      { id: codexPlusRailNavId, label: "Codex++", iconMarkup: icons.home, withStatus: true, onActivate: openCodexPlusPage },
      { id: codexPlusRailExtensionsId, label: "拓展", iconMarkup: icons.extensions, withStatus: false, onActivate: openCodexPlusExtensions },
      { id: codexPlusRailSponsorId, label: "推荐内容", iconMarkup: icons.sponsor, withStatus: false, onActivate: openCodexPlusSponsor },
    ];

    const anchor = codexPlusRailPrimaryAnchor(rail);
    // 插到锚点所在的父容器里，而不是 nav 顶层：原生按钮可能嵌在 nav 内部的分组 div 中，
    // 直接插顶层会破坏它的 flex 布局。
    const host = anchor?.parentElement || rail;
    let cursor = anchor;
    specs.forEach((spec) => {
      let wrapper = document.getElementById(spec.id);
      if (!wrapper || wrapper.parentElement !== host) {
        wrapper?.remove();
        wrapper = createCodexPlusRailButton({ ...spec, template });
        if (!wrapper) return;
      }
      // 顺序：Codex++ 在前，「拓展」在后；紧跟在 primary 区锚点后面。
      if (cursor?.nextSibling) {
        host.insertBefore(wrapper, cursor.nextSibling);
      } else if (cursor) {
        host.appendChild(wrapper);
      } else {
        host.insertBefore(wrapper, host.firstElementChild);
      }
      cursor = wrapper;
    });

    const status = document.getElementById(codexPlusRailNavId)?.querySelector(".codex-plus-sidebar-nav-status");
    if (status) status.dataset.status = codexPlusBackendStatus.status || "checking";
    return true;
  }

  /** 图标栏存在时走它，否则回退到旧版宽面板侧边栏入口。两条路径互斥，不会重复出现。 */
  function installCodexPlusNavigationEntries() {
    if (installCodexPlusRailNavigation()) {
      detachCodexPlusSidebarNavigation();
      return;
    }
    removeCodexPlusRailNavigation();
    installCodexPlusSidebarNavigation();
  }

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
    const originalSendRequest = client.__codexPluginMarketplaceOriginalSendRequest || client.sendRequest.bind(client);
    client.__codexPluginMarketplaceRawSendRequest = client.sendRequest;
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
      bridge.__codexPluginMarketplaceRawSendMessageFromView = originalSendMessageFromView;
      bridge.__codexPluginMarketplaceOriginalSendMessageFromView = bridge.sendMessageFromView.bind(bridge);
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
            window.__codexPluginMarketplacePatchedClients = window.__codexPluginMarketplacePatchedClients || [];
            if (!window.__codexPluginMarketplacePatchedClients.includes(candidate)) window.__codexPluginMarketplacePatchedClients.push(candidate);
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

  function restorePluginBuildFlavorFilterPatch() {
    const original = Array.prototype.__codexPluginBuildFlavorOriginalFilter;
    const patched = Array.prototype.filter?.__codexPluginBuildFlavorPatched;
    if (typeof original === "function" && patched) {
      Array.prototype.filter = original;
      delete Array.prototype.__codexPluginBuildFlavorOriginalFilter;
      delete window.__codexPluginBuildFlavorFilterPatch;
      return true;
    }
    return false;
  }

  function restorePluginMarketplaceWindowEventPatch() {
    let restored = false;
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
    return restored;
  }

  function restorePluginMarketplaceBridgePatch() {
    const bridge = window.electronBridge;
    const original = bridge?.__codexPluginMarketplaceRawSendMessageFromView || bridge?.__codexPluginMarketplaceOriginalSendMessageFromView;
    if (bridge && typeof original === "function" && bridge.sendMessageFromView !== original) {
      bridge.sendMessageFromView = original;
      delete bridge.__codexPluginMarketplaceRawSendMessageFromView;
      delete bridge.__codexPluginMarketplaceOriginalSendMessageFromView;
      delete bridge.__codexPluginMarketplaceBridgePatch;
      delete window.__codexPluginMarketplaceBridgePatch;
      return true;
    }
    return false;
  }

  function restorePluginMarketplaceRequestPatch() {
    let restored = false;
    const clients = window.__codexPluginMarketplacePatchedClients;
    if (Array.isArray(clients)) for (const client of clients) {
      const original = client?.__codexPluginMarketplaceRawSendRequest || client?.__codexPluginMarketplaceOriginalSendRequest;
      if (typeof original === "function" && client.sendRequest !== original) {
        client.sendRequest = original;
        restored = true;
      }
      delete client.__codexPluginMarketplaceRawSendRequest;
      delete client.__codexPluginMarketplaceOriginalSendRequest;
    }
    delete window.__codexPluginMarketplacePatchedClients;
    delete window.__codexPluginMarketplaceUnlockInstalled;
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
    if (restored) sendCodexPlusDiagnostic("plugin_marketplace_patches_cleared", {});
  }

  const invalidSessionStorageKey = "codex3n.hiddenInvalidSessions.v1";
  let invalidSessionIds = new Set();
  let verifiedInvalidSessionIds = new Set();
  let sessionHealthBusy = false;
  let sessionHealthGeneration = 0;
  let sessionHealthCheckedAt = Date.now();
  const sessionHealthAutoRecheckMs = 5 * 60 * 1000;
  try {
    const saved = JSON.parse(localStorage.getItem(invalidSessionStorageKey) || "[]");
    if (Array.isArray(saved)) invalidSessionIds = new Set(saved.map(normalizedCodexThreadUuid).filter(Boolean));
  } catch {}

  function updateSessionHealthStatus(message) {
    document.querySelectorAll("[data-codex-session-health-status]").forEach((node) => { node.textContent = message; });
    document.querySelectorAll("[data-codex-session-health-scan]").forEach((button) => { button.disabled = sessionHealthBusy; });
  }

  function localSessionHealthRowId(row) {
    const hostId = row.getAttribute("data-app-action-sidebar-thread-host-id");
    const ref = sessionRefFromRow(row);
    if (hostId !== "local" && !(hostId == null && /^local:/i.test(ref.session_id))) return "";
    return normalizedCodexThreadUuid(ref.session_id).toLowerCase();
  }

  function applyInvalidSessionVisibility() {
    sessionRows().forEach((row) => {
      const id = localSessionHealthRowId(row);
      const hidden = codexPlusBackendSettings.enhancementsEnabled !== false && !!id && verifiedInvalidSessionIds.has(id);
      const marker = row.getAttribute("data-codex-invalid-session-hidden");
      if (hidden && marker !== "true") row.setAttribute("data-codex-invalid-session-hidden", "true");
      else if (!hidden && marker !== null) row.removeAttribute("data-codex-invalid-session-hidden");
    });
  }

  function resetInvalidSessionVisibility() {
    localStorage.removeItem(invalidSessionStorageKey);
    sessionHealthGeneration += 1;
    invalidSessionIds.clear();
    verifiedInvalidSessionIds.clear();
    applyInvalidSessionVisibility();
    updateSessionHealthStatus("已显示全部会话；会话数据未改动。");
  }

  async function sessionHealthRequest(request, timeoutMs = 5000) {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(request), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("检查超时")), timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }

  async function nativeSessionIsMissing(threadId, clients) {
    if (!clients.length) return false;
    let missing = false;
    let uncertain = false;
    for (const client of clients) {
      try {
        const result = await sessionHealthRequest(() => client.sendRequest("thread/read", { threadId, includeTurns: true }));
        if (result?.thread?.id === threadId || result?.result?.thread?.id === threadId) return false;
        uncertain = true;
      } catch (error) {
        const message = String(error?.message || error).trim().toLowerCase();
        if (error?.code === -32601 || /^(?:unknown method|method not found)/.test(message)) continue;
        if (message.includes("no rollout found") || message.includes("thread not loaded")) missing = true;
        else uncertain = true;
      }
    }
    return missing && !uncertain;
  }

  async function checkAndHideInvalidSessions(automatic = false) {
    if (sessionHealthBusy) return;
    sessionHealthBusy = true;
    const generation = sessionHealthGeneration;
    try {
      const observedIds = automatic ? [...invalidSessionIds] : sessionRows(true).map(localSessionHealthRowId).filter(Boolean);
      const result = await sessionHealthRequest(() => postJson("/session/health", { threadIds: observedIds, observedOnly: automatic }), 60000);
      if (result.status !== "ok" || !Array.isArray(result.missingIds)) throw new Error(result.message || "检查失效会话失败");
      const missingIds = result.missingIds.filter((id) => !automatic || invalidSessionIds.has(id));
      const clients = missingIds.length ? (await sessionHealthRequest(loadAppServerRequestCandidates)).candidates.filter((client) => typeof client?.sendRequest === "function") : [];
      const confirmed = new Set();
      for (const id of missingIds) if (generation === sessionHealthGeneration && await nativeSessionIsMissing(id, clients)) confirmed.add(id);
      if (generation !== sessionHealthGeneration) return;
      localStorage.setItem(invalidSessionStorageKey, JSON.stringify([...confirmed]));
      invalidSessionIds = confirmed;
      verifiedInvalidSessionIds = new Set(confirmed);
      applyInvalidSessionVisibility();
      if (!automatic) updateSessionHealthStatus(`已检查 ${result.scanned} 条会话记录，确认失效并隐藏 ${confirmed.size} 个。`);
    } catch (error) {
      if (generation === sessionHealthGeneration) updateSessionHealthStatus(`未隐藏会话：${error?.message || String(error)}`);
    } finally {
      sessionHealthBusy = false;
      sessionHealthCheckedAt = Date.now();
      document.querySelectorAll("[data-codex-session-health-scan]").forEach((button) => { button.disabled = false; });
    }
  }

  function refreshInvalidSessionVisibility() {
    applyInvalidSessionVisibility();
    if (invalidSessionIds.size && !sessionHealthBusy && document.visibilityState !== "hidden" && Date.now() - sessionHealthCheckedAt > sessionHealthAutoRecheckMs && codexPlusBackendSettingsLoaded && codexPlusBackendSettings.enhancementsEnabled !== false) void checkAndHideInvalidSessions(true);
  }

  let cachedSessionRows = [];
  let cachedSessionRowsAt = 0;
  let threadIdBadgeActive = false;

  function sessionRows(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && now - cachedSessionRowsAt < 150) {
      cachedSessionRows = cachedSessionRows.filter((row) => row.isConnected);
      if (cachedSessionRows.length > 0) return cachedSessionRows;
    }

    cachedSessionRows = Array.from(document.querySelectorAll(selectors.sidebarThread));
    cachedSessionRowsAt = now;
    return cachedSessionRows;
  }

  function archivePageHintVisible() {
    if (window.location.href.includes("archive")) return true;
    if (document.querySelector('[data-codex-archive-page-row="true"], [data-codex-archive-delete-all]')) return true;
    const archiveNav = document.querySelector(selectors.archiveNav);
    if (archiveNav?.className?.includes?.("bg-token-list-hover-background")) return true;
    return !!Array.from(document.querySelectorAll("h1, h2, h3")).find((element) => (element.textContent || "").trim() === "已归档对话");
  }

  function archiveRowFromUnarchiveButton(button) {
    return button.closest('[data-codex-archive-page-row="true"]')
      || button.closest('[role="listitem"], [role="row"]')
      || button.closest(".flex.w-full.items-center.justify-between")
      || button.parentElement;
  }

  function archivedPageRows() {
    if (!archivePageHintVisible()) return [];
    const rows = Array.from(document.querySelectorAll("button")).filter((button) => (button.textContent || "").trim() === "取消归档").map(archiveRowFromUnarchiveButton).filter(Boolean);
    rows.forEach((row) => {
      row.dataset.codexArchivePageRow = "true";
      row.setAttribute("data-codex-archive-page-row", "true");
    });
    return rows;
  }

  function archivedSessionRows() {
    if (!archivePageHintVisible()) return [];
    return sessionRows().filter((row) => row.querySelector('button[aria-label="取消归档对话"]') || row.outerHTML.includes("取消归档") || row.outerHTML.includes("unarchive"));
  }

  function archivedRows() {
    if (!archivePageHintVisible()) return [];
    return [...archivedSessionRows(), ...archivedPageRows()];
  }

  function archivedPageVisible() {
    return archivePageHintVisible() && archivedRows().length > 0;
  }

  function isClientNewThreadId(value) {
    return /^(?:local:)?client-new-thread:/i.test(String(value || "").trim());
  }

  function normalizedCodexThreadUuid(value) {
    const id = String(value || "").trim().replace(/^local:/i, "");
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : "";
  }

  function reactConversationIdFromRow(row) {
    const fiberKey = Object.getOwnPropertyNames(row).find((key) => key.startsWith("__reactFiber$"));
    let fiber = fiberKey ? row[fiberKey] : null;
    for (let fiberDepth = 0; fiber && fiberDepth < 16; fiberDepth += 1, fiber = fiber.return) {
      for (const props of [fiber.pendingProps, fiber.memoizedProps]) {
        const directId = normalizedCodexThreadUuid(props?.conversationId);
        if (directId) return directId;
        const childId = normalizedCodexThreadUuid(
          props?.children?.props?.conversationId,
        );
        if (childId) return childId;
      }
    }
    return "";
  }

  function sessionRefFromRow(row) {
    const href = row.getAttribute("href") || row.querySelector("a")?.getAttribute("href") || "";
    const idMatch = href.match(/(?:session|conversation|thread)[=/:-]([A-Za-z0-9_.-]+)/i) || href.match(/([A-Za-z0-9_-]{8,})$/);
    const codexThreadId = row.getAttribute("data-app-action-sidebar-thread-id") || "";
    const fallbackId = row.getAttribute("data-session-id") || row.getAttribute("data-testid") || "";
    const placeholderThreadId = isClientNewThreadId(codexThreadId);
    const hrefId = idMatch && idMatch[1];
    const canonicalHrefId = normalizedCodexThreadUuid(hrefId);
    const hrefIsTemporary = isClientNewThreadId(href)
      || isClientNewThreadId(hrefId)
      || /(?:^|[=/])(?:local:)?client-new-thread:/i.test(href);
    const sessionId = placeholderThreadId
      ? canonicalHrefId || (!hrefIsTemporary ? reactConversationIdFromRow(row) : "")
      : normalizedCodexThreadUuid(codexThreadId)
        || canonicalHrefId
        || codexThreadId
        || hrefId
        || fallbackId;
    const titleNode = row.querySelector(`${selectors.threadTitle}, .truncate.select-none, .truncate.text-base`);
    const rawTitle = (titleNode?.textContent || (titleNode ? "" : (row.textContent || "Untitled session")));
    const title = (titleNode ? rawTitle : rawTitle.replace(/\s*(导出|删除|移动|移出项目)(\s*(导出|删除|移动|移出项目))*$/g, "")).trim().slice(0, 160);
    return { session_id: sessionId, title };
  }

  if (window.__CODEX_PLUS_TEST_SESSION_REF__) {
    window.__codexPlusSessionRefTest = {
      fromRow: sessionRefFromRow,
    };
  }

  function threadIdBadgeTitleNode(row) {
    return row.querySelector(`${selectors.threadTitle}, .truncate.select-none, .truncate.text-base`);
  }

  function padThreadIdBadgePart(value) {
    return String(value).padStart(2, "0");
  }

  function threadIdBadgeCreatedAt(sessionId) {
    const timestampMs = uuidV7TimestampMs(sessionId);
    const minReasonableMs = Date.UTC(2020, 0, 1);
    const maxReasonableMs = Date.now() + 366 * 24 * 60 * 60 * 1000;
    if (!timestampMs || timestampMs < minReasonableMs || timestampMs > maxReasonableMs) return null;
    return new Date(timestampMs);
  }

  function formatThreadIdBadgeCreatedAt(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
    return `${padThreadIdBadgePart(date.getMonth() + 1)}-${padThreadIdBadgePart(date.getDate())} ${padThreadIdBadgePart(date.getHours())}:${padThreadIdBadgePart(date.getMinutes())}`;
  }

  function threadIdBadgeMeta(sessionId) {
    const id = sessionKey(sessionId);
    const compact = id.replaceAll("-", "");
    const shortId = compact.slice(0, 8);
    const createdAt = threadIdBadgeCreatedAt(sessionId);
    const createdLabel = formatThreadIdBadgeCreatedAt(createdAt);
    return {
      id,
      shortId,
      createdAt,
      label: shortId ? `[${shortId}${createdLabel ? ` ${createdLabel}` : ""}]` : "",
    };
  }

  function wrapThreadTitleForBadge(row, titleNode) {
    const parent = titleNode?.parentElement;
    if (!parent) return null;
    if (parent.dataset?.codexThreadIdBadgeWrap === "true") return parent;
    const wrapper = document.createElement("span");
    wrapper.dataset.codexThreadIdBadgeWrap = "true";
    parent.insertBefore(wrapper, titleNode);
    wrapper.appendChild(titleNode);
    return wrapper;
  }

  function removeThreadIdBadges(root = document) {
    root.querySelectorAll?.(`.${threadIdBadgeClass}`).forEach((badge) => badge.remove());
    root.querySelectorAll?.('[data-codex-thread-id-badge-wrap="true"]').forEach((wrapper) => {
      const parent = wrapper.parentElement;
      if (!parent) return;
      while (wrapper.firstChild) parent.insertBefore(wrapper.firstChild, wrapper);
      wrapper.remove();
    });
    const rows = root.matches?.(selectors.sidebarThread) ? [root] : Array.from(root.querySelectorAll?.(selectors.sidebarThread) || []);
    rows.forEach((row) => {
      delete row.dataset.codexThreadIdBadge;
      delete row.dataset.codexThreadIdBadgeVersion;
    });
  }

  function installThreadIdBadge(row) {
    const ref = sessionRefFromRow(row);
    if (!ref.session_id) {
      removeThreadIdBadges(row);
      return;
    }
    const meta = threadIdBadgeMeta(ref.session_id);
    const titleNode = threadIdBadgeTitleNode(row);
    if (!meta.label || !titleNode) {
      removeThreadIdBadges(row);
      return;
    }

    const wrapper = wrapThreadTitleForBadge(row, titleNode);
    if (!wrapper) return;

    let badge = wrapper.querySelector(`.${threadIdBadgeClass}`);
    if (!badge) {
      badge = document.createElement("span");
      badge.className = threadIdBadgeClass;
      wrapper.insertBefore(badge, titleNode);
    }

    badge.dataset.codexThreadIdBadgeVersion = codexThreadIdBadgeVersion;
    if (badge.textContent !== meta.label) badge.textContent = meta.label;
    const fullTitle = meta.createdAt
      ? `${meta.label}\nSession ID: ${meta.id}\nCreated: ${meta.createdAt.toLocaleString()}`
      : `${meta.label}\nSession ID: ${meta.id}`;
    badge.setAttribute("title", fullTitle);
    badge.setAttribute("aria-label", fullTitle);
    row.dataset.codexThreadIdBadge = meta.label;
    row.dataset.codexThreadIdBadgeVersion = codexThreadIdBadgeVersion;
  }

  function refreshThreadIdBadges() {
    if (!codexPlusSettings().threadIdBadge) {
      if (threadIdBadgeActive) {
        removeThreadIdBadges();
        threadIdBadgeActive = false;
      }
      return;
    }
    threadIdBadgeActive = true;
    sessionRows().forEach(installThreadIdBadge);
  }

  function codexPlusDiagnosticPayload(event, detail) {
    return {
      event,
      detail: detail || {},
      helperBase,
      hasBridge: !!window.__codexSessionDeleteBridge,
      location: window.location?.href || "",
      userAgent: navigator.userAgent || "",
      timestamp: new Date().toISOString(),
    };
  }

  function sendCodexPlusDiagnostic(event, detail) {
    const payload = codexPlusDiagnosticPayload(event, detail);
    if (window.__CODEX_PLUS_TEST_SERVICE_TIER__) {
      window.__codexPlusServiceTierTestDiagnostics = window.__codexPlusServiceTierTestDiagnostics || [];
      window.__codexPlusServiceTierTestDiagnostics.push(payload);
      return;
    }
    if (window.__codexSessionDeleteBridge) {
      window.__codexSessionDeleteBridge("/diagnostics/log", payload).catch(() => {});
    }
    const body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon(`${helperBase}/diagnostics/log`, blob)) return;
      }
    } catch (_) {}
    fetch(`${helperBase}/diagnostics/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  }

  sendCodexPlusDiagnostic("script_loaded", {
    version: codexPlusVersion,
    build: codexPlusBuild,
  });

  function locationThreadId() {
    const source = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    const match = source.match(/(?:session|conversation|thread)(?:\/|=|:|-)([A-Za-z0-9_.-]+)/i)
      || source.match(/\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[/?#]|$)/)
      || source.match(/\/([A-Za-z0-9_-]{24,})(?:[/?#]|$)/);
    return match ? decodeURIComponent(match[1]) : "";
  }

  function finiteNonNegativeNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
  }

  function finiteScrollNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  function validThreadScrollSessionKey(sessionId) {
    const key = sessionKey(sessionId);
    if (!key || key === "__proto__" || key === "prototype" || key === "constructor") return "";
    return /^[A-Za-z0-9_.-]{8,128}$/.test(key) ? key : "";
  }

  function currentSessionRef() {
    const rows = sessionRows();
    for (const row of rows) {
      const ref = sessionRefFromRow(row);
      if (ref.session_id && isCurrentSessionRow(row, ref)) return ref;
    }
    return { session_id: locationThreadId(), title: "" };
  }

  function readThreadScrollEntries() {
    if (window.__codexThreadScrollEntries && typeof window.__codexThreadScrollEntries === "object") {
      return { ...window.__codexThreadScrollEntries };
    }
    try {
      const parsed = JSON.parse(localStorage.getItem(codexThreadScrollKey) || "{}");
      const rawEntries = parsed?.version === codexThreadScrollVersion && parsed?.entries && typeof parsed.entries === "object"
        ? parsed.entries
        : parsed && typeof parsed === "object"
          ? parsed
          : {};
      const entries = Object.create(null);
      Object.entries(rawEntries).forEach(([key, value]) => {
        const safeKey = validThreadScrollSessionKey(key);
        if (!safeKey || !value || typeof value !== "object") return;
        entries[safeKey] = {
          top: finiteScrollNumber(value.top),
          scrollHeight: finiteNonNegativeNumber(value.scrollHeight),
          clientHeight: finiteNonNegativeNumber(value.clientHeight),
          at: finiteNonNegativeNumber(value.at),
        };
      });
      window.__codexThreadScrollEntries = entries;
      return { ...entries };
    } catch {
      window.__codexThreadScrollEntries = Object.create(null);
      return {};
    }
  }

  function writeThreadScrollEntries(entries) {
    const pruned = Object.create(null);
    Object.entries(entries || {})
      .sort((left, right) => finiteNonNegativeNumber(right[1]?.at) - finiteNonNegativeNumber(left[1]?.at))
      .slice(0, codexThreadScrollMaxEntries)
      .forEach(([key, value]) => {
        const safeKey = validThreadScrollSessionKey(key);
        if (safeKey) pruned[safeKey] = value;
      });
    window.__codexThreadScrollEntries = pruned;
    const payload = JSON.stringify({ version: codexThreadScrollVersion, entries: pruned });
    try {
      localStorage.setItem(codexThreadScrollKey, payload);
    } catch {
      // 本地存储配额已满时不能把异常抛到页面全局，否则滚动保存会把渲染进程打进刷新循环。
      try {
        const newestKey = Object.keys(pruned)[0];
        const emergency = Object.create(null);
        if (newestKey) emergency[newestKey] = pruned[newestKey];
        window.__codexThreadScrollEntries = emergency;
        localStorage.removeItem(codexThreadScrollKey);
        localStorage.setItem(codexThreadScrollKey, JSON.stringify({ version: codexThreadScrollVersion, entries: emergency }));
      } catch {
        try { localStorage.removeItem(codexThreadScrollKey); } catch { /* 放弃持久化，内存副本仍可用 */ }
      }
    }
  }

