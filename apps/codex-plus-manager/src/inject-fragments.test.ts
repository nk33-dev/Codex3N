import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  RENDERER_FRAGMENT_PATHS,
  RENDERER_TRAILING_FRAGMENT_PATHS,
  STEPWISE_FRAGMENT_PATHS,
  readRendererInjectSource,
} from "./inject-fragments.ts";

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

/**
 * 按出现顺序取出 `concat!` 块里的分片路径，并按 IIFE 收尾字面量分成两段。
 *
 * 路径都写成 `include_str!("../../../assets/inject/…")`，返回时去掉
 * `assets/inject/` 前缀，便于和测试侧的分片清单直接比较。
 */
function concatFragments(constName: string) {
  const block = concatBlock(constName);
  const closeAt = block.indexOf("})();");
  const entries = [...block.matchAll(/include_str!\("(?:\.\.\/){3}([^"]+)"\)/g)].map((match) => ({
    at: match.index ?? 0,
    path: match[1].replace("assets/inject/", ""),
  }));
  return {
    beforeClose: entries.filter((entry) => entry.at < closeAt).map((entry) => entry.path),
    afterClose: entries.filter((entry) => entry.at > closeAt).map((entry) => entry.path),
  };
}

describe("注入脚本分片清单", () => {
  it("renderer 分片顺序与 assets.rs 的 concat! 完全一致", () => {
    const fragments = concatFragments("RENDERER_SCRIPT");
    assert.deepEqual(fragments.beforeClose, [...RENDERER_FRAGMENT_PATHS]);
    assert.deepEqual(fragments.afterClose, [...RENDERER_TRAILING_FRAGMENT_PATHS]);
    assert.equal(
      new Set(RENDERER_FRAGMENT_PATHS).size,
      RENDERER_FRAGMENT_PATHS.length,
      "分片不能重复",
    );
    assert.equal(
      new Set(RENDERER_TRAILING_FRAGMENT_PATHS).size,
      RENDERER_TRAILING_FRAGMENT_PATHS.length,
      "尾部分片不能重复",
    );
  });

  it("两个注入脚本都只保留 Rust 侧的 IIFE 外壳", () => {
    assert.match(concatBlock("RENDERER_SCRIPT"), /concat!\(\s*"\(\(\) => \{\\n",/);
    assert.match(concatBlock("RENDERER_SCRIPT"), /"\}\)\(\);\\n",\s*"\\n",/);
    assert.match(concatBlock("STEPWISE_SCRIPT"), /concat!\(\s*"\(\(\) => \{\\n",/);
  });

  it("悬浮球分片顺序与 assets.rs 的 concat! 完全一致", () => {
    assert.deepEqual(concatFragments("STEPWISE_SCRIPT").beforeClose, [
      ...STEPWISE_FRAGMENT_PATHS,
    ]);
  });

  it("拼回的 renderer 脚本仍是单一 IIFE，粘贴修复留在 IIFE 之外", async () => {
    const source = await readRendererInjectSource();
    assert.ok(source.startsWith("(() => {\n"));
    assert.ok(source.endsWith("}\n"));
    const closeAt = source.indexOf("\n})();\n");
    assert.ok(closeAt > 0, "renderer 脚本必须先收尾 IIFE");
    assert.match(source.slice(closeAt), /__CODEX_PLUS_PASTE_FIX__/);
    assert.doesNotMatch(source, /^\s*(?:import|export)\s/m);
  });

  it("拼回的 renderer 脚本仍是合法脚本", async () => {
    const source = await readRendererInjectSource();
    // new Function 只编译不执行，用来证明分片边界没有切断任何语法结构。
    assert.doesNotThrow(() => new Function(source), "分片边界破坏了脚本语法");
  });
});
