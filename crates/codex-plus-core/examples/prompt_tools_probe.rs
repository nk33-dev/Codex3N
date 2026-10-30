//! 隔离客户端验收入口：只复制提示词服务配置，项目和收藏均留在临时目录。
use std::path::PathBuf;

use anyhow::{Context, ensure};
use codex_plus_core::launcher::{LaunchOptions, launch_and_inject};
use codex_plus_core::settings::{BackendSettings, SettingsStore};
use codex_plus_core::status::StatusStore;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut args = std::env::args().skip(1);
    let app = PathBuf::from(args.next().context("需要官方 App 目录")?);
    let root = PathBuf::from(args.next().context("需要临时验收目录")?);
    let port: u16 = args.next().context("需要调试端口")?.parse()?;
    let source = PathBuf::from(args.next().context("需要已保存的设置文件")?);
    let resolved_root = root.canonicalize()?;
    let resolved_temp = std::env::temp_dir().canonicalize()?;
    ensure!(
        resolved_root.starts_with(&resolved_temp) && resolved_root != resolved_temp,
        "验收目录必须位于系统临时目录下"
    );
    let state = root.join("state");
    let home = root.join("codex-home");
    ensure!(
        std::env::var_os("CODEX_PLUS_STATE_DIR").map(PathBuf::from) == Some(state.clone()),
        "需要隔离 CODEX_PLUS_STATE_DIR"
    );
    ensure!(
        std::env::var_os("CODEX_HOME").map(PathBuf::from) == Some(home.clone()),
        "需要隔离 CODEX_HOME"
    );
    ensure!(
        std::env::var("CODEX_PLUS_MULTI_INSTANCE").as_deref() == Ok("1"),
        "需要隔离多开模式"
    );
    ensure!(
        !source.canonicalize()?.starts_with(&resolved_root),
        "源设置必须位于验收目录之外"
    );
    std::fs::create_dir_all(&state)?;
    #[cfg(windows)]
    if let Some(source_dir) = source.parent() {
        // Windows 的设置密文依赖同目录 DPAPI 主密钥；复制受保护文件后才能复用服务连接。
        let key = source_dir.join("secret.key");
        if key.is_file() {
            let target_key = state.join("secret.key");
            if target_key.exists() {
                ensure!(
                    std::fs::read(&key)? == std::fs::read(&target_key)?,
                    "验收目录使用另一份凭据，请新建临时目录"
                );
            } else {
                std::fs::copy(key, target_key)?;
            }
        }
    }
    let saved = SettingsStore::new(source).try_load_cached()?;
    let mut settings = BackendSettings {
        codex_app_path: app.to_string_lossy().into_owned(),
        codex_extra_args: vec![format!(
            "--user-data-dir={}",
            root.join("electron").display()
        )],
        provider_sync_enabled: false,
        relay_profiles_enabled: false,
        ..BackendSettings::default()
    };
    settings.prompt_enhance = saved.prompt_enhance.clone();
    settings.prompt_enhance.enabled = true;
    settings.prompt_enhance.rewrite_enabled = true;
    settings.prompt_enhance.grill_enabled = true;
    settings.prompt_enhance.context.enabled = true;
    settings.prompt_enhance.context.project = true;
    settings.prompt_enhance.context.instructions = true;
    settings.codex_app_stepwise_base_url = saved.codex_app_stepwise_base_url.clone();
    settings.codex_app_stepwise_api_key = saved.codex_app_stepwise_api_key.clone();
    settings.codex_app_stepwise_api_key_env = saved.codex_app_stepwise_api_key_env.clone();
    settings.codex_app_stepwise_model = saved.codex_app_stepwise_model.clone();
    settings.codex_app_stepwise_protocol = saved.codex_app_stepwise_protocol.clone();
    std::fs::create_dir_all(&state)?;
    std::fs::create_dir_all(&home)?;
    SettingsStore::new(state.join("settings.json")).save(&settings)?;
    let handle = launch_and_inject(LaunchOptions {
        app_dir: Some(app),
        debug_port: port,
        helper_port: port + 1,
        state_dir: Some(state.clone()),
        codex_home: Some(home.clone()),
        sqlite_home: Some(home),
        replace_blocking_main_instance: false,
        status_store: StatusStore::new(state.join("latest-status.json")),
    })
    .await?;
    println!("ready port={port}");
    handle.wait_for_codex_exit().await
}
