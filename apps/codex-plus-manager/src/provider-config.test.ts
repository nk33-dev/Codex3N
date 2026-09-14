import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProviderAuth, codexApiKeyFromAuth, authJsonHasOpenAiApiKey, setAuthOpenAiApiKey, codexBaseUrlFromConfig, rootTomlStringValue, codexModelFromConfig, codexTopLevelIntFromConfig } from "./provider-config.ts";

test("鉴权读取兼容官方 tokens、空文件和空 Key，更新 Key 保留其他字段", () => {
  for (const raw of ["", " ", '{"tokens":{},"OPENAI_API_KEY":null}']) {
    assert.equal(parseProviderAuth(raw).error, null);
    assert.equal(codexApiKeyFromAuth(raw), "");
  }
  assert.deepEqual(JSON.parse(setAuthOpenAiApiKey('{"vendor":1,"tokens":{"id":"test"}}', " new ")), { vendor: 1, tokens: { id: "test" }, OPENAI_API_KEY: "new" });
});

test("损坏鉴权给出文件或字段错误，同时保留旧模式判断兼容", () => {
  assert.match(parseProviderAuth('{"OPENAI_API_KEY":').error!, /auth.json/);
  assert.equal(authJsonHasOpenAiApiKey('{"OPENAI_API_KEY":'), true);
  for (const raw of ["[]", "null", '"value"']) assert.match(parseProviderAuth(raw).error!, /JSON object/);
  assert.match(parseProviderAuth('{"OPENAI_API_KEY":42}').error!, /OPENAI_API_KEY/);
  assert.equal(codexApiKeyFromAuth('{"OPENAI_API_KEY":42}'), "");
});

test("配置读取优先匹配选中供应商，避免混入其他供应商地址", () => {
  const config = 'model = "model-a"\nmodel_provider = "second"\nmodel_context_window = 1000 # note\n[model_providers.first]\nbase_url = "https://first.test"\n[model_providers.second]\nbase_url = "https://second.test"';
  assert.equal(codexBaseUrlFromConfig(config), "https://second.test");
  assert.equal(codexModelFromConfig(config), "model-a");
  assert.equal(rootTomlStringValue(config, "model_provider"), "second");
  assert.equal(codexTopLevelIntFromConfig(config, "model_context_window"), "1000");
  assert.equal(codexBaseUrlFromConfig(config.replace('model_provider = "second"', '')), "");
});
