//! 隔离官方 App 验收入口；状态、Codex 配置和 Electron 数据均写入指定临时目录。
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
    ensure!(root.is_absolute(), "验收目录必须使用绝对路径");
    let resolved_root = root.canonicalize().context("验收目录必须已存在")?;
    let resolved_temp = std::env::temp_dir().canonicalize()?;
    ensure!(
        resolved_root.starts_with(&resolved_temp) && resolved_root != resolved_temp,
        "验收目录必须是系统临时目录中的独立目录"
    );
    let state = root.join("state");
    let home = root.join("codex-home");
    std::fs::create_dir_all(&state)?;
    std::fs::create_dir_all(&home)?;
    ensure!(
        std::env::var_os("CODEX_PLUS_STATE_DIR").map(PathBuf::from) == Some(state.clone()),
        "需要显式隔离 CODEX_PLUS_STATE_DIR"
    );
    ensure!(
        std::env::var_os("CODEX_HOME").map(PathBuf::from) == Some(home.clone()),
        "需要显式隔离 CODEX_HOME"
    );
    ensure!(
        std::env::var("CODEX_PLUS_MULTI_INSTANCE").as_deref() == Ok("1"),
        "需要 CODEX_PLUS_MULTI_INSTANCE=1"
    );
    let settings = BackendSettings {
        codex_app_path: app.to_string_lossy().into_owned(),
        codex_extra_args: vec![format!(
            "--user-data-dir={}",
            root.join("electron").display()
        )],
        provider_sync_enabled: false,
        relay_profiles_enabled: false,
        codex_app_force_chinese_locale: true,
        ..BackendSettings::default()
    };
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
