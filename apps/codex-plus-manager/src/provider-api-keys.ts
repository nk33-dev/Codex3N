import type { RelayApiKey, RelayProfile } from "./provider-types";

const DEFAULT_KEY_ID = "default";

function uniqueKeyId(base: string, used: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

export function normalizeRelayApiKeys(profile: Pick<RelayProfile, "apiKey" | "apiKeys" | "activeApiKeyId">): {
  apiKeys: RelayApiKey[];
  activeApiKeyId: string;
} {
  const used = new Set<string>();
  const apiKeys = (Array.isArray(profile.apiKeys) ? profile.apiKeys : []).map((entry, index) => {
    const requestedId = String(entry?.id || "").trim() || `key-${index + 1}`;
    const id = uniqueKeyId(requestedId, used);
    used.add(id);
    return {
      id,
      name: String(entry?.name || "").trim() || `Key ${index + 1}`,
      apiKey: String(entry?.apiKey || ""),
    };
  });
  if (!apiKeys.length) {
    apiKeys.push({ id: DEFAULT_KEY_ID, name: "默认", apiKey: profile.apiKey || "" });
  }
  const requestedActiveId = String(profile.activeApiKeyId || "").trim();
  const activeApiKeyId = apiKeys.some((entry) => entry.id === requestedActiveId)
    ? requestedActiveId
    : apiKeys[0]?.id || "";
  return { apiKeys, activeApiKeyId };
}

export function selectedRelayApiKey(profile: Pick<RelayProfile, "apiKey" | "apiKeys" | "activeApiKeyId">): RelayApiKey | null {
  const normalized = normalizeRelayApiKeys(profile);
  return normalized.apiKeys.find((entry) => entry.id === normalized.activeApiKeyId) || null;
}

/// 归一化命名 Key 并把 `apiKey` 同步成选中项的值。
///
/// 泛型是为了保住调用方的完整 profile 类型：管理器在 App.tsx 里声明的
/// `RelayProfile` 比这里的多出若干本地字段，固定成 `provider-types` 的
/// `RelayProfile` 会把它们削掉（而且类型上不可赋值）。
export function relayProfileWithNormalizedApiKeys<
  T extends Pick<RelayProfile, "apiKey" | "apiKeys" | "activeApiKeyId">,
>(profile: T): T {
  const normalized = normalizeRelayApiKeys(profile);
  const selected = normalized.apiKeys.find((entry) => entry.id === normalized.activeApiKeyId);
  return {
    ...profile,
    ...normalized,
    apiKey: selected?.apiKey ?? profile.apiKey,
  };
}

export function createRelayApiKey(apiKeys: RelayApiKey[]): RelayApiKey {
  const used = new Set(apiKeys.map((entry) => entry.id));
  return {
    id: uniqueKeyId(`key-${Date.now().toString(36)}`, used),
    name: `Key ${apiKeys.length + 1}`,
    apiKey: "",
  };
}
