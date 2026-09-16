//! Dream Skin（换肤）命令层：图片导入、主题库/主题市场/社区主题、主题激活与实机验证。
//!
//! 命令仍由 `commands` 通过 `pub use dream_skin::*;` 重导出，`lib.rs` 的 `generate_handler!`
//! 继续以 `commands::<命令名>` 引用；仅被 `commands.rs` 测试使用的辅助项放宽为 `pub(super)`。

use std::fs;
use std::path::{Path, PathBuf};

use codex_plus_core::settings::{BackendSettings, SettingsStore};
use serde::Serialize;
use serde_json::json;

use super::{CommandResult, failed, ok};

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamSkinRuntimeRequest {
    pub debug_port: u16,
    #[serde(default = "default_dream_skin_helper_port")]
    pub helper_port: u16,
    #[serde(default)]
    pub screenshot_path: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamSkinThemeActivationRequest {
    pub draft: codex_plus_core::dream_skin_library::DreamSkinThemeDraft,
    pub debug_port: u16,
    #[serde(default = "default_dream_skin_helper_port")]
    pub helper_port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamSkinThemeActivationPayload {
    pub library: codex_plus_core::dream_skin_library::DreamSkinThemeLibrary,
    pub runtime: codex_plus_core::dream_skin_runtime::DreamSkinRuntimeStatus,
    pub saved_for_next_launch: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DreamSkinMarketPayload {
    pub schema_version: u8,
    pub updated_at: String,
    pub repository_url: String,
    pub cached: bool,
    pub warning: String,
    pub themes: Vec<codex_plus_core::dream_skin_market::DreamSkinMarketTheme>,
}

pub type DreamSkinCommunityPayload =
    codex_plus_core::dream_skin_community::DreamSkinCommunityCatalog;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDreamSkinCommunityPayload {
    pub version_id: String,
}

pub(super) struct ManagedDreamSkinImageBackup {
    path: PathBuf,
    bytes: Vec<u8>,
}

#[tauri::command]
pub fn list_dream_skin_themes()
-> CommandResult<codex_plus_core::dream_skin_library::DreamSkinThemeLibrary> {
    let settings = SettingsStore::default().load().unwrap_or_default();
    match current_dream_skin_library(&settings) {
        Ok(library) => ok("Dream Skin 主题库已加载。", library),
        Err(error) => failed(
            &format!("读取 Dream Skin 主题库失败：{error}"),
            empty_dream_skin_library(&settings),
        ),
    }
}

#[tauri::command]
pub async fn refresh_dream_skin_market() -> CommandResult<DreamSkinMarketPayload> {
    let state_dir = codex_plus_core::paths::default_app_state_dir();
    match codex_plus_core::dream_skin_market::load_market(&state_dir).await {
        Ok(load) => {
            let message = if load.cached {
                "已加载主题市场缓存。"
            } else {
                "主题市场已刷新。"
            };
            ok(message, dream_skin_market_payload(load))
        }
        Err(error) => failed(
            &format!("主题市场加载失败：{error}"),
            empty_dream_skin_market_payload(),
        ),
    }
}

#[tauri::command]
pub async fn refresh_dream_skin_community() -> CommandResult<DreamSkinCommunityPayload> {
    let state_dir = codex_plus_core::paths::default_app_state_dir();
    match codex_plus_core::dream_skin_community::load_community_catalog(&state_dir).await {
        Ok(catalog) => ok("DreamSkin 社区已刷新。", catalog),
        Err(error) => failed(
            &format!("DreamSkin 社区加载失败：{error}"),
            empty_dream_skin_community_payload(),
        ),
    }
}

#[tauri::command]
pub async fn install_dream_skin_community_theme(
    id: String,
) -> CommandResult<DreamSkinCommunityPayload> {
    let state_dir = codex_plus_core::paths::default_app_state_dir();
    let installed =
        match codex_plus_core::dream_skin_community::install_community_theme(&state_dir, id.trim())
            .await
        {
            Ok(installed) => installed,
            Err(error) => {
                return failed(
                    &format!("安装 DreamSkin 社区主题失败：{error}"),
                    codex_plus_core::dream_skin_community::load_community_catalog(&state_dir)
                        .await
                        .unwrap_or_else(|_| empty_dream_skin_community_payload()),
                );
            }
        };
    match codex_plus_core::dream_skin_community::load_community_catalog(&state_dir).await {
        Ok(mut catalog) => {
            catalog.installed_theme_id = installed.id;
            ok("主题已安装到“我的主题”。", catalog)
        }
        Err(_) => {
            let mut catalog = empty_dream_skin_community_payload();
            catalog.installed_theme_id = installed.id;
            ok("主题已安装到“我的主题”。", catalog)
        }
    }
}

#[tauri::command]
pub fn load_pending_dream_skin_community() -> CommandResult<PendingDreamSkinCommunityPayload> {
    match codex_plus_core::dream_skin_community::load_pending_community_link() {
        Ok(version_id) => ok(
            "待处理的一键换肤链接已读取。",
            PendingDreamSkinCommunityPayload {
                version_id: version_id.unwrap_or_default(),
            },
        ),
        Err(error) => failed(
            &format!("读取一键换肤链接失败：{error}"),
            PendingDreamSkinCommunityPayload {
                version_id: String::new(),
            },
        ),
    }
}

#[tauri::command]
pub async fn confirm_pending_dream_skin_community() -> CommandResult<DreamSkinCommunityPayload> {
    let version_id = match codex_plus_core::dream_skin_community::load_pending_community_link() {
        Ok(Some(version_id)) => version_id,
        Ok(None) => {
            return failed(
                "没有待处理的一键换肤链接。",
                empty_dream_skin_community_payload(),
            );
        }
        Err(error) => {
            return failed(
                &format!("读取一键换肤链接失败：{error}"),
                empty_dream_skin_community_payload(),
            );
        }
    };
    let state_dir = codex_plus_core::paths::default_app_state_dir();
    let installed = match codex_plus_core::dream_skin_community::install_community_theme(
        &state_dir,
        &version_id,
    )
    .await
    {
        Ok(installed) => installed,
        Err(error) => {
            return failed(
                &format!("安装 DreamSkin 社区主题失败：{error}"),
                codex_plus_core::dream_skin_community::load_community_catalog(&state_dir)
                    .await
                    .unwrap_or_else(|_| empty_dream_skin_community_payload()),
            );
        }
    };
    if let Err(error) = codex_plus_core::dream_skin_community::clear_pending_community_link() {
        return failed(
            &format!("主题已安装，但清理一键换肤记录失败：{error}"),
            codex_plus_core::dream_skin_community::load_community_catalog(&state_dir)
                .await
                .unwrap_or_else(|_| empty_dream_skin_community_payload()),
        );
    }
    let mut catalog = codex_plus_core::dream_skin_community::load_community_catalog(&state_dir)
        .await
        .unwrap_or_else(|_| empty_dream_skin_community_payload());
    catalog.installed_theme_id = installed.id;
    ok("主题已安装，正在应用。", catalog)
}

#[tauri::command]
pub fn dismiss_pending_dream_skin_community() -> CommandResult<PendingDreamSkinCommunityPayload> {
    match codex_plus_core::dream_skin_community::clear_pending_community_link() {
        Ok(()) => ok(
            "已取消一键换肤。",
            PendingDreamSkinCommunityPayload {
                version_id: String::new(),
            },
        ),
        Err(error) => failed(
            &format!("取消一键换肤失败：{error}"),
            PendingDreamSkinCommunityPayload {
                version_id: String::new(),
            },
        ),
    }
}

#[tauri::command]
pub fn import_dream_skin_theme_package(
    path: String,
) -> CommandResult<codex_plus_core::dream_skin_library::DreamSkinThemeLibrary> {
    let settings = SettingsStore::default().load().unwrap_or_default();
    let state_dir = codex_plus_core::paths::default_app_state_dir();
    match codex_plus_core::dream_skin_community::import_theme_package(
        &state_dir,
        Path::new(path.trim()),
    ) {
        Ok(_) => match current_dream_skin_library(&settings) {
            Ok(library) => ok("DreamSkin 主题包已导入。", library),
            Err(error) => failed(
                &format!("主题包已导入，但刷新主题库失败：{error}"),
                empty_dream_skin_library(&settings),
            ),
        },
        Err(error) => failed(
            &format!("导入 DreamSkin 主题包失败：{error}"),
            current_dream_skin_library(&settings)
                .unwrap_or_else(|_| empty_dream_skin_library(&settings)),
        ),
    }
}

#[tauri::command]
pub async fn install_dream_skin_market_theme(id: String) -> CommandResult<DreamSkinMarketPayload> {
    let id = id.trim();
    if id.is_empty() {
        return failed("主题 ID 不能为空。", empty_dream_skin_market_payload());
    }
    let state_dir = codex_plus_core::paths::default_app_state_dir();
    let load = match codex_plus_core::dream_skin_market::load_market(&state_dir).await {
        Ok(load) => load,
        Err(error) => {
            return failed(
                &format!("主题市场加载失败：{error}"),
                empty_dream_skin_market_payload(),
            );
        }
    };
    let Some(theme) = load.manifest.themes.iter().find(|theme| theme.id == id) else {
        return failed(
            "主题市场清单中未找到该主题。",
            dream_skin_market_payload(load),
        );
    };
    if let Err(error) =
        codex_plus_core::dream_skin_market::install_market_theme(&state_dir, theme).await
    {
        return failed(
            &format!("安装市场主题失败：{error}"),
            dream_skin_market_payload(load),
        );
    }
    let manifest =
        codex_plus_core::dream_skin_market::enrich_market_manifest(&state_dir, load.manifest);
    ok(
        "主题已安装到“我的主题”。",
        DreamSkinMarketPayload {
            schema_version: manifest.schema_version,
            updated_at: manifest.updated_at,
            repository_url: codex_plus_core::dream_skin_market::DEFAULT_MARKET_REPOSITORY_URL
                .to_string(),
            cached: load.cached,
            warning: load.warning.unwrap_or_default(),
            themes: manifest.themes,
        },
    )
}

#[tauri::command]
pub fn load_dream_skin_theme(
    id: String,
) -> CommandResult<codex_plus_core::dream_skin_library::DreamSkinThemeDraft> {
    match codex_plus_core::dream_skin_library::load_stored_dream_skin_theme(
        &codex_plus_core::paths::default_app_state_dir(),
        id.trim(),
    ) {
        Ok(draft) => ok("Dream Skin 主题已加载。", draft),
        Err(error) => failed(
            &format!("加载 Dream Skin 主题失败：{error}"),
            builtin_dream_skin_draft(),
        ),
    }
}

#[tauri::command]
pub fn create_dream_skin_theme(
    path: String,
) -> CommandResult<codex_plus_core::dream_skin_library::DreamSkinThemeDraft> {
    let source = PathBuf::from(path.trim());
    match codex_plus_core::dream_skin_library::create_dream_skin_theme_from_image(
        &source,
        &codex_plus_core::paths::default_app_state_dir(),
    ) {
        Ok(draft) => ok("Dream Skin 主题已创建。", draft),
        Err(error) => failed(
            &format!("创建 Dream Skin 主题失败：{error}"),
            builtin_dream_skin_draft(),
        ),
    }
}

#[tauri::command]
pub fn save_dream_skin_theme(
    draft: codex_plus_core::dream_skin_library::DreamSkinThemeDraft,
) -> CommandResult<codex_plus_core::dream_skin_library::DreamSkinThemeLibrary> {
    let settings = SettingsStore::default().load().unwrap_or_default();
    match codex_plus_core::dream_skin_library::save_dream_skin_theme(
        &codex_plus_core::paths::default_app_state_dir(),
        &draft,
    ) {
        Ok(_) => match current_dream_skin_library(&settings) {
            Ok(library) => ok("Dream Skin 主题已保存。", library),
            Err(error) => failed(
                &format!("主题已保存，但刷新主题库失败：{error}"),
                empty_dream_skin_library(&settings),
            ),
        },
        Err(error) => failed(
            &format!("保存 Dream Skin 主题失败：{error}"),
            current_dream_skin_library(&settings)
                .unwrap_or_else(|_| empty_dream_skin_library(&settings)),
        ),
    }
}

#[tauri::command]
pub fn rename_dream_skin_theme(
    id: String,
    name: String,
) -> CommandResult<codex_plus_core::dream_skin_library::DreamSkinThemeLibrary> {
    let settings = SettingsStore::default().load().unwrap_or_default();
    match codex_plus_core::dream_skin_library::rename_dream_skin_theme(
        &codex_plus_core::paths::default_app_state_dir(),
        id.trim(),
        name.trim(),
    ) {
        Ok(_) => match current_dream_skin_library(&settings) {
            Ok(library) => ok("Dream Skin 主题已重命名。", library),
            Err(error) => failed(
                &format!("主题已重命名，但刷新主题库失败：{error}"),
                empty_dream_skin_library(&settings),
            ),
        },
        Err(error) => failed(
            &format!("重命名 Dream Skin 主题失败：{error}"),
            current_dream_skin_library(&settings)
                .unwrap_or_else(|_| empty_dream_skin_library(&settings)),
        ),
    }
}

#[tauri::command]
pub fn delete_dream_skin_theme(
    id: String,
) -> CommandResult<codex_plus_core::dream_skin_library::DreamSkinThemeLibrary> {
    let settings = SettingsStore::default().load().unwrap_or_default();
    match codex_plus_core::dream_skin_library::delete_dream_skin_theme(
        &codex_plus_core::paths::default_app_state_dir(),
        id.trim(),
        Some(settings.codex_app_dream_skin_theme_config.id.as_str()),
    ) {
        Ok(()) => match current_dream_skin_library(&settings) {
            Ok(library) => ok("Dream Skin 主题已删除。", library),
            Err(error) => failed(
                &format!("主题已删除，但刷新主题库失败：{error}"),
                empty_dream_skin_library(&settings),
            ),
        },
        Err(error) => failed(
            &format!("删除 Dream Skin 主题失败：{error}"),
            current_dream_skin_library(&settings)
                .unwrap_or_else(|_| empty_dream_skin_library(&settings)),
        ),
    }
}

#[tauri::command]
pub async fn activate_dream_skin_theme(
    request: DreamSkinThemeActivationRequest,
) -> CommandResult<DreamSkinThemeActivationPayload> {
    let state_dir = codex_plus_core::paths::default_app_state_dir();
    let store = SettingsStore::default();
    let previous = store.load().unwrap_or_default();
    let previous_runtime_signature =
        codex_plus_core::assets::dream_skin_runtime_content_signature(&previous);
    let previous_path = PathBuf::from(previous.codex_app_dream_skin_image_path.trim());
    let previous_backup = managed_dream_skin_image_backup(&previous_path, &state_dir).ok();
    let activation = match codex_plus_core::dream_skin_library::prepare_dream_skin_activation(
        &state_dir,
        &request.draft,
    ) {
        Ok(activation) => activation,
        Err(error) => {
            return failed(
                &format!("准备 Dream Skin 主题失败：{error}"),
                failed_dream_skin_activation_payload(&previous, request.debug_port).await,
            );
        }
    };
    let theme = serde_json::to_value(&activation.config).unwrap_or_else(|_| json!({}));
    let saved = store.update(json!({
        "codexAppDreamSkinThemeConfig": theme,
        "codexAppDreamSkinImagePath": activation.active_image_path
    }));
    let settings = match saved {
        Ok(settings) => settings,
        Err(error) => {
            let _ = codex_plus_core::dream_skin::clear_managed_dream_skin_image(&state_dir);
            if let Some(backup) = previous_backup {
                let _ = restore_managed_dream_skin_image_backup(backup);
            }
            let _ = store.save(&previous);
            return failed(
                &format!("保存 Dream Skin 活动主题失败：{error}"),
                failed_dream_skin_activation_payload(&previous, request.debug_port).await,
            );
        }
    };

    let should_apply = settings.enhancements_enabled
        && settings.codex_app_dream_skin_enabled
        && !settings.codex_app_dream_skin_paused;
    let theme_changed = previous_runtime_signature
        != codex_plus_core::assets::dream_skin_runtime_content_signature(&settings);
    let (runtime, saved_for_next_launch, message) = if should_apply {
        if let Err(error) = codex_plus_core::dream_skin::sync_default_dream_skin_base_theme(
            true,
            &settings.codex_app_dream_skin_theme_config,
        ) {
            (
                codex_plus_core::dream_skin_runtime::dream_skin_status(request.debug_port).await,
                true,
                format!("主题已保存，下次启动生效；同步基础主题失败：{error}"),
            )
        } else if theme_changed {
            (
                codex_plus_core::dream_skin_runtime::DreamSkinRuntimeStatus::pending_restart(
                    true, false,
                ),
                true,
                "主题已保存；为避免不同主题样式残留，需要重启 Codex 后完整切换。".to_string(),
            )
        } else {
            match codex_plus_core::dream_skin_runtime::apply_dream_skin_live(
                request.debug_port,
                request.helper_port,
            )
            .await
            {
                Ok(runtime) => (runtime, false, "Dream Skin 主题已应用。".to_string()),
                Err(error) => (
                    codex_plus_core::dream_skin_runtime::dream_skin_status(request.debug_port)
                        .await,
                    true,
                    format!("主题已保存，下次启动生效；实时应用失败：{error}"),
                ),
            }
        }
    } else {
        (
            codex_plus_core::dream_skin_runtime::dream_skin_status(request.debug_port).await,
            true,
            "主题已保存，下次启用或启动 Codex 时生效。".to_string(),
        )
    };
    let library = current_dream_skin_library(&settings)
        .unwrap_or_else(|_| empty_dream_skin_library(&settings));
    ok(
        &message,
        DreamSkinThemeActivationPayload {
            library,
            runtime,
            saved_for_next_launch,
        },
    )
}

#[tauri::command]
pub async fn dream_skin_status(
    request: DreamSkinRuntimeRequest,
) -> CommandResult<codex_plus_core::dream_skin_runtime::DreamSkinRuntimeStatus> {
    ok(
        "Dream Skin 状态已刷新。",
        codex_plus_core::dream_skin_runtime::dream_skin_status(request.debug_port).await,
    )
}

#[tauri::command]
pub async fn restore_dream_skin(
    request: DreamSkinRuntimeRequest,
) -> CommandResult<codex_plus_core::dream_skin_runtime::DreamSkinRuntimeStatus> {
    let store = SettingsStore::default();
    if let Err(error) = codex_plus_core::dream_skin::sync_default_dream_skin_base_theme(
        false,
        &codex_plus_core::settings::DreamSkinThemeConfig::default(),
    ) {
        return failed(
            &format!("恢复 Codex 原始外观失败：{error}"),
            codex_plus_core::dream_skin_runtime::dream_skin_status(request.debug_port).await,
        );
    }
    if let Err(error) = store.update(json!({
        "codexAppDreamSkinEnabled": false,
        "codexAppDreamSkinPaused": false
    })) {
        return failed(
            &format!("保存恢复状态失败：{error}"),
            codex_plus_core::dream_skin_runtime::DreamSkinRuntimeStatus::not_running(false, false),
        );
    }
    let live = codex_plus_core::dream_skin_runtime::pause_dream_skin_live(request.debug_port).await;
    let status =
        codex_plus_core::dream_skin_runtime::DreamSkinRuntimeStatus::pending_restart(false, false);
    match live {
        Ok(()) => ok("外观配置已恢复，重启 Codex 后完整生效。", status),
        Err(error) => ok(
            &format!("外观配置已恢复，重启 Codex 后完整生效；当前无法清理实时皮肤：{error}"),
            status,
        ),
    }
}

#[tauri::command]
pub async fn verify_dream_skin(
    request: DreamSkinRuntimeRequest,
) -> CommandResult<codex_plus_core::dream_skin_runtime::DreamSkinVerification> {
    let screenshot = request
        .screenshot_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(Path::new);
    match codex_plus_core::dream_skin_runtime::verify_dream_skin(request.debug_port, screenshot)
        .await
    {
        Ok(result) if result.pass => ok("Dream Skin 实机验证通过。", result),
        Ok(result) => failed("Dream Skin 实机验证未通过。", result),
        Err(error) => failed(
            &format!("Dream Skin 实机验证失败：{error}"),
            codex_plus_core::dream_skin_runtime::DreamSkinVerification {
                state: codex_plus_core::dream_skin_runtime::DreamSkinState::NotRunning,
                pass: false,
                version: None,
                checks: Vec::new(),
                screenshot_path: None,
                raw: json!({}),
            },
        ),
    }
}

fn dream_skin_market_payload(
    load: codex_plus_core::dream_skin_market::DreamSkinMarketLoad,
) -> DreamSkinMarketPayload {
    DreamSkinMarketPayload {
        schema_version: load.manifest.schema_version,
        updated_at: load.manifest.updated_at,
        repository_url: codex_plus_core::dream_skin_market::DEFAULT_MARKET_REPOSITORY_URL
            .to_string(),
        cached: load.cached,
        warning: load.warning.unwrap_or_default(),
        themes: load.manifest.themes,
    }
}

fn empty_dream_skin_market_payload() -> DreamSkinMarketPayload {
    DreamSkinMarketPayload {
        schema_version: 1,
        updated_at: String::new(),
        repository_url: codex_plus_core::dream_skin_market::DEFAULT_MARKET_REPOSITORY_URL
            .to_string(),
        cached: false,
        warning: String::new(),
        themes: Vec::new(),
    }
}

fn empty_dream_skin_community_payload() -> DreamSkinCommunityPayload {
    DreamSkinCommunityPayload {
        items: Vec::new(),
        total: 0,
        fetched_at: String::new(),
        cached: false,
        warning: String::new(),
        installed_theme_id: String::new(),
    }
}

fn default_dream_skin_helper_port() -> u16 {
    codex_plus_core::protocol_proxy::DEFAULT_PROTOCOL_PROXY_PORT
}

fn current_dream_skin_library(
    settings: &BackendSettings,
) -> anyhow::Result<codex_plus_core::dream_skin_library::DreamSkinThemeLibrary> {
    codex_plus_core::dream_skin_library::list_dream_skin_themes(
        &codex_plus_core::paths::default_app_state_dir(),
        settings,
    )
}

fn builtin_dream_skin_draft() -> codex_plus_core::dream_skin_library::DreamSkinThemeDraft {
    codex_plus_core::dream_skin_library::DreamSkinThemeDraft {
        config: codex_plus_core::settings::DreamSkinThemeConfig::default(),
        image_path: String::new(),
        builtin: true,
    }
}

pub(super) fn empty_dream_skin_library(
    settings: &BackendSettings,
) -> codex_plus_core::dream_skin_library::DreamSkinThemeLibrary {
    codex_plus_core::dream_skin_library::DreamSkinThemeLibrary {
        themes: Vec::new(),
        active_draft: codex_plus_core::dream_skin_library::DreamSkinThemeDraft {
            config: settings.codex_app_dream_skin_theme_config.clone(),
            image_path: settings.codex_app_dream_skin_image_path.clone(),
            builtin: false,
        },
    }
}

async fn failed_dream_skin_activation_payload(
    settings: &BackendSettings,
    debug_port: u16,
) -> DreamSkinThemeActivationPayload {
    DreamSkinThemeActivationPayload {
        library: current_dream_skin_library(settings)
            .unwrap_or_else(|_| empty_dream_skin_library(settings)),
        runtime: codex_plus_core::dream_skin_runtime::dream_skin_status(debug_port).await,
        saved_for_next_launch: false,
    }
}

pub(super) fn managed_dream_skin_image_backup(
    path: &Path,
    state_dir: &Path,
) -> anyhow::Result<ManagedDreamSkinImageBackup> {
    if !codex_plus_core::dream_skin::is_managed_dream_skin_image(path, state_dir) {
        anyhow::bail!("Dream Skin image is not managed by Codex++");
    }
    Ok(ManagedDreamSkinImageBackup {
        path: path.to_path_buf(),
        bytes: fs::read(path)?,
    })
}

pub(super) fn restore_managed_dream_skin_image_backup(
    backup: ManagedDreamSkinImageBackup,
) -> anyhow::Result<()> {
    codex_plus_core::settings::atomic_write(&backup.path, &backup.bytes)
}
