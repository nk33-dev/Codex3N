export type PromptEnhanceContextSettings = {
  enabled: boolean;
  project: boolean;
  instructions: boolean;
  directory: boolean;
  manifests: boolean;
};

export type PromptEnhanceSettings = {
  enabled: boolean;
  rewriteEnabled: boolean;
  grillEnabled: boolean;
  favoritesEnabled: boolean;
  useStepwiseConnection: boolean;
  baseUrl: string;
  apiKey: string;
  apiKeyEnv: string;
  protocol: string;
  model: string;
  systemPrompt: string;
  grillSystemPrompt: string;
  defaultMode: "rewrite" | "grill";
  detail: "concise" | "standard" | "detailed";
  audience: "nontechnical" | "p4" | "p5" | "p6" | "p7" | "p8" | "p9" | "p10";
  context: PromptEnhanceContextSettings;
  timeoutSeconds: number;
};

export type PromptEnhanceSettingsIssue = "baseUrl" | "model";

const protocols = new Set(["chat_completions", "responses", "anthropic_messages", "auto"]);

export function defaultPromptEnhanceSettings(): PromptEnhanceSettings {
  return {
    enabled: false,
    rewriteEnabled: true,
    grillEnabled: true,
    favoritesEnabled: true,
    useStepwiseConnection: true,
    baseUrl: "",
    apiKey: "",
    apiKeyEnv: "",
    protocol: "chat_completions",
    model: "",
    systemPrompt: "",
    grillSystemPrompt: "",
    defaultMode: "rewrite",
    detail: "standard",
    audience: "p4",
    context: { enabled: false, project: false, instructions: false, directory: false, manifests: false },
    timeoutSeconds: 60,
  };
}

export function normalizePromptEnhanceSettings(value: Partial<PromptEnhanceSettings> | undefined): PromptEnhanceSettings {
  const defaults = defaultPromptEnhanceSettings();
  const text = (entry: unknown) => typeof entry === "string" ? entry.trim() : "";
  const protocol = text(value?.protocol);
  const timeout = value?.timeoutSeconds;
  return {
    enabled: value?.enabled === true,
    rewriteEnabled: value?.rewriteEnabled !== false,
    grillEnabled: value?.grillEnabled !== false,
    favoritesEnabled: value?.favoritesEnabled !== false,
    useStepwiseConnection: value?.useStepwiseConnection !== false,
    baseUrl: text(value?.baseUrl).replace(/\/+$/, ""),
    apiKey: text(value?.apiKey),
    apiKeyEnv: text(value?.apiKeyEnv),
    protocol: protocols.has(protocol) ? protocol : defaults.protocol,
    model: text(value?.model),
    systemPrompt: text(value?.systemPrompt),
    grillSystemPrompt: text(value?.grillSystemPrompt),
    defaultMode: value?.defaultMode === "grill" ? "grill" : "rewrite",
    detail: promptDetails.some(item => item.value === value?.detail) ? value!.detail! : defaults.detail,
    audience: promptAudiences.some(item => item.value === value?.audience) ? value!.audience! : defaults.audience,
    context: {
      enabled: value?.context?.enabled === true,
      project: value?.context?.project === true,
      instructions: value?.context?.instructions === true,
      directory: value?.context?.directory === true,
      manifests: value?.context?.manifests === true,
    },
    timeoutSeconds: typeof timeout === "number" && Number.isFinite(timeout)
      ? Math.min(300, Math.max(5, Math.round(timeout)))
      : defaults.timeoutSeconds,
  };
}

// 复用下一步建议连接时不校验本组字段，由后端按那一组配置报错。
export function promptEnhanceSettingsIssue(settings: PromptEnhanceSettings): PromptEnhanceSettingsIssue | null {
  if (!settings.enabled || (!settings.rewriteEnabled && !settings.grillEnabled) || settings.useStepwiseConnection) return null;
  if (!settings.baseUrl.trim()) return "baseUrl";
  if (!settings.model.trim()) return "model";
  return null;
}
import preferences from "../../../assets/prompt-enhance/preferences.json" with { type: "json" };
export const promptDetails = preferences.details;
export const promptAudiences = preferences.audiences;
export const promptDetailLabelsEn = preferences.detailLabelsEn;
export const promptAudienceLabelsEn = preferences.audienceLabelsEn;
