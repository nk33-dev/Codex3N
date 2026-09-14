import { t, tf } from "./i18n";
import type { RelayProfile, RelayMode, RelayProtocol } from "./provider-types";

export function providerInitial(name: string) {
  const trimmed = (name || t("供应商")).trim();
  return Array.from(trimmed)[0]?.toUpperCase() || t("供");
}

export function relayProtocolLabel(protocol: RelayProtocol): string {
  return protocol === "chatCompletions" ? t("Chat Completions 转 Responses") : "Responses API";
}

export function relayModeLabel(mode: RelayMode): string {
  if (mode === "aggregate") return t("聚合供应商");
  if (mode === "pureApi") return t("纯 API");
  return t("官方登录");
}

export function isSystemDefaultRelayProfile(profile: RelayProfile): boolean {
  return profile.name === "系统默认" || profile.name === "系统默认配置";
}

export function relaySub2ApiMultiplierLabel(profile: RelayProfile): string {
  const multiplier = profile.sub2apiMultiplier.trim();
  return multiplier ? tf("Sub2API 倍率 {0}x", [multiplier]) : t("Sub2API 倍率未获取");
}

export function isAggregateRelayProfile(profile: Pick<RelayProfile, "relayMode" | "aggregate">): boolean {
  return profile.relayMode === "aggregate" || !!profile.aggregate;
}
