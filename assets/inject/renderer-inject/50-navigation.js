            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">Fast 按钮</div><div class="codex-plus-row-description">显示服务模式切换按钮；Fast 仅支持 ${codexServiceTierFastModelListLabel()}，其他模型按 Standard 发送。</div></div>
              <button type="button" class="codex-plus-toggle" data-codex-plus-setting="serviceTierControls"><span></span></button>
            </div>
            ${codexPlusIsWindowsPlatform ? `<div class="codex-plus-row">
              <div><div class="codex-plus-row-title">桌宠跟随真实鼠标</div><div class="codex-plus-row-description">仅支持 V2 桌宠；不会修改宠物文件。将 V2 的 Computer Use 光标朝向动作映射到真实鼠标，V1 开启后安全不生效；拖拽、原生悬停或 Computer Use 活跃时自动让步。</div></div>
              <button type="button" class="codex-plus-toggle" data-codex-plus-setting="petRealMouseLook"><span></span></button>
            </div>` : ""}
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">悬浮球 · Stepwise</div><div class="codex-plus-row-description">生成下一步建议。</div></div>
              <button type="button" class="codex-plus-toggle" data-codex-plus-setting="stepwise"><span></span></button>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">悬浮球 · 回答大纲</div><div class="codex-plus-row-description">整理回答结构。</div></div>
              <button type="button" class="codex-plus-toggle" data-codex-plus-setting="answerOutline"><span></span></button>
            </div>
            <div class="codex-plus-row" data-codex-service-tier-controls="true">
              <div><div class="codex-plus-row-title">服务模式</div><div class="codex-plus-row-description">继承优先读取 Codex 应用内设置，其次读取 config.toml 的 service_tier；全局模式覆盖全部 thread；自定义允许按 thread 覆盖。</div></div>
              <div class="codex-plus-service-tier-control">
                <div class="codex-plus-service-tier-status" data-codex-service-tier-status="true" data-status="loading">正在读取…</div>
                <div class="codex-plus-service-tier-actions">
                  <button type="button" class="codex-plus-service-tier-button" data-codex-service-tier-inherit="true">继承</button>
                  <button type="button" class="codex-plus-service-tier-button" data-codex-service-tier-standard="true">全局 Standard</button>
                  <button type="button" class="codex-plus-service-tier-button" data-codex-service-tier-fast="true">全局 Fast</button>
                  <button type="button" class="codex-plus-service-tier-button" data-codex-service-tier-custom="true">自定义</button>
                </div>
                <div class="codex-plus-service-tier-actions codex-plus-service-tier-thread-actions">
                  <span class="codex-plus-service-tier-thread-label">当前 thread 覆盖</span>
                  <button type="button" class="codex-plus-service-tier-button" data-codex-service-tier-thread-inherit="true" title="当前 thread 不单独覆盖，继承 Codex 默认设置">继承</button>
                  <button type="button" class="codex-plus-service-tier-button" data-codex-service-tier-thread-standard="true" title="仅当前 thread 使用 Standard，并切到自定义模式">Standard</button>
                  <button type="button" class="codex-plus-service-tier-button" data-codex-service-tier-thread-fast="true" title="仅当前 thread 使用 Fast，并切到自定义模式">Fast</button>
                </div>
              </div>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">会话删除</div><div class="codex-plus-row-description">在会话列表悬停显示删除按钮，并支持撤销。</div></div>
              <button type="button" class="codex-plus-toggle" data-codex-plus-setting="sessionDelete"><span></span></button>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">Markdown 导出</div><div class="codex-plus-row-description">在会话列表显示导出按钮，按本地 rollout 导出带时间戳的 Markdown。</div></div>
              <button type="button" class="codex-plus-toggle" data-codex-plus-setting="markdownExport"><span></span></button>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">粘贴修复</div><div class="codex-plus-row-description">从 Word 等富文本来源粘贴到 Codex composer 时只保留纯文本，避免被识别为图片/文件附件。需重启 Codex 才生效。</div></div>
              <button type="button" class="codex-plus-toggle" data-codex-plus-setting="pasteFix"><span></span></button>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">会话 ID 标识</div><div class="codex-plus-row-description">在侧边栏会话标题前显示短 ID 和 UUIDv7 创建时间，方便定位历史会话。</div></div>
              <button type="button" class="codex-plus-toggle" data-codex-plus-setting="threadIdBadge"><span></span></button>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">对话居中宽度</div><div class="codex-plus-row-description">开启后把主对话和输入框限制到固定最大宽度，适合大屏阅读。</div></div>
              <div class="codex-plus-width-control">
                <input class="codex-plus-width-input" data-codex-plus-conversation-view-width="true" min="${conversationViewMinWidth}" max="${conversationViewMaxAllowedWidth}" step="10" type="number" value="${conversationViewWidth()}">
                <button type="button" class="codex-plus-toggle" data-codex-plus-setting="conversationView"><span></span></button>
              </div>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">切换对话保留位置</div><div class="codex-plus-row-description">开启后在不同 thread 之间切换时恢复到上一次浏览位置，不再自动跳到底部。</div></div>
              <button type="button" class="codex-plus-toggle" data-codex-plus-setting="threadScrollRestore"><span></span></button>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">Zed Remote open</div><div class="codex-plus-row-description">Open supported remote SSH file references in Zed without patching Codex.app.</div></div>
              <button type="button" class="codex-plus-toggle" data-codex-plus-setting="zedRemoteOpen"><span></span></button>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">Upstream worktree</div><div class="codex-plus-row-description">Create a Git worktree from a fresh upstream branch, equivalent to git worktree add -b branch path upstream/base.</div></div>
              <div class="codex-plus-worktree-actions">
                <button type="button" class="codex-plus-action-button" data-codex-upstream-worktree-open="true">创建</button>
                <button type="button" class="codex-plus-toggle" data-codex-plus-setting="upstreamWorktreeCreate"><span></span></button>
              </div>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">历史会话修复</div><div class="codex-plus-row-description">切换官方登录、混合 API 或纯 API 后，让旧对话重新显示在当前模式下。</div></div>
              <button type="button" class="codex-plus-toggle" data-codex-backend-setting="providerSyncEnabled"><span></span></button>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">页面增强模式</div><div class="codex-plus-row-description">${codexPlusBackendSettings.launchMode === "relay" ? "兼容增强：保留会话删除、导出和用户拓展，仅关闭插件市场相关增强。" : "完整增强：加载插件市场、会话管理等全部页面能力。"}</div></div>
              <button type="button" class="codex-plus-action-button" data-codex-open-manager="true">打开管理工具</button>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">打开 DevTools</div><div class="codex-plus-row-description">打开当前 Codex 页面开发者工具，方便查看用户拓展报错。</div></div>
              <button type="button" class="codex-plus-action-button" data-codex-open-devtools="true">打开 DevTools</button>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">关于 Codex++</div><div class="codex-plus-about">Codex++ 是通过外部 launcher 注入的增强菜单，不修改 Codex App 原始安装文件。<br>Build: <span data-codex-plus-build="true">${codexPlusBuild}</span><br>GitHub: <a href="https://github.com/BigPizzaV3/CodexPlusPlus" target="_blank" rel="noreferrer">https://github.com/BigPizzaV3/CodexPlusPlus</a><br>Discord: <a href="https://discord.gg/y96kX7A76v" target="_blank" rel="noreferrer">https://discord.gg/y96kX7A76v</a><br>Telegram: <a href="https://t.me/CodexPlusPlus" target="_blank" rel="noreferrer">https://t.me/CodexPlusPlus</a></div></div>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">Discord 社区</div><div class="codex-plus-row-description">加入 Discord 获取更新消息、反馈问题或交流使用体验。</div></div>
              <button type="button" class="codex-plus-action-button" data-codex-plus-discord="true">打开 Discord</button>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">Telegram 频道</div><div class="codex-plus-row-description">加入 Telegram 获取更新消息和交流使用体验。</div></div>
              <button type="button" class="codex-plus-action-button" data-codex-plus-telegram="true">打开 Telegram</button>
            </div>
            <div class="codex-plus-row">
              <div><div class="codex-plus-row-title">提出问题</div><div class="codex-plus-row-description">打开 GitHub Issues 反馈问题或建议。</div></div>
              <button type="button" class="codex-plus-issue-button" data-codex-plus-issue="true">提出问题</button>
            </div>
            <div class="codex-plus-row codex-plus-api-key-section">
              <div class="codex-plus-api-key-copy">
                <div class="codex-plus-row-title">当前供应商 API Key</div>
                <div class="codex-plus-row-description" data-codex-relay-api-key-summary="true">正在读取当前供应商…</div>
              </div>
              <div class="codex-plus-api-key-list" data-codex-relay-api-key-list="true"></div>
            </div>
            ${renderCodexPlusExtensionMenuRows()}
          </div>
          <div class="codex-plus-panel" data-codex-plus-panel="${codexPlusExtensionsTab}" hidden>
            <div class="codex-plus-extensions-detail" data-codex-plus-extensions-detail="true">${pageMode ? renderCodexPlusExtensionsDetail() : ""}</div>
          </div>
          <div class="codex-plus-panel" data-codex-plus-panel="sponsor" hidden>
            <div class="codex-plus-sponsor-text">以下推荐来自支持 Codex++ 继续维护的合作方。</div>
            <div class="codex-plus-ad-remote">
              ${renderCodexPlusAds()}
            </div>
          </div>
        </div>
      </div>
    `;
    const closeButton = overlay.querySelector(".codex-plus-modal-close");
    closeButton?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      overlay.remove();
      if (pageMode) setCodexPlusSidebarNavActive(false);
    }, true);
    overlay.addEventListener("input", (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const searchInput = target?.closest("[data-codex-extensions-search]");
      if (searchInput) {
        codexPlusExtensionsQuery = searchInput.value;
        // 只重绘列表，不重建输入框本身，否则每敲一个字就丢焦点。
        const body = document.querySelector("[data-codex-plus-page-nav-body]");
        if (body) {
          body.innerHTML = renderCodexPlusExtensionsNav();
          const next = body.querySelector("[data-codex-extensions-search]");
          if (next) {
            next.focus();
            next.setSelectionRange(next.value.length, next.value.length);
          }
        }
        return;
      }
      const widthInput = target?.closest("[data-codex-plus-conversation-view-width]");
      if (widthInput) setConversationViewWidth(widthInput.value);
    }, true);
    overlay.addEventListener("change", (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      const widthInput = target?.closest("[data-codex-plus-conversation-view-width]");
      if (widthInput) {
        const width = normalizeConversationViewWidth(widthInput.value);
        widthInput.value = String(width || conversationViewWidth());
        setConversationViewWidth(widthInput.value);
      }
    }, true);
    overlay.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : event.target?.parentElement;
      // 拓展注册的菜单项。放在最前面是因为它的判定完全基于自己的 data 属性，
      // 与下面那些内置分支不会重叠；万一将来重叠，也应当由拓展优先拿到。
      if (handleCodexPlusExtensionMenuClick(target)) return;
      // 左面板的分组导航（仅拓展页有左面板）。
      const pageNav = target?.closest("[data-codex-plus-page-nav]");
      if (pageNav) {
        selectCodexPlusTab(pageNav.getAttribute("data-codex-plus-page-nav"));
        return;
      }
      if (target?.closest("[data-codex-open-devtools]")) {
        postJson("/devtools/open", {});
        return;
      }
      if (target?.closest("[data-codex-open-manager]")) {
        openManagerFromCodex();
        return;
      }
      // 推荐卡片用 window.open 而非原生 <a target="_blank">：Codex 是 Electron
      // 应用，原生新窗口跳转在它的 webview 里不会交给系统浏览器（同页的
      // Discord / Telegram / Issues 按钮也一律走 window.open）。
      const adCard = target?.closest("[data-codex-plus-ad-url]");
      if (adCard) {
        const adUrl = adCard.getAttribute("data-codex-plus-ad-url") || "";
        if (/^https?:\/\//i.test(adUrl)) {
          event.preventDefault();
          window.open(adUrl, "_blank", "noopener,noreferrer");
        }
        return;
      }
      if (target?.closest("[data-codex-plus-discord]")) {
        window.open("https://discord.gg/y96kX7A76v", "_blank");
        return;
      }
      if (target?.closest("[data-codex-plus-telegram]")) {
        window.open("https://t.me/CodexPlusPlus", "_blank");
        return;
      }
      const issueButton = target?.closest("[data-codex-plus-issue]");
      if (issueButton) {
        const issueUrl = "https://github.com/BigPizzaV3/CodexPlusPlus/issues";
        window.open(issueUrl, "_blank");
        return;
      }
      const apiKeySelect = target?.closest("[data-codex-relay-api-key-select]");
      if (apiKeySelect) {
        void selectRelayApiKey(apiKeySelect.value);
        return;
      }
      if (target?.closest("[data-codex-service-tier-inherit]")) {
        setCodexServiceTierControlMode("inherit");
        return;
      }
      if (target?.closest("[data-codex-service-tier-standard]")) {
        setCodexServiceTierControlMode("global-standard");
        return;
      }
      if (target?.closest("[data-codex-service-tier-fast]")) {
        setCodexServiceTierControlMode("global-fast");
        return;
      }
      if (target?.closest("[data-codex-service-tier-custom]")) {
        setCodexServiceTierControlMode("custom");
        return;
      }
      if (target?.closest("[data-codex-service-tier-thread-inherit]")) {
        setCodexThreadServiceTierMode("inherit");
        return;
      }
      if (target?.closest("[data-codex-service-tier-thread-standard]")) {
        setCodexThreadServiceTierMode("standard");
        return;
      }
      if (target?.closest("[data-codex-service-tier-thread-fast]")) {
        setCodexThreadServiceTierMode("fast");
        return;
      }
      const userScriptToggle = target?.closest("[data-codex-user-script-key]");
      if (userScriptToggle) {
        loadUserScripts("/user-scripts/set-script-enabled", { key: userScriptToggle.getAttribute("data-codex-user-script-key"), enabled: userScriptToggle.dataset.enabled !== "true" });
        return;
      }
      // 市场条目的「安装」。id 挂在行/按钮上，点按钮才算。
      const marketInstall = target?.closest("[data-codex-market-install]");
      if (marketInstall) {
        void installScriptFromMarket(marketInstall.getAttribute("data-codex-market-install"));
        return;
      }
      const extensionsRefresh = target?.closest("[data-codex-market-refresh]");
      if (extensionsRefresh) {
        void loadScriptMarket(true);
        return;
      }
      const extensionsUninstall = target?.closest("[data-codex-extensions-uninstall]");
      if (extensionsUninstall) {
        void uninstallUserScript(extensionsUninstall.getAttribute("data-codex-extensions-uninstall"));
        return;
      }
