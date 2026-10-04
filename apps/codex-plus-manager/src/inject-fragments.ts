import { readFile } from "node:fs/promises";

/**
 * 悬浮球注入脚本的分片清单，对应 `assets.rs` 的 `STEPWISE_SCRIPT`。
 *
 * `assets/inject/floating-panel/**` 是上游既有的分片结构，个人版沿用不变。
 * 分片顺序**有意义**：整份脚本共享一个 IIFE 作用域，`const` / `let` 存在 TDZ。
 *
 * renderer 的分片顺序由上游 manifest 维护，组装后生成 renderer-inject.js；
 * 回归读取这份产物，跨分片的函数和模板才能保持完整。
 */
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

/** 读取 renderer 生成产物，供回归使用（与 `assets.rs` 同一文件）。 */
export async function readRendererInjectSource(): Promise<string> {
  return readFile(injectAssetUrl("renderer-inject.js"), "utf8");
}

/** 按 `assets.rs` 的顺序拼回悬浮球注入脚本原文。 */
export async function readStepwiseSource(): Promise<string> {
  return `(() => {\n${await readFragments(STEPWISE_FRAGMENT_PATHS)}\n})();\n`;
}
