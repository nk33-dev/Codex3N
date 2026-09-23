import { readFile } from "node:fs/promises";

/**
 * 注入脚本分片清单。
 *
 * `assets/inject/renderer/**` 是 `crates/codex-plus-core/src/assets.rs` 里
 * `RENDERER_SCRIPT` 用 `concat!` 拼回单份脚本的分片，运行入口只有 `assets.rs`
 * 一个。分片顺序**有意义**：整份脚本是一个共享作用域的 IIFE，`const` / `let`
 * 存在 TDZ，函数声明在 IIFE 内整体提升。
 *
 * 回归测试按字符串标记切片源码，所以必须拼回原文再切；`inject-fragments.test.ts`
 * 会校验这里的顺序与 `assets.rs` 的 `concat!` 完全一致。
 */
export const RENDERER_FRAGMENT_PATHS = [
  "renderer/shell/guard.js",
  "renderer/shell/chinese-locale.js",
  "renderer/shell/constants.js",
  "renderer/shell/image-overlay.js",
  "renderer/shell/styles.js",
  "renderer/shell/settings.js",
  "renderer/skins/dream-skin.js",
  "renderer/shell/settings-menu.js",
  "renderer/models/service-tier.js",
  "renderer/models/remote-session.js",
  "renderer/shell/backend-status.js",
  "renderer/shell/page-menu.js",
  "renderer/marketplace/plugin-bridge.js",
  "renderer/sessions/health.js",
  "renderer/sessions/rows-badge.js",
  "renderer/sessions/thread-scroll.js",
  "renderer/shell/markdown-export.js",
  "renderer/models/catalog-patch.js",
  "renderer/sessions/keys-share.js",
  "renderer/shell/upstream-worktree.js",
  "renderer/sessions/delete.js",
  "renderer/shell/conversation-targets.js",
  "renderer/models/service-tier-badge.js",
  "renderer/shell/conversation-view.js",
  "renderer/shell/scan-lightweight.js",
  "renderer/shell/usage-policy.js",
  "renderer/shell/zed-remote.js",
  "renderer/sessions/copy-menu.js",
  "renderer/sessions/scan.js",
];

/** IIFE 之外的分片：粘贴修复块。放进 IIFE 会随早返回守卫一起被跳过。 */
export const RENDERER_TRAILING_FRAGMENT_PATHS = ["renderer/shell/paste-fix.js"];

/** 悬浮球注入脚本的分片清单，对应 `assets.rs` 的 `STEPWISE_SCRIPT`。 */
export const STEPWISE_FRAGMENT_PATHS = [
  "floating-panel/runtime/state.js",
  "floating-panel/core/appearance-runtime.js",
  "floating-panel/runtime/dom.js",
  "floating-panel/runtime/bridge-client.js",
  "floating-panel/runtime/answer-context.js",
  "floating-panel/stepwise/suggestions.js",
  "floating-panel/stepwise/generation.js",
  "floating-panel/runtime/lifecycle.js",
  "floating-panel/runtime/settings.js",
  "floating-panel/core/appearance.js",
  "floating-panel/core/host.js",
  "floating-panel/core/geometry.js",
  "floating-panel/core/interaction.js",
  "floating-panel/core/views.js",
  "floating-panel/outline/parser.js",
  "floating-panel/outline/navigation.js",
  "floating-panel/outline/feature.js",
  "floating-panel/outline/view.js",
  "floating-panel/core/scroll-state.js",
  "floating-panel-inject.js",
];

const injectRoot = new URL("../../../assets/inject/", import.meta.url);

/** 注入资源路径：相对 `assets/inject/`。 */
export function injectAssetUrl(relativePath: string): URL {
  return new URL(relativePath, injectRoot);
}

async function readFragments(paths: readonly string[]): Promise<string> {
  const texts = await Promise.all(paths.map((path) => readFile(injectAssetUrl(path), "utf8")));
  return texts.join("");
}

/** 按 `assets.rs` 的顺序拼回注入脚本原文，供按标记切片的回归测试使用。 */
export async function readRendererInjectSource(): Promise<string> {
  return `(() => {\n${await readFragments(RENDERER_FRAGMENT_PATHS)}})();\n\n${await readFragments(RENDERER_TRAILING_FRAGMENT_PATHS)}`;
}

/** 按 `assets.rs` 的顺序拼回悬浮球注入脚本原文。 */
export async function readStepwiseSource(): Promise<string> {
  return `(() => {\n${await readFragments(STEPWISE_FRAGMENT_PATHS)}\n})();\n`;
}
