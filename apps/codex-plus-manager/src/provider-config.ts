export function splitTomlRootAndTables(section: string): { root: string; tables: string } {
  const lines = section.trim().split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*$/.test(line));
  if (firstTable < 0) return { root: lines.join("\n"), tables: "" };
  return {
    root: lines.slice(0, firstTable).join("\n"),
    tables: lines.slice(firstTable).join("\n"),
  };
}

export function codexModelFromConfig(contents: string): string {
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) break;
    const match = /^model\s*=\s*(["'])(.*)\1\s*$/.exec(trimmed);
    if (match) return match[2].replace(/\\(["'\\])/g, "$1");
  }
  return "";
}

export function codexBaseUrlFromConfig(contents: string): string {
  return codexProviderStringFromConfig(contents, "base_url");
}

export function codexExperimentalBearerTokenFromConfig(contents: string): string {
  return codexProviderStringFromConfig(contents, "experimental_bearer_token");
}

export function codexProviderStringFromConfig(contents: string, key: string): string {
  const provider = rootTomlStringValue(contents, "model_provider");
  const targetSection = provider ? `model_providers.${provider}` : "";
  const lines = contents.split(/\r?\n/);
  let currentSection = "";
  const matches: string[] = [];
  const providerMatches: string[] = [];

  for (const line of lines) {
    const section = tomlSectionName(line);
    if (section !== null) {
      currentSection = section;
      continue;
    }
    const value = tomlStringAssignmentValue(line, key);
    if (value === null) continue;
    if (targetSection && currentSection === targetSection) return value;
    if (currentSection.startsWith("model_providers.")) providerMatches.push(value);
    else matches.push(value);
  }

  if (matches.length === 1) return matches[0];
  return providerMatches.length === 1 ? providerMatches[0] : "";
}

export function parseProviderAuth(contents: string): { value: Record<string, unknown>; error: string | null } {
  try {
    const value: unknown = JSON.parse(contents.trim() || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { value: {}, error: "auth.json: expected a JSON object" };
    }
    const object = value as Record<string, unknown>;
    if (object.OPENAI_API_KEY != null && typeof object.OPENAI_API_KEY !== "string") {
      return { value: object, error: "auth.json.OPENAI_API_KEY: expected a string or null" };
    }
    return { value: object, error: null };
  } catch {
    return { value: {}, error: "auth.json: invalid JSON syntax" };
  }
}

export function codexApiKeyFromAuth(contents: string): string {
  const { value } = parseProviderAuth(contents);
  return typeof value.OPENAI_API_KEY === "string" ? value.OPENAI_API_KEY : "";
}

export function codexTopLevelIntFromConfig(contents: string, key: string): string {
  const topLevel = splitTomlRootAndTables(contents).root;
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*(?:#.*)?$`);
  for (const line of topLevel.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match) return match[1];
  }
  return "";
}

export function rootTomlStringValue(contents: string, key: string): string {
  const topLevel = splitTomlRootAndTables(contents).root;
  for (const line of topLevel.split(/\r?\n/)) {
    const value = tomlStringAssignmentValue(line, key);
    if (value !== null) return value;
  }
  return "";
}

export function tomlSectionName(line: string): string | null {
  const match = /^\s*\[([^\]]+)\]\s*$/.exec(line);
  return match ? match[1].trim() : null;
}

export function tomlStringAssignmentValue(line: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*([\"'])(.*)\\1\\s*(?:#.*)?$`).exec(line.trim());
  if (!match) return null;
  return match[2].replace(/\\(["'\\])/g, "$1");
}

export function setAuthOpenAiApiKey(contents: string, apiKey: string): string {
  const parsed = parseProviderAuth(contents).value;
  parsed.OPENAI_API_KEY = apiKey.trim();
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function authJsonHasOpenAiApiKey(contents: string): boolean {
  const trimmed = contents.trim();
  if (!trimmed) return false;
  const { value, error } = parseProviderAuth(trimmed);
  if (error === "auth.json: invalid JSON syntax") return /"OPENAI_API_KEY"\s*:/.test(trimmed);
  return typeof value.OPENAI_API_KEY === "string" && value.OPENAI_API_KEY.trim().length > 0;
}
