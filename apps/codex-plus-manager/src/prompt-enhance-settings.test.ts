import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultPromptEnhanceSettings,
  normalizePromptEnhanceSettings,
  promptEnhanceSettingsIssue,
} from "./prompt-enhance-settings.ts";

test("prompt enhance is off by default and reuses the next-step connection", () => {
  const settings = normalizePromptEnhanceSettings(undefined);
  assert.deepEqual(settings, defaultPromptEnhanceSettings());
  assert.equal(settings.enabled, false);
  assert.equal(settings.useStepwiseConnection, true);
});

test("detail and audience survive settings round trips and legacy defaults", () => {
  assert.equal(normalizePromptEnhanceSettings(undefined).detail, "standard");
  assert.equal(normalizePromptEnhanceSettings(undefined).audience, "p4");
  for (const detail of ["concise", "standard", "detailed"] as const) {
    for (const audience of ["nontechnical", "p4", "p5", "p6", "p7", "p8", "p9", "p10"] as const) {
      const value = normalizePromptEnhanceSettings({ detail, audience, systemPrompt: "个人规则" });
      assert.equal(value.detail, detail);
      assert.equal(value.audience, audience);
      assert.deepEqual(normalizePromptEnhanceSettings(JSON.parse(JSON.stringify(value))), value);
    }
  }
  const invalid = normalizePromptEnhanceSettings(JSON.parse('{"detail":"unknown","audience":"unknown"}'));
  assert.equal(invalid.detail, "standard");
  assert.equal(invalid.audience, "p4");
});

test("prompt enhance normalization trims fields and clamps values", () => {
  const settings = normalizePromptEnhanceSettings({
    enabled: true,
    useStepwiseConnection: false,
    baseUrl: " https://api.example.test/v1/ ",
    model: " mini ",
    protocol: "unknown",
    systemPrompt: "  只补充验收标准  ",
    timeoutSeconds: 900,
  });
  assert.equal(settings.baseUrl, "https://api.example.test/v1");
  assert.equal(settings.model, "mini");
  assert.equal(settings.protocol, "chat_completions");
  assert.equal(settings.systemPrompt, "只补充验收标准");
  assert.equal(settings.timeoutSeconds, 300);
  assert.equal(normalizePromptEnhanceSettings({ timeoutSeconds: 1 }).timeoutSeconds, 5);
  assert.equal(normalizePromptEnhanceSettings({ timeoutSeconds: NaN }).timeoutSeconds, 60);
  assert.deepEqual(normalizePromptEnhanceSettings(JSON.parse(JSON.stringify(settings))), settings);
});

test("separate connection requires base URL and model only when enabled", () => {
  const base = { ...defaultPromptEnhanceSettings(), enabled: true, useStepwiseConnection: false };
  assert.equal(promptEnhanceSettingsIssue(base), "baseUrl");
  assert.equal(promptEnhanceSettingsIssue({ ...base, baseUrl: "https://x.test/v1" }), "model");
  assert.equal(promptEnhanceSettingsIssue({ ...base, baseUrl: "https://x.test/v1", model: "m" }), null);
  assert.equal(promptEnhanceSettingsIssue({ ...base, useStepwiseConnection: true }), null);
  assert.equal(promptEnhanceSettingsIssue({ ...base, enabled: false }), null);
});


test("context and grill defaults preserve old settings and normalize independently", () => {
  const old = normalizePromptEnhanceSettings({ enabled: true, systemPrompt: "个人规则" });
  assert.equal(old.defaultMode, "rewrite");
  assert.equal(old.grillSystemPrompt, "");
  assert.deepEqual(old.context, { enabled: false, project: false, instructions: false, directory: false, manifests: false });
  const settings = normalizePromptEnhanceSettings({
    defaultMode: "grill", grillSystemPrompt: "  先确认目标  ",
    context: { enabled: true, project: true, instructions: false, directory: true, manifests: false },
  });
  assert.equal(settings.defaultMode, "grill");
  assert.equal(settings.grillSystemPrompt, "先确认目标");
  assert.equal(settings.context.directory, true);
  assert.equal(settings.context.instructions, false);
  assert.deepEqual(normalizePromptEnhanceSettings(JSON.parse(JSON.stringify(settings))), settings);
  assert.equal(normalizePromptEnhanceSettings(JSON.parse('{"defaultMode":"unknown","context":{"enabled":"true"}}')).defaultMode, "rewrite");
  assert.equal(normalizePromptEnhanceSettings(JSON.parse('{"context":{"enabled":"true"}}')).context.enabled, false);
});

test("independent modes retain context choices and do not require a model when both are off", () => {
  const old = normalizePromptEnhanceSettings({ enabled: true });
  assert.equal(old.rewriteEnabled, true);
  assert.equal(old.grillEnabled, true);
  for (const rewriteEnabled of [false, true]) for (const grillEnabled of [false, true]) {
    const settings = normalizePromptEnhanceSettings({ enabled: true, useStepwiseConnection: false,
      rewriteEnabled, grillEnabled, defaultMode: "grill",
      context: { enabled: true, project: true, instructions: true, directory: true, manifests: true } });
    assert.equal(settings.rewriteEnabled, rewriteEnabled);
    assert.equal(settings.grillEnabled, grillEnabled);
    assert.equal(settings.defaultMode, "grill");
    assert.equal(settings.context.directory, true);
    assert.equal(promptEnhanceSettingsIssue(settings), rewriteEnabled || grillEnabled ? "baseUrl" : null);
    assert.deepEqual(normalizePromptEnhanceSettings(JSON.parse(JSON.stringify(settings))), settings);
  }
});
