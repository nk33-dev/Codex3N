import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");

function section(start: string, end: string): string {
  const offset = source.indexOf(start);
  const limit = source.indexOf(end, offset);
  assert.ok(offset >= 0 && limit > offset, `找不到源码片段：${start}`);
  return source.slice(offset, limit);
}

test("供应商切换立即加锁，并把切换状态纳入 actions 依赖", () => {
  const switching = section("  const switchRelayProfile = async", "  const snapshotActiveRelayFilesBeforeSwitch");
  assert.match(switching, /if \(relaySwitchingRef\.current\)/);
  assert.ok(
    switching.indexOf("relaySwitchingRef.current = true")
      < switching.indexOf("await snapshotActiveRelayFilesBeforeSwitch"),
  );

  const actions = section("  const actions = useMemo(", "  const hasUpdate =");
  const dependencies = actions.slice(actions.lastIndexOf("["));
  assert.match(dependencies, /\brelaySwitching\b/);
});

test("复制成功和失败都有明确反馈", async () => {
  const copySource = section("  const copyText = async", "  const openExternalUrl =")
    .replace("text: string", "text")
    .replace("message: string", "message");
  const createCopyText = (writeText: () => Promise<void>, notices: unknown[][]) =>
    new Function("navigator", "showNotice", "t", "stringifyError", `
      ${copySource}
      return copyText;
    `)(
      { clipboard: { writeText } },
      (...args: unknown[]) => notices.push(args),
      (value: string) => value,
      String,
    );

  const notices: unknown[][] = [];
  const copyText = createCopyText(async () => {}, notices);
  await copyText("内容", "已复制");
  assert.deepEqual(notices, [["复制", "已复制", "ok"]]);

  notices.length = 0;
  const failedCopyText = createCopyText(async () => { throw new Error("拒绝访问"); }, notices);
  await failedCopyText("内容", "已复制");
  assert.deepEqual(notices, [["复制失败", "Error: 拒绝访问", "failed"]]);
});
