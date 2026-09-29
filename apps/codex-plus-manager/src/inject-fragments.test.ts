import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { STEPWISE_FRAGMENT_PATHS, readRendererInjectSource } from "./inject-fragments.ts";

const assetsRs = await readFile(
  new URL("../../../crates/codex-plus-core/src/assets.rs", import.meta.url),
  "utf8",
);

/** 取出某个 `concat!` 常量的完整源码块。 */
function concatBlock(constName: string): string {
  const start = assetsRs.indexOf(`const ${constName}: &str = concat!(`);
  assert.ok(start >= 0, `${constName} 的 concat! 块在 assets.rs 里找不到`);
  const end = assetsRs.indexOf("\n);", start);
  assert.ok(end > start, `${constName} 的 concat! 块没有正常结束`);
  return assetsRs.slice(start, end);
}

/** 按出现顺序取出 `concat!` 块里的分片路径（相对 `assets/inject/`）。 */
function concatFragments(constName: string): string[] {
  return [...concatBlock(constName).matchAll(/include_str!\("(?:\.\.\/){3}([^"]+)"\)/g)].map(
    (match) => match[1].replace("assets/inject/", ""),
  );
}

describe("注入脚本结构", () => {
  it("renderer 保持与上游同构的单文件，悬浮球沿用上游分片", () => {
    // 上游近一年高频改 renderer-inject.js；保持同构单文件，同步时才能走 Git 三方合并。
    assert.match(
      assetsRs,
      /const RENDERER_SCRIPT: &str =\s*include_str!\("[^"]*renderer-inject\.js"\);/,
    );
    assert.match(assetsRs, /const STEPWISE_SCRIPT: &str = concat!\(/);
  });

  it("悬浮球分片顺序与 assets.rs 的 concat! 完全一致", () => {
    assert.deepEqual(concatFragments("STEPWISE_SCRIPT"), [...STEPWISE_FRAGMENT_PATHS]);
    assert.equal(
      new Set(STEPWISE_FRAGMENT_PATHS).size,
      STEPWISE_FRAGMENT_PATHS.length,
      "分片不能重复",
    );
  });

  it("悬浮球只保留 Rust 侧的 IIFE 外壳", () => {
    assert.match(concatBlock("STEPWISE_SCRIPT"), /concat!\(\s*"\(\(\) => \{\\n",/);
  });

  it("renderer 脚本仍是单一 IIFE，粘贴修复留在 IIFE 之外", async () => {
    const source = await readRendererInjectSource();
    assert.ok(source.startsWith("(() => {\n"));
    assert.ok(source.endsWith("}\n"));
    const closeAt = source.indexOf("\n})();\n");
    assert.ok(closeAt > 0, "renderer 脚本必须先收尾 IIFE");
    assert.match(source.slice(closeAt), /__CODEX_PLUS_PASTE_FIX__/);
    assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
  });

  it("renderer 脚本仍是合法脚本", async () => {
    const source = await readRendererInjectSource();
    // new Function 只编译不执行，用来证明脚本本身语法完整。
    assert.doesNotThrow(() => new Function(source), "renderer 脚本语法不完整");
  });
});
