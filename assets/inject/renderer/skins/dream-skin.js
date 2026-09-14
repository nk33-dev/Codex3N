  // Dream skin runtime is adapted from Fei-Away/Codex-Dream-Skin's renderer injection.
  function dreamSkinStylePreset(id, stylePreset) {
    const preset = String(stylePreset || "").trim();
    if (preset && preset !== "dream-original") return preset;
    return ({
      "caishen-lite": "caishen-lite",
      "caishen-max": "caishen-max",
      "caishen-readable": "caishen-readable",
      "export-night": "export-night",
      "global-founder-bright": "global-founder-bright",
      "mythic-guardian-noir": "mythic-guardian-noir",
      "codex-snow-skin": "codex-snow",
      "glass-vision": "glass-vision",
      "preset-midnight-aurora": "midnight-aurora",
      "preset-amber-dusk": "amber-dusk",
      "preset-forest-mist": "forest-mist",
      "preset-cyber-neon": "cyber-neon",
      "preset-sakura-dawn": "sakura-dawn",
    })[String(id || "").trim()] || "dream-original";
  }

  function dreamSkinThemeConfig(theme) {
    const fallback = window.__CODEX_PLUS_DREAM_SKIN_THEME__ || {};
    const value = theme && typeof theme === "object" ? theme : fallback;
    const colors = value.colors && typeof value.colors === "object" ? value.colors : fallback.colors || {};
    return {
      schemaVersion: value.schemaVersion === 1 ? 1 : 1,
      id: String(value.id || fallback.id || "custom"),
      name: String(value.name || fallback.name || "Dream Skin"),
      stylePreset: dreamSkinStylePreset(
        value.id || fallback.id,
        value.stylePreset || fallback.stylePreset,
      ),
      brandSubtitle: String(value.brandSubtitle || fallback.brandSubtitle || "CODEX DREAM SKIN"),
      statusText: String(value.statusText || fallback.statusText || "DREAM SKIN ONLINE"),
      quote: String(value.quote || fallback.quote || "MAKE SOMETHING WONDERFUL"),
      tagline: String(value.tagline || fallback.tagline || "把喜欢的画面变成可交互的 Codex 工作台。"),
      projectPrefix: String(value.projectPrefix || fallback.projectPrefix || "选择项目 · "),
      projectLabel: String(value.projectLabel || fallback.projectLabel || "◉  选择项目"),
      colors: { ...(fallback.colors || {}), ...colors },
    };
  }

  function dreamSkinCssString(value) {
    return JSON.stringify(String(value ?? ""));
  }

  function dreamSkinParseRgb(value) {
    if (!value || value === "transparent") return null;
    const text = String(value).trim();
    const hex = text.match(/^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
    if (hex) {
      const normalized = hex.length === 3
        ? hex.split("").map((part) => `${part}${part}`).join("")
        : hex.slice(0, 6);
      return {
        r: Number.parseInt(normalized.slice(0, 2), 16),
        g: Number.parseInt(normalized.slice(2, 4), 16),
        b: Number.parseInt(normalized.slice(4, 6), 16),
      };
    }
    const match = text.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (!match) return null;
    return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
  }

  function dreamSkinLuminance({ r, g, b }) {
    const linear = [r, g, b].map((color) => {
      const value = color / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  }

  const codexPlusDreamSkinMainSurfaceMarker = "data-codex-plus-dream-skin-main-surface";

  function ensureDreamSkinMainSurface() {
    const existing = document.querySelector("main.main-surface");
    if (existing) return existing;

    const modularSurface = document.querySelector('main[class*="_MainContentSurface_"]');
    const mainCandidates = modularSurface ? [] : [...document.querySelectorAll("main")];
    const shellMain = modularSurface || (mainCandidates.length === 1 ? mainCandidates[0] : null);
    if (!shellMain) return null;

    shellMain.classList.add("main-surface");
    shellMain.setAttribute(codexPlusDreamSkinMainSurfaceMarker, "true");
    return shellMain;
  }

  function clearDreamSkinMainSurfaceCompatibility() {
    document.querySelectorAll(`main[${codexPlusDreamSkinMainSurfaceMarker}="true"]`).forEach((node) => {
      node.classList.remove("main-surface");
      node.removeAttribute(codexPlusDreamSkinMainSurfaceMarker);
    });
  }

  function detectDreamSkinShellMode() {
    const root = document.documentElement;
    const body = document.body;
    const classText = `${root?.className || ""} ${body?.className || ""}`.toLowerCase();

    if (/\b(dark|theme-dark|appearance-dark)\b/.test(classText)) return "dark";
    if (/\b(light|theme-light|appearance-light)\b/.test(classText)) return "light";

    const dataTheme = (
      root?.getAttribute("data-theme") ||
      root?.getAttribute("data-appearance") ||
      root?.getAttribute("data-color-mode") ||
      body?.getAttribute("data-theme") ||
      body?.getAttribute("data-appearance") ||
      ""
    ).toLowerCase();
    if (dataTheme.includes("dark")) return "dark";
    if (dataTheme.includes("light")) return "light";

    const checked = document.querySelector('input[name="appearance-theme"]:checked');
    if (checked) {
      const label = (checked.getAttribute("aria-label") || checked.value || "").toLowerCase();
      if (label.includes("暗") || label.includes("dark")) return "dark";
      if (label.includes("浅") || label.includes("light")) return "light";
      if (label.includes("系统") || label.includes("system")) {
        return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
      }
    }

    try {
      const colorScheme = getComputedStyle(root).colorScheme || "";
      if (colorScheme.includes("dark") && !colorScheme.includes("light")) return "dark";
      if (colorScheme.includes("light") && !colorScheme.includes("dark")) return "light";
    } catch {
    }

    const samples = [
      body,
      ensureDreamSkinMainSurface(),
      document.querySelector("aside.app-shell-left-panel"),
    ].filter(Boolean);
    let lightVotes = 0;
    let darkVotes = 0;
    for (const element of samples) {
      try {
        const rgb = dreamSkinParseRgb(getComputedStyle(element).backgroundColor);
        if (!rgb) continue;
        const luminance = dreamSkinLuminance(rgb);
        if (luminance >= 0.55) lightVotes += 1;
        else if (luminance <= 0.25) darkVotes += 1;
      } catch {
      }
    }
    if (lightVotes > darkVotes) return "light";
    if (darkVotes > lightVotes) return "dark";

    try {
      if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    } catch {
    }
    return "light";
  }

  function dreamSkinThemeShellMode(theme) {
    const background = dreamSkinParseRgb(theme?.colors?.background);
    if (background) return dreamSkinLuminance(background) < 0.36 ? "dark" : "light";
    return detectDreamSkinShellMode();
  }

  function dreamSkinArtBlobUrl(artDataUrl) {
    if (!artDataUrl || !artDataUrl.startsWith("data:")) return "";
    const comma = artDataUrl.indexOf(",");
    if (comma < 0) return "";
    const mime = /^data:([^;,]+)/.exec(artDataUrl)?.[1] || "image/png";
    const binary = atob(artDataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  }

  function independentThemeDescriptor(stylePreset) {
    const custom = (name, chromeMarkup) => ({
      rootClass: `codex-theme-${name}`,
      homeClass: `theme-${name}-home`,
      shellClass: `theme-${name}-home-shell`,
      chromeId: "codex-theme-chrome",
      chromeClass: `theme-chrome-${name}`,
      chromeMarkup,
    });
    const descriptors = {
      "caishen-lite": custom("caishen-lite", `
        <div class="csl-caption" data-theme-field="name"></div><div class="csl-seal">吉</div>`),
      "caishen-max": custom("caishen-max", `
        <div class="csm-banner" data-theme-field="name"></div><div class="csm-coins">◇ ◇ ◇</div>`),
      "caishen-readable": custom("caishen-readable", ""),
      "export-night": custom("export-night", `
        <div class="exn-titlebar"><span data-theme-field="name"></span><span class="exn-cursor">█</span></div>`),
      "global-founder-bright": custom("global-founder-bright", `
        <div class="gfb-masthead"><span data-theme-field="name"></span><small data-theme-field="status"></small></div>`),
      "mythic-guardian-noir": custom("mythic-guardian-noir", `
        <div class="mgn-sigil"></div><div class="mgn-line"></div>`),
      "midnight-aurora": custom("midnight-aurora", `
        <div class="mda-arc"></div><div class="mda-star">✦</div>`),
      "amber-dusk": custom("amber-dusk", `
        <div class="abd-sun"></div><div class="abd-horizon"></div>`),
      "forest-mist": custom("forest-mist", `
        <div class="fm-branch"></div><div class="fm-leaf">⌁</div>`),
      "cyber-neon": custom("cyber-neon", `
        <div class="cn-index" data-theme-field="status"></div><div class="cn-scan"></div>`),
      "sakura-dawn": custom("sakura-dawn", `
        <div class="sd-petal">✿</div><div class="sd-rule"></div>`),
      "codex-snow": {
        rootClass: "codex-dream-skin",
        homeClass: "dream-home",
        shellClass: "dream-home-shell",
        chromeId: "codex-dream-skin-chrome",
        chromeClass: "",
        chromeMarkup: `
          <div class="dream-brand"><span class="dream-note">SKI</span><span><b>Snowline Codex</b><small>ice-blue training mode</small></span></div>
          <div class="dream-signature">Freeski focus</div>
          <div class="dream-sparkles"><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <div class="dream-ribbon"><span>slopestyle</span><strong>double cork energy</strong><span>halfpipe</span></div>
          <div class="dream-polaroid"></div>`,
      },
      "glass-vision": {
        rootClass: "codex-glass-vision-skin",
        homeClass: "glass-vision-home",
        shellClass: "glass-vision-home-shell",
        taskShellClass: "glass-vision-task-shell",
        chromeId: "codex-glass-vision-skin-chrome",
        chromeClass: "",
        chromeMarkup: `
          <div class="glass-vision-brand"><span class="glass-vision-orbit-mark"><i></i></span><span><b>GLASS VISION</b><small>SILVER BLUE · CELESTIAL</small></span></div>
          <div class="glass-vision-status"><i></i><span>CRYSTAL FIELD</span></div>
          <div class="glass-vision-atmosphere"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <div class="glass-vision-orbit-lines"><i></i><i></i><i></i></div><div class="glass-vision-prism"></div>`,
      },
    };
    if (descriptors[stylePreset]) return descriptors[stylePreset];
    if (codexPlusDreamSkinPlatform === "windows") {
      return {
        rootClass: "codex-dream-skin",
        homeClass: "dream-home",
        shellClass: "dream-home-shell",
        taskClass: "dream-task",
        chromeId: "codex-dream-skin-chrome",
        chromeClass: "",
        chromeMarkup: "",
      };
    }
    return {
      rootClass: "codex-dream-skin",
      homeClass: "dream-skin-home",
      shellClass: "dream-skin-home-shell",
      chromeId: "codex-dream-skin-chrome",
      chromeClass: "",
      chromeMarkup: `
        <div class="dream-skin-brand"><span class="dream-skin-portal-mark">◉</span><span><b data-theme-field="name"></b><small data-theme-field="subtitle"></small></span></div>
        <div class="dream-skin-status"><i></i><span data-theme-field="status"></span></div>
        <div class="dream-skin-quote" data-theme-field="quote"></div>
        <div class="dream-skin-particles"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><div class="dream-skin-orbit"></div>`,
    };
  }

  const dreamSkinCompanionId = "codex-dream-skin-companion";
  const dreamSkinCompanionDataUrlPrefixes = [
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
    "data:image/webp;base64,",
    "data:image/gif;base64,",
  ];
  const dreamSkinCompanionBase64Pattern = /^[a-z0-9+/=\s]+$/i;

  function removeDreamSkinCompanion() {
    document.getElementById(dreamSkinCompanionId)?.remove();
  }

  function dreamSkinCompanionConfig(theme) {
    const companion = theme && theme.companion;
    if (!companion || typeof companion !== "object" || companion.enabled === false) return null;
    const dataUrl = typeof companion.dataUrl === "string" ? companion.dataUrl.trim() : "";
    const prefix = dreamSkinCompanionDataUrlPrefixes.find((candidate) =>
      dataUrl.toLowerCase().startsWith(candidate));
    if (
      !dataUrl
      || dataUrl.length > 240_000
      || !prefix
      || !dreamSkinCompanionBase64Pattern.test(dataUrl.slice(prefix.length))
    ) {
      return null;
    }
    const width = Math.max(48, Math.min(Number(companion.width) || 96, 160));
    const side = ["left", "right"].includes(companion.side) ? companion.side : "auto";
    const offsetX = Math.max(-48, Math.min(Number(companion.offsetX) || 0, 48));
    const offsetY = Math.max(-160, Math.min(Number(companion.offsetY) || 0, 160));
    return { dataUrl, width, side, offsetX, offsetY };
  }

  function visibleDreamSkinComposer() {
    return [...document.querySelectorAll(".composer-footer, .composer-surface-chrome")]
      .map((node) => ({ node, rect: node.getBoundingClientRect?.() }))
      .filter(({ rect }) => rect && rect.width > 200 && rect.height > 0)
      .sort((left, right) => right.rect.bottom - left.rect.bottom)[0] || null;
  }

  function ensureDreamSkinCompanion(theme) {
    const config = dreamSkinCompanionConfig(theme);
    const composer = visibleDreamSkinComposer();
    if (!config || !composer) {
      removeDreamSkinCompanion();
      return;
    }

    let companion = document.getElementById(dreamSkinCompanionId);
    if (!companion) {
      companion = document.createElement("img");
      companion.id = dreamSkinCompanionId;
      companion.alt = "";
      companion.setAttribute("aria-hidden", "true");
      Object.assign(companion.style, {
        position: "fixed",
        zIndex: "39",
        height: "auto",
        maxHeight: "160px",
        objectFit: "contain",
        pointerEvents: "none",
        userSelect: "none",
        filter: "drop-shadow(0 8px 14px rgba(0, 0, 0, .18))",
        transition: "left 160ms ease, top 160ms ease, opacity 160ms ease",
      });
      document.body.appendChild(companion);
    }
    if (companion.src !== config.dataUrl) {
      companion.onload = () => ensureDreamSkinCompanion(theme);
      companion.src = config.dataUrl;
    }

    const renderedHeight = companion.naturalWidth > 0 && companion.naturalHeight > 0
      ? Math.min(160, config.width * companion.naturalHeight / companion.naturalWidth)
      : config.width;

    const gap = 12;
    const edge = 8;
    const right = composer.rect.right + gap + config.offsetX;
    const left = composer.rect.left - config.width - gap + config.offsetX;
    const fitsRight = right + config.width <= window.innerWidth - edge;
    const fitsLeft = left >= edge;
    const useRight = config.side === "right"
      ? fitsRight
      : config.side === "left"
        ? !fitsLeft && fitsRight
        : fitsRight || !fitsLeft;

    if (!fitsRight && !fitsLeft) {
      companion.style.opacity = "0";
      return;
    }

    const top = Math.max(
      edge,
      Math.min(
        composer.rect.bottom - renderedHeight + config.offsetY,
        window.innerHeight - renderedHeight - edge,
      ),
    );
    companion.style.width = `${config.width}px`;
    companion.style.left = `${Math.round(useRight ? right : left)}px`;
    companion.style.top = `${Math.round(top)}px`;
    companion.style.opacity = "1";
  }

  function clearDreamSkinPresentation() {
    const root = document.documentElement;
    for (const className of [...(root?.classList || [])]) {
      if (
        className === "codex-dream-skin"
        || className === "codex-glass-vision-skin"
        || className.startsWith("codex-theme-")
      ) {
        root?.classList.remove(className);
      }
    }
    root?.removeAttribute("data-dream-shell");
    root?.removeAttribute("data-codex-plus-dream-skin");
    root?.style.removeProperty("--dream-art");
    root?.style.removeProperty("--dream-skin-art");
    [
      "--ds-bg",
      "--ds-panel",
      "--ds-panel-2",
      "--ds-green",
      "--ds-lime",
      "--ds-cyan",
      "--ds-purple",
      "--ds-text",
      "--ds-muted",
      "--ds-line",
      "--dream-ink",
      "--dream-purple",
      "--dream-violet",
      "--dream-pink",
      "--dream-blush",
      "--dream-pearl",
      "--dream-line",
      "--dream-skin-name",
      "--dream-skin-tagline",
      "--dream-skin-project-prefix",
      "--dream-skin-project-label",
    ].forEach((name) => root?.style.removeProperty(name));
    document.querySelectorAll(".dream-home").forEach((node) => node.classList.remove("dream-home"));
    document.querySelectorAll('[role="main"][data-dream-home-layout]').forEach((node) => {
      node.removeAttribute("data-dream-home-layout");
    });
    document.querySelectorAll(".dream-home-shell").forEach((node) => node.classList.remove("dream-home-shell"));
    document.querySelectorAll(".dream-skin-home").forEach((node) => node.classList.remove("dream-skin-home"));
    document.querySelectorAll(".dream-skin-home-shell").forEach((node) => node.classList.remove("dream-skin-home-shell"));
    document.querySelectorAll("[class]").forEach((node) => {
      for (const className of [...node.classList]) {
        if (
          /^theme-[a-z0-9-]+-(?:home|home-shell|task|task-shell)$/.test(className)
          || /^glass-vision-(?:home|home-shell|task|task-shell)$/.test(className)
        ) {
          node.classList.remove(className);
        }
      }
    });
    document.getElementById(codexPlusDreamSkinStyleId)?.remove();
    document.getElementById("codex-plus-dream-skin-style")?.remove();
    document.getElementById("codex-dream-skin-chrome")?.remove();
    document.getElementById("codex-glass-vision-skin-chrome")?.remove();
    document.getElementById("codex-theme-chrome")?.remove();
    removeDreamSkinCompanion();
    clearDreamSkinMainSurfaceCompatibility();
    const state = window.__CODEX_DREAM_SKIN_STATE__;
    const descriptor = state?.descriptor;
    if (descriptor) {
      root?.classList.remove(descriptor.rootClass);
      for (const className of [descriptor.homeClass, descriptor.shellClass, descriptor.taskClass, descriptor.taskShellClass]) {
        if (!className) continue;
        document.querySelectorAll(`.${className}`).forEach((node) => node.classList.remove(className));
      }
      document.getElementById(descriptor.chromeId)?.remove();
    }
    root?.classList.remove("dream-theme-dark", "dream-theme-light");
    root?.removeAttribute("data-codex-theme");
    root?.removeAttribute("data-codex-theme-root");
    [
      "--theme-bg", "--theme-panel", "--theme-panel-alt", "--theme-accent",
      "--theme-accent-alt", "--theme-secondary", "--theme-highlight", "--theme-text",
      "--theme-muted", "--theme-line", "--theme-art", "--glass-vision-art",
      "--dream-accent", "--dream-accent-ink",
    ].forEach((name) => root?.style.removeProperty(name));
  }

  function cleanupDreamSkin() {
    window.__CODEX_DREAM_SKIN_DISABLED__ = true;
    const state = window.__CODEX_DREAM_SKIN_STATE__;
    if (typeof state?.cleanup === "function" && state.cleanup !== cleanupDreamSkin) {
      try {
        state.cleanup();
      } catch {
      }
    }
    const remainingState = window.__CODEX_DREAM_SKIN_STATE__;
    remainingState?.observer?.disconnect();
    if (remainingState?.timer) clearInterval(remainingState.timer);
    if (remainingState?.scheduler?.timeout) clearTimeout(remainingState.scheduler.timeout);
    if (remainingState?.resizeHandler) window.removeEventListener("resize", remainingState.resizeHandler);
    if (remainingState?.mediaHandler && remainingState?.mediaQuery) {
      try {
        remainingState.mediaQuery.removeEventListener("change", remainingState.mediaHandler);
      } catch {
      }
    }
    if (remainingState?.artUrl) URL.revokeObjectURL(remainingState.artUrl);
    delete window.__CODEX_DREAM_SKIN_STATE__;
    window.__CODEX_GLASS_VISION_SKIN_DISABLED__ = true;
    const glassState = window.__CODEX_GLASS_VISION_SKIN_STATE__;
    try {
      glassState?.cleanup?.();
    } catch {
    }
    delete window.__CODEX_GLASS_VISION_SKIN_STATE__;
    clearDreamSkinPresentation();
  }

  window.__CODEX_PLUS_CLEAR_DREAM_SKIN__ = cleanupDreamSkin;

  function dreamSkinContentSignature(value) {
    const text = String(value || "");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${text.length}-${(hash >>> 0).toString(16)}`;
  }

  function applyIndependentThemeVariables(root, shell, theme, descriptor, artSource) {
    const colors = theme.colors || {};
    const accent = colors.accent || (shell === "light" ? "#d85c6c" : "#76e6cc");
    const accentAlt = colors.accentAlt || accent;
    const secondary = colors.secondary || (shell === "light" ? "#e7a3ad" : "#65bde8");
    const variables = {
      "--theme-bg": colors.background || (shell === "light" ? "#f6f3f4" : "#071116"),
      "--theme-panel": colors.panel || (shell === "light" ? "#ffffff" : "#0b1a20"),
      "--theme-panel-alt": colors.panelAlt || (shell === "light" ? "#fff8f9" : "#10272c"),
      "--theme-accent": accent,
      "--theme-accent-alt": accentAlt,
      "--theme-secondary": secondary,
      "--theme-highlight": colors.highlight || accentAlt,
      "--theme-text": colors.text || (shell === "light" ? "#201b1c" : "#edf7f3"),
      "--theme-muted": colors.muted || (shell === "light" ? "#6c6062" : "#9db7ae"),
      "--theme-line": colors.line || (shell === "light" ? "rgba(90, 64, 68, .18)" : "rgba(150, 220, 200, .24)"),
      "--theme-art": artSource,
      "--dream-art": artSource,
      "--dream-skin-art": artSource,
      "--glass-vision-art": artSource,
      "--dream-accent": accent,
      "--dream-accent-ink": colors.panel || "#ffffff",
    };
    for (const [name, value] of Object.entries(variables)) {
      if (typeof value === "string" && value) root.style.setProperty(name, value);
    }
    root.style.setProperty("--dream-skin-name", dreamSkinCssString(theme.name || "Codex Dream Skin"));
    root.style.setProperty("--dream-skin-tagline", dreamSkinCssString(theme.tagline || "把喜欢的画面变成可交互的 Codex 工作台。"));
    root.style.setProperty("--dream-skin-project-prefix", dreamSkinCssString(theme.projectPrefix || "选择项目 · "));
    root.style.setProperty("--dream-skin-project-label", dreamSkinCssString(theme.projectLabel || "◉  选择项目"));
    root.classList.toggle("dream-theme-dark", shell === "dark");
    root.classList.toggle("dream-theme-light", shell === "light");
    const preset = theme.stylePreset || "dream-original";
    if (root.getAttribute("data-codex-theme") !== preset) root.setAttribute("data-codex-theme", preset);
    if (root.getAttribute("data-codex-theme-root") !== descriptor.rootClass) {
      root.setAttribute("data-codex-theme-root", descriptor.rootClass);
    }
  }

  function installDreamSkin(settings) {
    const theme = dreamSkinThemeConfig(settings.dreamSkinThemeConfig);
    const styles = window.__CODEX_PLUS_DREAM_SKIN_STYLES__ || {};
    const descriptor = independentThemeDescriptor(theme.stylePreset);
    const cssText = String(styles[theme.stylePreset] || styles["dream-original"] || "");
    const artDataUrl = String(window.__CODEX_PLUS_DREAM_SKIN_ART__ || "");
    const themeSignature = dreamSkinContentSignature(JSON.stringify(theme));
    const artSignature = String(window.__CODEX_PLUS_DREAM_SKIN_ART_SIGNATURE__ || dreamSkinContentSignature(artDataUrl));
    const version = `codex-plus:independent:${codexPlusDreamSkinPlatform}:r${codexPlusDreamSkinRevision}:${theme.stylePreset}:${themeSignature}:${artSignature}:${cssText.length}`;
    const existingState = window.__CODEX_DREAM_SKIN_STATE__;
    if (existingState?.version === version && typeof existingState.ensure === "function") {
      window.__CODEX_DREAM_SKIN_DISABLED__ = false;
      existingState.ensure();
      return;
    }

    cleanupDreamSkin();
    window.__CODEX_DREAM_SKIN_DISABLED__ = false;
    const artUrl = dreamSkinArtBlobUrl(artDataUrl);
    const artSource = artUrl ? `url("${artUrl}")` : "none";

    const ensureStyle = (root) => {
      let style = document.getElementById(codexPlusDreamSkinStyleId);
      if (!style) {
        style = document.createElement("style");
        style.id = codexPlusDreamSkinStyleId;
        (document.head || root).appendChild(style);
      }
      if (style.dataset.independentThemeVersion !== version) {
        style.textContent = cssText;
        style.dataset.independentThemeVersion = version;
      }
    };

    const ensure = () => {
      if (window.__CODEX_DREAM_SKIN_DISABLED__) return;
      const root = document.documentElement;
      if (!root || !document.body) return;
      const shellMain = ensureDreamSkinMainSurface();
      if (!shellMain) {
        clearDreamSkinPresentation();
        return;
      }

      root.classList.add(descriptor.rootClass);
      root.setAttribute("data-codex-plus-dream-skin", "true");
      const shell = dreamSkinThemeShellMode(theme);
      root.setAttribute("data-dream-shell", shell);
      applyIndependentThemeVariables(root, shell, theme, descriptor, artSource);
      ensureStyle(root);
      ensureDreamSkinCompanion(theme);

      const homeIndicator = document.querySelector('[data-testid="home-icon"]');
      const homeCandidate = homeIndicator?.closest('[role="main"]')
        || [...document.querySelectorAll('[role="main"]')].find((candidate) =>
          candidate.querySelector('[data-feature="game-source"]')
          && candidate.querySelector('.group\\/home-suggestions'))
        || null;
      const homeHasClassicChrome = !!(
        homeCandidate
        && homeCandidate.querySelector('[data-feature="game-source"]')
        && (
          homeCandidate.querySelector('.group\\/home-suggestions')
          || homeCandidate.querySelector('[class*="home-suggestions"]')
          || homeCandidate.querySelector('[class*="_homeUtilityBar_"]')
        )
      );
      const home = homeHasClassicChrome ? homeCandidate : null;
      for (const candidate of document.querySelectorAll(`[role="main"].${descriptor.homeClass}`)) {
        if (candidate !== home && candidate !== homeCandidate) candidate.classList.remove(descriptor.homeClass);
      }
      if (home) home.classList.add(descriptor.homeClass);
      else if (homeCandidate && descriptor.homeClass) homeCandidate.classList.add(descriptor.homeClass);
      if (descriptor.taskClass) {
        for (const candidate of document.querySelectorAll('[role="main"]')) {
          candidate.classList.toggle(descriptor.taskClass, candidate !== home && candidate !== homeCandidate);
        }
      }
      for (const candidate of document.querySelectorAll('[role="main"]')) {
        if (candidate === home) {
          const hero = candidate.querySelector(':scope > div > div > div');
          const structured = !!(hero && hero.querySelector('[data-feature="game-source"], [data-testid="home-icon"]'));
          candidate.setAttribute('data-dream-home-layout', structured ? 'structured' : 'soft');
        } else {
          candidate.setAttribute('data-dream-home-layout', 'soft');
        }
      }
      shellMain.classList.toggle(descriptor.shellClass, Boolean(homeCandidate));
      if (descriptor.taskShellClass) shellMain.classList.toggle(descriptor.taskShellClass, !home);

      let chrome = document.getElementById(descriptor.chromeId);
      if (!chrome || chrome.parentElement !== document.body) {
        chrome?.remove();
        chrome = document.createElement("div");
        chrome.id = descriptor.chromeId;
        chrome.setAttribute("aria-hidden", "true");
        chrome.innerHTML = descriptor.chromeMarkup;
        document.body.appendChild(chrome);
      }
      if (chrome.className !== descriptor.chromeClass) chrome.className = descriptor.chromeClass;
      const fields = {
        name: theme.name || "Codex Dream Skin",
        subtitle: theme.brandSubtitle || "CODEX DREAM SKIN",
        status: theme.statusText || "THEME ONLINE",
        quote: theme.quote || "MAKE SOMETHING WONDERFUL",
      };
      for (const [field, value] of Object.entries(fields)) {
        const target = chrome.querySelector(`[data-theme-field="${field}"]`);
        if (target && target.textContent !== value) target.textContent = value;
      }
      const shellBox = shellMain.getBoundingClientRect();
      chrome.style.left = `${Math.round(shellBox.left)}px`;
      chrome.style.top = `${Math.round(shellBox.top)}px`;
      chrome.style.width = `${Math.round(shellBox.width)}px`;
      chrome.style.height = `${Math.round(shellBox.height)}px`;
      chrome.classList.toggle(descriptor.shellClass, Boolean(home));
      if (descriptor.taskShellClass) chrome.classList.toggle(descriptor.taskShellClass, !home);
      chrome.dataset.dreamShell = shell;
    };

    const scheduler = { timeout: null };
    const scheduleEnsure = () => {
      if (scheduler.timeout) clearTimeout(scheduler.timeout);
      scheduler.timeout = setTimeout(() => {
        scheduler.timeout = null;
        ensure();
      }, 180);
    };
    const observer = new MutationObserver(scheduleEnsure);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-appearance", "data-color-mode"],
    });
    const timer = setInterval(ensure, 4000);
    const resizeHandler = scheduleEnsure;
    window.addEventListener("resize", resizeHandler, { passive: true });

    let mediaQuery = null;
    let mediaHandler = null;
    try {
      mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaHandler = scheduleEnsure;
      mediaQuery.addEventListener("change", mediaHandler);
    } catch {
    }

    window.__CODEX_DREAM_SKIN_STATE__ = {
      ensure,
      cleanup: cleanupDreamSkin,
      observer,
      timer,
      scheduler,
      resizeHandler,
      mediaQuery,
      mediaHandler,
      artUrl,
      version,
      descriptor,
      themeId: theme.id || "custom",
      detectShellMode: detectDreamSkinShellMode,
    };
    ensure();
  }

  function refreshDreamSkin() {
    const settings = codexPlusSettings();
    if (settings.dreamSkinEnabled && !settings.dreamSkinPaused) ensureDreamSkinMainSurface();
    if (window.__CODEX_PLUS_EXTERNAL_DREAM_SKIN_RUNTIME__) {
      if (codexPlusBackendSettingsLoaded && (!settings.dreamSkinEnabled || settings.dreamSkinPaused)) {
        cleanupDreamSkin();
      } else {
        const state = window.__CODEX_DREAM_SKIN_STATE__ || window.__CODEX_GLASS_VISION_SKIN_STATE__;
        state?.ensure?.();
        ensureDreamSkinCompanion(
          window.__CODEX_PLUS_DREAM_SKIN_THEME__ || settings.dreamSkinThemeConfig,
        );
      }
      return;
    }
    if (!settings.dreamSkinEnabled || settings.dreamSkinPaused) {
      cleanupDreamSkin();
      return;
    }
    installDreamSkin(settings);
  }

  function applyDreamSkinLiveUpdate(payload) {
    if (!payload || String(payload.revision || "") !== codexPlusDreamSkinRevision) return false;
    if (typeof payload.artDataUrl === "string" && payload.artDataUrl) {
      window.__CODEX_PLUS_DREAM_SKIN_ART__ = payload.artDataUrl;
    }
    window.__CODEX_PLUS_DREAM_SKIN_ART_SIGNATURE__ = String(payload.artSignature || "");
    window.__CODEX_PLUS_DREAM_SKIN_THEME__ = payload.theme && typeof payload.theme === "object" ? payload.theme : {};
    codexPlusBackendSettings.codexAppDreamSkinEnabled = true;
    codexPlusBackendSettings.codexAppDreamSkinPaused = false;
    codexPlusBackendSettings.codexAppDreamSkinThemeConfig = window.__CODEX_PLUS_DREAM_SKIN_THEME__;
    refreshDreamSkin();
    return true;
  }

  window.__CODEX_PLUS_DREAM_SKIN_RUNTIME_REVISION__ = codexPlusDreamSkinRevision;
  window.__CODEX_PLUS_APPLY_DREAM_SKIN__ = applyDreamSkinLiveUpdate;

