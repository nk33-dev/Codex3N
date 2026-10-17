//! Windows 隔离实例退出采样：按调试端口与可执行文件核对归属后记录子进程，等待主进程退出。
#[cfg(windows)]
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use anyhow::{Context, ensure};
    use std::path::PathBuf;
    let mut args = std::env::args().skip(1);
    let app = PathBuf::from(args.next().context("需要官方 App 目录")?);
    let root = PathBuf::from(args.next().context("需要临时验收目录")?).canonicalize()?;
    let temp = std::env::temp_dir().canonicalize()?;
    ensure!(
        root.starts_with(&temp) && root != temp,
        "验收目录必须位于系统临时目录内"
    );
    let port: u16 = args.next().context("需要调试端口")?.parse()?;
    let terminate = args.any(|arg| arg == "--terminate");
    let executable = codex_plus_core::app_paths::build_codex_executable(&app);
    let expected = executable.canonicalize()?;
    let candidates = codex_plus_core::watcher::find_codex_processes_for_debug_port(port);
    let candidates = codex_plus_core::windows_enumerate_processes()
        .into_iter()
        .filter(|process| {
            candidates.contains(&process.process_id)
                && !candidates.contains(&process.parent_process_id)
                && process
                    .executable_path
                    .as_ref()
                    .and_then(|path| path.canonicalize().ok())
                    .as_ref()
                    == Some(&expected)
        })
        .collect::<Vec<_>>();
    ensure!(
        candidates.len() == 1,
        "无法唯一确认调试端口对应的 App 主进程，候选数 {}",
        candidates.len()
    );
    let pid = candidates[0].process_id;
    use codex_plus_core::watcher::{ProcessInstanceState, inspect_process_instance};
    let ProcessInstanceState::Running {
        birth_id: Some(birth),
        ..
    } = inspect_process_instance(pid)
    else {
        anyhow::bail!("无法确认主进程代际");
    };
    use codex_plus_core::launcher::{CodexLaunch, DefaultLaunchHooks, LaunchHooks};
    let hooks = DefaultLaunchHooks::default();
    let monitor = if terminate {
        ensure!(
            std::env::var_os("CODEX_PLUS_STATE_DIR")
                .map(PathBuf::from)
                .and_then(|path| path.canonicalize().ok())
                == Some(root.join("state")),
            "主动退出需显式隔离状态目录"
        );
        hooks.capture_injected_launch_identity(port).await;
        None
    } else {
        Some(
            codex_plus_core::owned_processes::ChildMonitor::start(
                port,
                root.join("state"),
                executable,
            )
            .context("当前平台不支持子进程监测")?,
        )
    };
    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    println!("monitoring pid={pid} port={port}");
    if terminate {
        ensure!(
            matches!(inspect_process_instance(pid), ProcessInstanceState::Running { birth_id: Some(current), .. } if current == birth),
            "主动退出前主进程代际发生变化"
        );
        hooks
            .terminate_codex(&CodexLaunch::PackagedActivation {
                app_user_model_id: "isolated-probe".into(),
                arguments: String::new(),
                process_id: Some(pid),
            })
            .await;
    } else {
        loop {
            match inspect_process_instance(pid) {
                ProcessInstanceState::NotRunning => break,
                ProcessInstanceState::Running {
                    birth_id: Some(current),
                    ..
                } if current != birth => break,
                _ => {}
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        if let Some(monitor) = monitor {
            monitor.finish().await;
        }
    }
    let report = codex_plus_core::owned_processes::report(&[root.join("state")])?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}

#[cfg(not(windows))]
fn main() -> anyhow::Result<()> {
    anyhow::bail!("此验收入口只支持 Windows；macOS 需在真机单独验证")
}
