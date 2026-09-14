use super::{
    CcsProvidersPayload, CommandResult, PendingProviderImportPayload, SettingsPayload, failed,
    normalize_settings_before_save, ok, settings_payload, settings_payload_value,
};
use codex_plus_core::settings::SettingsStore;

/// 只校验本次新增或编辑的配置文件，不让历史未改动的坏配置阻断其他设置保存。
pub(super) fn validate_changed_provider_files(
    settings: &codex_plus_core::settings::BackendSettings,
    previous: &codex_plus_core::settings::BackendSettings,
) -> Result<(), String> {
    for profile in &settings.relay_profiles {
        let old = previous
            .relay_profiles
            .iter()
            .find(|old| old.id == profile.id);
        if old.is_none_or(|old| old.config_contents != profile.config_contents) {
            profile
                .config_contents
                .parse::<toml_edit::DocumentMut>()
                .map_err(|error| {
                    let line = error.span().map_or(1, |span| {
                        profile.config_contents.as_bytes()
                            [..span.start.min(profile.config_contents.len())]
                            .iter()
                            .filter(|byte| **byte == b'\n')
                            .count()
                            + 1
                    });
                    format!(
                        "供应商 {} 的 config.toml 第 {line} 行格式无效",
                        profile.name
                    )
                })?;
        }
        if old.is_none_or(|old| old.auth_contents != profile.auth_contents)
            && !profile.auth_contents.trim().is_empty()
        {
            let auth: serde_json::Value =
                serde_json::from_str(&profile.auth_contents).map_err(|error| {
                    format!(
                        "供应商 {} 的 auth.json 第 {} 行、第 {} 列格式无效",
                        profile.name,
                        error.line(),
                        error.column()
                    )
                })?;
            if !auth.is_object() {
                return Err(format!(
                    "供应商 {} 的 auth.json 必须是 JSON 对象",
                    profile.name
                ));
            }
            if auth
                .get("OPENAI_API_KEY")
                .is_some_and(|key| !key.is_null() && !key.is_string())
            {
                return Err(format!(
                    "供应商 {} 的 auth.json.OPENAI_API_KEY 必须是字符串或 null",
                    profile.name
                ));
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn load_ccs_providers() -> CommandResult<CcsProvidersPayload> {
    let settings = SettingsStore::default().load().unwrap_or_default();
    match codex_plus_core::ccs_import::resolve_codex_provider_source(&settings.ccs_db_path) {
        Ok(source) => ok(
            &format!(
                "已读取 cc-switch Codex 供应商配置：{} 个。",
                source.providers.len()
            ),
            CcsProvidersPayload {
                db_path: source.db_path.to_string_lossy().to_string(),
                configured_db_path: source.configured_db_path,
                fallback_reason: source.fallback_reason,
                providers: source.providers,
            },
        ),
        Err(error) => failed(
            &format!("读取 cc-switch 供应商配置失败：{error}"),
            CcsProvidersPayload {
                db_path: codex_plus_core::ccs_import::default_ccs_db_path()
                    .to_string_lossy()
                    .to_string(),
                configured_db_path: settings.ccs_db_path,
                fallback_reason: None,
                providers: Vec::new(),
            },
        ),
    }
}

#[tauri::command]
pub fn import_ccs_providers() -> CommandResult<SettingsPayload> {
    let store = SettingsStore::default();
    let mut settings = store.load().unwrap_or_default();
    let providers =
        match codex_plus_core::ccs_import::resolve_codex_provider_source(&settings.ccs_db_path) {
            Ok(source) => source.providers,
            Err(error) => {
                let payload = settings_payload_value().unwrap_or_else(|(_, payload)| payload);
                return failed(&format!("读取 cc-switch 供应商配置失败：{error}"), payload);
            }
        };

    let mut existing_keys: Vec<String> = settings
        .relay_profiles
        .iter()
        .map(codex_plus_core::ccs_import::imported_provider_identity)
        .collect();
    let mut existing_ids: Vec<String> = settings
        .relay_profiles
        .iter()
        .map(|profile| profile.id.clone())
        .collect();
    let mut imported = 0usize;

    for provider in providers {
        let key = codex_plus_core::ccs_import::provider_identity_from_ccs(&provider);
        if existing_keys.iter().any(|existing| existing == &key) {
            continue;
        }
        let profile = codex_plus_core::ccs_import::relay_profile_from_ccs(&provider, &existing_ids);
        existing_ids.push(profile.id.clone());
        existing_keys.push(key);
        settings.relay_profiles.push(profile);
        imported += 1;
    }

    if imported == 0 {
        return settings_payload("没有新的 cc-switch 供应商配置需要导入。", "设置读取失败");
    }

    settings = normalize_settings_before_save(settings);
    match store.save(&settings) {
        Ok(()) => settings_payload(
            &format!("已从 cc-switch 导入供应商配置：{imported} 个。"),
            "导入供应商配置后重新读取设置失败",
        ),
        Err(error) => failed(
            &format!("保存 cc-switch 供应商配置失败：{error}"),
            settings_payload_value().unwrap_or_else(|(_, payload)| payload),
        ),
    }
}

#[tauri::command]
pub fn load_pending_provider_import() -> CommandResult<PendingProviderImportPayload> {
    match codex_plus_core::provider_import::load_pending_provider_import() {
        Ok(pending) => ok(
            "待确认供应商导入已读取。",
            PendingProviderImportPayload { pending },
        ),
        Err(error) => failed(
            &format!("读取待确认供应商导入失败：{error}"),
            PendingProviderImportPayload { pending: None },
        ),
    }
}

#[tauri::command]
pub fn confirm_pending_provider_import() -> CommandResult<SettingsPayload> {
    match codex_plus_core::provider_import::confirm_pending_provider_import() {
        Ok(Some(result)) => {
            let message = if result.imported {
                format!("已导入供应商配置：{}。", result.profile_name)
            } else {
                format!("供应商配置已存在：{}。", result.profile_name)
            };
            settings_payload(&message, "供应商导入后重新读取设置失败")
        }
        Ok(None) => settings_payload("没有待确认的供应商导入。", "设置读取失败"),
        Err(error) => failed(
            &format!("导入供应商配置失败：{error}"),
            settings_payload_value().unwrap_or_else(|(_, payload)| payload),
        ),
    }
}

#[tauri::command]
pub fn dismiss_pending_provider_import() -> CommandResult<PendingProviderImportPayload> {
    match codex_plus_core::provider_import::clear_pending_provider_import() {
        Ok(()) => ok(
            "已取消供应商导入。",
            PendingProviderImportPayload { pending: None },
        ),
        Err(error) => failed(
            &format!("取消供应商导入失败：{error}"),
            PendingProviderImportPayload { pending: None },
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_plus_core::settings::{BackendSettings, RelayProfile};

    #[test]
    fn validates_edited_files_but_preserves_untouched_legacy_files() {
        let old = BackendSettings {
            relay_profiles: vec![RelayProfile {
                id: "test".into(),
                config_contents: "broken = [".into(),
                ..RelayProfile::default()
            }],
            ..BackendSettings::default()
        };
        assert!(validate_changed_provider_files(&old, &old).is_ok());
        let mut next = old.clone();
        next.relay_profiles[0].config_contents = "model = [\n".into();
        assert!(
            validate_changed_provider_files(&next, &old)
                .unwrap_err()
                .contains("config.toml")
        );
        next.relay_profiles[0].config_contents = "model = 'test'\n".into();
        next.relay_profiles[0].auth_contents = "[]".into();
        assert!(
            validate_changed_provider_files(&next, &old)
                .unwrap_err()
                .contains("JSON 对象")
        );
        next.relay_profiles[0].auth_contents = r#"{"OPENAI_API_KEY": 42}"#.into();
        assert!(
            validate_changed_provider_files(&next, &old)
                .unwrap_err()
                .contains("OPENAI_API_KEY")
        );
        next.relay_profiles[0].auth_contents = r#"{"OPENAI_API_KEY": null, "tokens": {}}"#.into();
        assert!(validate_changed_provider_files(&next, &old).is_ok());
    }
}
