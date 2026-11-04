//! 轻量模式：开启后收起并释放管理器主窗口，后续按需重建界面。
//! 后端进程、2.0 网关、托盘、托盘快捷面板、guard 端口等照常运行；
//! 托盘、Dock、二次启动等入口再打开时按原配置重建主窗口（见 `crate::show_main_window`）。
//!
//! 开关默认关闭，沿用 gateway.json 的 `lightweightOnClose` 键；开启后下次启动不建主窗口。
//! 设置页和托盘共用保存入口，托盘开启前由主界面确认未保存的草稿。
//!
//! 关窗时先隐藏，稍等再销毁；等待期间重新打开或聚焦窗口会取消销毁。
//! 未保存草稿只在当前 WebView 内存中，销毁前需由用户保存。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, Emitter, Listener, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow,
};

/// 主窗口前端注册好托盘请求监听后发出：快捷面板的请求可以发过去了。
pub const MAIN_WINDOW_READY_EVENT: &str = "codex-plus-main-window-ready";
pub const MODE_CHANGED_EVENT: &str = "codex-plus-lightweight-mode-changed";
pub const MODE_REQUESTED_EVENT: &str = "codex-plus-lightweight-mode-requested";
static MODE_UPDATE_LOCK: Mutex<()> = Mutex::new(());
/// 隐藏后留出短暂恢复窗口的时间。
const RELEASE_DELAY: Duration = Duration::from_secs(3);
/// 快捷面板等重建的主窗口前端加载好的上限。
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const READY_POLL: Duration = Duration::from_millis(50);

/// 开关的内存缓存：关窗时不必读盘，启动后第一次用到时读一次，之后只在设置里切换时更新。
static ENABLED: OnceLock<AtomicBool> = OnceLock::new();
/// 主窗口前端是否已就绪（监听已注册）。新建窗口和窗口销毁时清掉，收到就绪事件时置位。
static MAIN_WINDOW_READY: AtomicBool = AtomicBool::new(false);
/// 销毁计划的代号：每次排期或取消都加一，到点时代号变了就说明这次计划已作废。
static RELEASE_GENERATION: AtomicU64 = AtomicU64::new(0);
/// 销毁前记下的窗口位置与大小，重建时恢复，免得每次都回到默认尺寸。
static LAST_GEOMETRY: Mutex<Option<Geometry>> = Mutex::new(None);

#[derive(Debug, Clone, Copy)]
struct Geometry {
    /// 非最大化时的外框位置与内容区大小；最大化时不更新，保留最大化前的值。
    bounds: Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>,
    maximized: bool,
}

fn read_enabled_from_disk() -> bool {
    codex_plus_core::gateway::store::GatewayStore::default()
        .load()
        .map(|settings| settings.lightweight_on_close)
        .unwrap_or(false)
}

fn cache() -> &'static AtomicBool {
    ENABLED.get_or_init(|| AtomicBool::new(read_enabled_from_disk()))
}

/// 是否开启了轻量模式（读缓存）。
pub fn enabled() -> bool {
    cache().load(Ordering::Relaxed)
}

/// 监听主窗口前端的就绪事件。setup 里调用一次。
pub fn install_ready_listener<R: Runtime>(app: &AppHandle<R>) {
    app.listen_any(MAIN_WINDOW_READY_EVENT, |_| {
        MAIN_WINDOW_READY.store(true, Ordering::SeqCst);
    });
}

/// 新建主窗口或主窗口销毁后，前端需要重新加载。
pub fn mark_main_window_loading() {
    MAIN_WINDOW_READY.store(false, Ordering::SeqCst);
}

/// 取消尚未执行的销毁（窗口被重新打开、获得焦点或要处理快捷面板的请求）。
pub fn cancel_pending_release() {
    RELEASE_GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// 主窗口隐藏后排期销毁。轻量模式关闭时什么都不做（保持只隐藏的旧行为）。
pub fn schedule_release<R: Runtime>(app: &AppHandle<R>) {
    if !enabled() {
        return;
    }
    let generation = RELEASE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(RELEASE_DELAY);
        let handle = app.clone();
        // 与重建、显示窗口一样在主线程上执行，互相之间不会交错。
        let _ = app.run_on_main_thread(move || release_if_hidden(&handle, generation));
    });
}

fn release_if_hidden<R: Runtime>(app: &AppHandle<R>, generation: u64) {
    if RELEASE_GENERATION.load(Ordering::SeqCst) != generation
        || !enabled()
        || crate::app_is_exiting()
    {
        return;
    }
    let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL) else {
        return;
    };
    // 拿不到可见状态时按可见处理，宁可不销毁。
    if window.is_visible().unwrap_or(true) {
        return;
    }
    mark_main_window_loading();
    let result = window.destroy();
    let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
        "manager.lightweight_release",
        serde_json::json!({ "ok": result.is_ok() }),
    );
}

/// 关窗前记下位置和大小。最小化时的坐标不可信（Windows 上是 -32000），不记。
pub fn remember_geometry<R: Runtime>(window: &WebviewWindow<R>) {
    if !enabled() || window.is_minimized().unwrap_or(false) {
        return;
    }
    let maximized = window.is_maximized().unwrap_or(false);
    let Ok(mut slot) = LAST_GEOMETRY.lock() else {
        return;
    };
    let previous = slot.and_then(|geometry| geometry.bounds);
    let bounds = if maximized {
        previous
    } else {
        match (window.outer_position(), window.inner_size()) {
            (Ok(position), Ok(size)) => Some((position, size)),
            _ => previous,
        }
    };
    *slot = Some(Geometry { bounds, maximized });
}

/// 重建的窗口恢复上次的位置与大小（窗口仍隐藏）。位置不在任何屏幕上时（例如外接屏已拔掉）只恢复大小。
pub fn restore_geometry<R: Runtime>(window: &WebviewWindow<R>) {
    let Some((position, size)) = LAST_GEOMETRY
        .lock()
        .ok()
        .and_then(|slot| slot.and_then(|geometry| geometry.bounds))
    else {
        return;
    };
    let _ = window.set_size(size);
    let on_screen = window.available_monitors().is_ok_and(|monitors| {
        monitors.iter().any(|monitor| {
            let origin = monitor.position();
            let extent = monitor.size();
            // 标题栏附近的一点落在屏幕内即可拖回来。
            let x = position.x + 40;
            let y = position.y + 10;
            x >= origin.x
                && y >= origin.y
                && x < origin.x + extent.width as i32
                && y < origin.y + extent.height as i32
        })
    });
    if on_screen {
        let _ = window.set_position(position);
    }
}

/// 上次关窗时是否最大化。只在重建后第一次显示时使用（隐藏状态下最大化在部分平台会直接显示窗口）。
pub fn was_maximized() -> bool {
    LAST_GEOMETRY
        .lock()
        .ok()
        .and_then(|slot| slot.map(|geometry| geometry.maximized))
        .unwrap_or(false)
}

fn wait_until_ready(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if MAIN_WINDOW_READY.load(Ordering::SeqCst) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(READY_POLL);
    }
}

/// 快捷面板发请求前调用：主窗口不在就按原配置重建（保持隐藏），等前端注册好监听再返回。
/// 返回主窗口是否就绪；超时也返回，面板照常发请求，由面板自己的超时兜底。
#[tauri::command]
pub async fn main_window_prepare<R: Runtime>(app: AppHandle<R>) -> bool {
    // 有请求要处理：先别销毁，处理完由主窗口重新排期。
    cancel_pending_release();
    let handle = app.clone();
    // 创建窗口放到主线程（同步命令里建窗口在 Windows 上会死锁），也和销毁串行。
    let _ = app.run_on_main_thread(move || {
        crate::ensure_main_window(&handle);
    });
    tauri::async_runtime::spawn_blocking(|| wait_until_ready(READY_TIMEOUT))
        .await
        .unwrap_or(false)
}

/// 主窗口在后台处理完事情（启动时最小化、快捷面板的请求）后调用：仍隐藏着就按轻量模式排期销毁。
#[tauri::command]
pub fn main_window_release_when_hidden<R: Runtime>(app: AppHandle<R>) {
    let hidden = app
        .get_webview_window(crate::MAIN_WINDOW_LABEL)
        .is_some_and(|window| !window.is_visible().unwrap_or(true));
    if hidden {
        schedule_release(&app);
    }
}

/// 整体设置里读开关当前的值。
#[tauri::command]
pub fn lightweight_mode_enabled() -> bool {
    enabled()
}

/// 整体设置里切换开关：写回 gateway.json 的 `lightweightOnClose`，更新缓存。返回保存后的值。
#[tauri::command]
pub fn set_lightweight_mode_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<bool, String> {
    // 写盘、缓存和通知必须同序，否则并发重读会把新值的事件发在旧值之前。
    let _guard = MODE_UPDATE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    codex_plus_core::gateway::store::GatewayStore::default()
        .update(|settings| {
            settings.lightweight_on_close = enabled;
            Ok(())
        })
        .map_err(|error| format!("保存失败：{error:#}"))?;
    cache().store(enabled, Ordering::Relaxed);
    if !enabled {
        cancel_pending_release();
    }
    let _ = app.emit(MODE_CHANGED_EVENT, enabled);
    drop(_guard);
    crate::gateway_commands::notify_settings_changed();
    let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
        "manager.lightweight_mode",
        serde_json::json!({ "enabled": enabled, "source": "set" }),
    );
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        crate::sync_lightweight_tray(&handle);
        if enabled && self::enabled() {
            crate::hide_main_window(&handle);
        }
    });
    Ok(enabled)
}

pub fn request_from_tray<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if !enabled()
        && let Some(window) = app.get_webview_window(crate::MAIN_WINDOW_LABEL)
    {
        // 确认草稿由主界面完成；没有就绪监听时保留原状态，避免直接丢弃草稿。
        crate::sync_lightweight_tray(app);
        if !MAIN_WINDOW_READY.load(Ordering::SeqCst) {
            return Err("界面仍在加载，请稍后重试".into());
        }
        window
            .emit(MODE_REQUESTED_EVENT, ())
            .map_err(|error| error.to_string())?;
        return Ok(());
    }
    set_lightweight_mode_enabled(app.clone(), !enabled()).map(|_| ())
}

/// 重新从 gateway.json 读开关（例如导入了设置）。
pub fn refresh_from_disk<R: Runtime>(app: &AppHandle<R>) {
    let _guard = MODE_UPDATE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let saved = match codex_plus_core::gateway::store::GatewayStore::default().load() {
        Ok(settings) => settings.lightweight_on_close,
        Err(error) => {
            let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                "manager.lightweight_read_failed",
                serde_json::json!({ "message": error.to_string() }),
            );
            return;
        }
    };
    cache().store(saved, Ordering::Relaxed);
    let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
        "manager.lightweight_mode",
        serde_json::json!({ "enabled": saved, "source": "refresh" }),
    );
    if !saved {
        cancel_pending_release();
    }
    let _ = app.emit(MODE_CHANGED_EVENT, enabled());
    drop(_guard);
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || crate::sync_lightweight_tray(&handle));
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use tauri::menu::CheckMenuItem;

    #[test]
    fn lightweight_menu_updates_persist_and_failed_writes_keep_state() {
        // 单独进程隔离状态目录与全局缓存，测试不接触用户网关。
        if std::env::var_os("CODEX_LIGHTWEIGHT_PROBE").is_none() {
            let temp = tempfile::tempdir().unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .creation_flags(codex_plus_core::windows_create_no_window())
                .args(["--exact", "lightweight::tests::lightweight_menu_updates_persist_and_failed_writes_keep_state", "--nocapture"])
                .env("CODEX_LIGHTWEIGHT_PROBE", "1")
                .env("CODEX_PLUS_STATE_DIR", temp.path())
                .output().unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let item = CheckMenuItem::with_id(
            &app,
            crate::TRAY_MENU_LIGHTWEIGHT,
            "轻量模式",
            true,
            false,
            None::<&str>,
        )
        .unwrap();
        let _menu = tauri::menu::Menu::with_items(&app, &[&item]).unwrap();
        app.manage(item.clone());
        let events = std::sync::Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        app.listen_any(MODE_CHANGED_EVENT, move |event| {
            captured.lock().unwrap().push(event.payload().to_string());
        });
        set_lightweight_mode_enabled(app.handle().clone(), true).unwrap();
        assert!(item.is_checked().unwrap());
        assert!(read_enabled_from_disk());
        assert_eq!(*events.lock().unwrap(), ["true"]);
        item.set_text("Lightweight mode").unwrap();
        let _translated_menu = tauri::menu::Menu::with_items(&app, &[&item]).unwrap();
        assert!(item.is_checked().unwrap());
        set_lightweight_mode_enabled(app.handle().clone(), false).unwrap();
        assert!(!item.is_checked().unwrap());
        assert!(!read_enabled_from_disk());
        set_lightweight_mode_enabled(app.handle().clone(), true).unwrap();
        let store = codex_plus_core::gateway::store::GatewayStore::default();
        store
            .update(|settings| {
                settings.lightweight_on_close = false;
                Ok(())
            })
            .unwrap();
        refresh_from_disk(app.handle());
        assert!(!item.is_checked().unwrap());
        assert!(!enabled());
        // mock 会在调用线程直接执行主线程任务，并发用例不挂载原生菜单。
        let concurrent_app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let captured = events.clone();
        concurrent_app.listen_any(MODE_CHANGED_EVENT, move |event| {
            captured.lock().unwrap().push(event.payload().to_string());
        });
        std::thread::scope(|scope| {
            for index in 0..20 {
                let app = concurrent_app.handle().clone();
                scope.spawn(move || {
                    set_lightweight_mode_enabled(app, index % 2 == 0).unwrap();
                });
            }
        });
        assert_eq!(enabled(), read_enabled_from_disk());
        // 原生菜单只在测试线程核对最终状态。
        crate::sync_lightweight_tray(app.handle());
        assert_eq!(item.is_checked().unwrap(), enabled());
        assert_eq!(
            events.lock().unwrap().last().unwrap(),
            &enabled().to_string()
        );
        set_lightweight_mode_enabled(app.handle().clone(), true).unwrap();
        let path = codex_plus_core::paths::default_app_state_dir().join("gateway.json");
        std::fs::write(&path, "invalid json").unwrap();
        refresh_from_disk(app.handle());
        assert!(set_lightweight_mode_enabled(app.handle().clone(), false).is_err());
        assert!(enabled());
        assert!(item.is_checked().unwrap());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "invalid json");
    }
}
