import { invoke } from "@tauri-apps/api/core";

const allowed = (key: string) => key === "codex-plus-theme" || key === "codex-plus-lang" || key.startsWith("codex-plus-relay-fold:");
let values: Record<string, string> = {};
let ready = false;
let pending = Promise.resolve();

export async function initializePreferences(): Promise<void> {
  const { values: saved, importLegacy } = await invoke<{ values: Record<string, string>; importLegacy: boolean }>("load_ui_preferences");
  const imported: Record<string, string> = {};
  // 只在后端没有该键时导入 WebView 旧偏好，后续以后端为准。
  try {
    for (let index = 0; importLegacy && index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key && allowed(key) && !(key in saved)) imported[key] = localStorage.getItem(key) || "";
    }
  } catch { /* WebView 存储不可用时仍读取用户目录中的偏好。 */ }
  if (importLegacy) await invoke("save_ui_preferences", { values: imported });
  values = { ...imported, ...saved };
  ready = true;
}

export function readPreference(key: string): string | null {
  return ready ? values[key] ?? null : localStorage.getItem(key);
}

export function writePreference(key: string, value: string): Promise<void> {
  values[key] = value;
  try { localStorage.setItem(key, value); } catch { /* 用户目录仍可保存偏好。 */ }
  pending = pending.catch(() => {}).then(() => invoke("save_ui_preferences", { values: { [key]: value } }));
  return pending;
}
