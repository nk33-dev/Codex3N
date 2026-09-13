import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
const source = renderer.slice(renderer.indexOf("  function sortModelChoices("), renderer.indexOf("  function modelArrayLooksPatchable("));
const sort = new Function(source + "; return sortModelChoices;")();
const nameOf = (name: string) => name;

test("同家族数字降序、同版本文字升序，不优先指定型号", () => {
  const models = ["gpt-5.6-terra", "gpt-image-1.5", "gpt-5.3-codex-spark", "gpt-6-astra", "gpt-5.5", "gpt-5.6-luna", "gpt-image-2.5-flare", "gpt-5.6-sol", "gpt-image-2"];
  assert.equal(sort(models, nameOf), true);
  assert.deepEqual(models, ["gpt-6-astra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.5", "gpt-5.3-codex-spark", "gpt-image-2.5-flare", "gpt-image-2", "gpt-image-1.5"]);
  assert.equal(sort(models, nameOf), false);
});

test("不同家族统一按名称排序，不把 GPT 固定置顶", () => {
  const models = ["qwen3.5", "gpt-5.9", "deepseek-v3", "claude-sonnet-4.5", "gemini-2.5-pro", "gpt-5.10", "qwen3.10", "deepseek-v4", "claude-sonnet-4.6", "gemini-3-pro"];
  sort(models, nameOf);
  assert.deepEqual(models, ["claude-sonnet-4.6", "claude-sonnet-4.5", "deepseek-v4", "deepseek-v3", "gemini-3-pro", "gemini-2.5-pro", "gpt-5.10", "gpt-5.9", "qwen3.10", "qwen3.5"]);
});

test("新供应商与无版本别名无需扩充名单", () => {
  const models = ["zeta-fast", "nebula-2", "nebula-10", "zeta-chat", "nebula-auto", "nebula-3.9", "nebula-3.10"];
  sort(models, nameOf);
  assert.deepEqual(models, ["nebula-10", "nebula-3.10", "nebula-3.9", "nebula-2", "nebula-auto", "zeta-chat", "zeta-fast"]);
});

test("命名空间仍相邻，不改写模型 ID 或排序相同条目的原始顺序", () => {
  const models = ["vendor-z/vision-2", "vendor-a/chat-2", "vendor-a/chat-10", "Vendor-A/chat_10", "vendor-z/vision-10"];
  sort(models, nameOf);
  assert.deepEqual(models, ["vendor-a/chat-10", "Vendor-A/chat_10", "vendor-a/chat-2", "vendor-z/vision-10", "vendor-z/vision-2"]);
  assert.equal(sort(models, nameOf), false);
});

test("新型号加入不会改变其他型号相对次序，也不会过滤旧型号", () => {
  const models = ["custom-2", "custom-10", "other-auto"];
  sort(models, nameOf);
  const previous = [...models];
  models.push("custom-11");
  sort(models, nameOf);
  assert.equal(models[0], "custom-11");
  assert.deepEqual(models.filter(model => model !== "custom-11"), previous);
});

test("只移动对象，不修改默认模型、名称或元数据", () => {
  const older = { model: "custom-9", isDefault: true, contextWindow: 123 };
  const newer = { model: "custom-10", isDefault: false, contextWindow: 456 };
  const models = [older, newer];
  const snapshot = structuredClone(models);
  sort(models, (item: typeof older) => item.model);
  assert.equal(models[0], newer);
  assert.equal(models[1], older);
  assert.deepEqual([older, newer], snapshot);
});

test("完整小版本排在同主版本的简写之前", () => {
  const models = ["custom-3", "custom-3.2", "custom-3.10", "custom-3-mini"];
  sort(models, nameOf);
  assert.deepEqual(models, ["custom-3.10", "custom-3.2", "custom-3-mini", "custom-3"]);
});

test("空数组和无需排序的单个别名不会报告变化", () => {
  assert.equal(sort([], nameOf), false);
  assert.equal(sort(["auto"], nameOf), false);
});
