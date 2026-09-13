import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const renderer = await readFile(new URL("../../../assets/inject/renderer-inject.js", import.meta.url), "utf8");
const source = renderer.slice(renderer.indexOf("  function sortModelChoices("), renderer.indexOf("  function modelArrayLooksPatchable("));
const sort = new Function(source + "; return sortModelChoices;")();

test("模型按版本降序分组，图像独立置后，重复整理无变化", () => {
  const models = ["gpt-5.6-terra", "gpt-image-1.5", "gpt-5.3-codex-spark", "gpt-6-astra", "gpt-5.5", "gpt-5.6-luna", "gpt-image-2.5-flare", "gpt-5.6-sol", "gpt-image-2"];
  assert.equal(sort(models, (name: string) => name), true);
  assert.deepEqual(models, ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex-spark", "gpt-image-2.5-flare", "gpt-image-2", "gpt-image-1.5"]);
  assert.equal(sort(models, (name: string) => name), false);
});

test("数字版本自然排序且不改变默认模型标记", () => {
  const models = [{ model: "gpt-5.9", isDefault: true }, { model: "gpt-5.10", isDefault: false }, { model: "custom-2" }, { model: "custom-10" }];
  sort(models, (item: { model: string }) => item.model);
  assert.deepEqual(models.map(item => item.model), ["gpt-5.10", "gpt-5.9", "custom-2", "custom-10"]);
  assert.equal(models[1].isDefault, true);
});
