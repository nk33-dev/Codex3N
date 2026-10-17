use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProcessIdentity {
    pid: u32,
    parent: u32,
    birth: String,
    started: u64,
    executable: PathBuf,
    kind: String,
}

#[derive(Clone)]
struct Process {
    identity: ProcessIdentity,
    arguments: Vec<String>,
    memory: Option<u64>,
    zombie: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Receipt {
    root: ProcessIdentity,
    children: Vec<ProcessIdentity>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessReport {
    pub supported: bool,
    pub processes: Vec<ProcessRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessRow {
    pub pid: u32,
    pub kind: String,
    pub memory_bytes: Option<u64>,
    pub disconnected: bool,
    pub zombie: bool,
    pub can_cleanup: bool,
}

pub(crate) fn child_kind(executable: &Path, arguments: &[String]) -> Option<&'static str> {
    let name = executable.file_name()?.to_str()?.to_ascii_lowercase();
    match name.as_str() {
        "codex.exe" | "codex" if arguments.get(1).is_some_and(|arg| arg == "app-server") => {
            Some("app-server")
        }
        "node.exe" | "node" => Some("node"),
        _ => None,
    }
}

fn same_process(a: &ProcessIdentity, b: &ProcessIdentity) -> bool {
    a.pid == b.pid && !a.birth.is_empty() && a.birth == b.birth && a.executable == b.executable
}

fn descendants(snapshot: &[Process], root: &ProcessIdentity) -> HashSet<u32> {
    let by_pid: HashMap<_, _> = snapshot.iter().map(|p| (p.identity.pid, p)).collect();
    let mut result = HashSet::new();
    for process in snapshot {
        let mut current = &process.identity;
        let mut visited = HashSet::new();
        while visited.insert(current.pid) {
            if current.pid == root.pid {
                if same_process(current, root) && process.identity.pid != root.pid {
                    result.insert(process.identity.pid);
                }
                break;
            }
            let Some(parent) = by_pid.get(&current.parent) else {
                break;
            };
            // 缺少代际证据或父进程比子进程晚启动时，不能沿该链认领。
            if current.birth.is_empty()
                || parent.identity.birth.is_empty()
                || current.started < parent.identity.started
            {
                break;
            }
            current = &parent.identity;
        }
    }
    result
}

fn update_receipt(receipt: &mut Receipt, snapshot: &[Process]) {
    let descendants = descendants(snapshot, &receipt.root);
    for process in snapshot {
        if descendants.contains(&process.identity.pid)
            && process.identity.started >= receipt.root.started
            && !receipt
                .children
                .iter()
                .any(|old| same_process(old, &process.identity))
        {
            receipt.children.push(process.identity.clone());
        }
    }
    receipt
        .children
        .retain(|old| snapshot.iter().any(|p| same_process(old, &p.identity)));
    receipt.children.sort_by_key(|p| p.pid);
}

fn disconnected(process: &Process, snapshot: &[Process]) -> bool {
    !snapshot
        .iter()
        .any(|parent| parent.identity.pid == process.identity.parent)
        || cfg!(target_os = "macos") && process.identity.parent == 1
}

fn receipt_path(directory: &Path, root: &ProcessIdentity) -> PathBuf {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(format!("{}:{}", root.pid, root.birth));
    directory
        .join("owned-app-children")
        .join(format!("{:x}.json", hash))
}

fn save(directory: &Path, receipt: &Receipt) {
    if let Ok(bytes) = serde_json::to_vec(receipt) {
        let path = receipt_path(directory, &receipt.root);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = crate::settings::atomic_write(&path, &bytes);
    }
}

fn root_alive(receipt: &Receipt, snapshot: &[Process]) -> bool {
    snapshot.iter().any(|p| {
        (same_process(&receipt.root, &p.identity)
            || p.identity.pid == receipt.root.pid && p.identity.birth.is_empty())
            && !p.zombie
    })
}

fn cleanup_candidates(
    receipt: &Receipt,
    snapshot: &[Process],
    manual: bool,
) -> Vec<ProcessIdentity> {
    let alive = root_alive(receipt, snapshot);
    if alive && !manual {
        return Vec::new();
    }
    let mut killed = Vec::new();
    for expected in receipt.children.iter().rev() {
        let Some(process) = snapshot
            .iter()
            .find(|p| same_process(expected, &p.identity))
        else {
            continue;
        };
        if process.zombie
            || process.identity.kind != expected.kind
            || !matches!(expected.kind.as_str(), "app-server" | "node")
        {
            continue;
        }
        if manual && (expected.kind != "app-server" || !disconnected(process, snapshot)) {
            continue;
        }
        // 子进程被另一个仍存活的非本实例父进程接管时，不自动结束。
        if !manual
            && snapshot.iter().any(|p| {
                p.identity.pid == process.identity.parent
                    && p.identity.pid != receipt.root.pid
                    && !receipt
                        .children
                        .iter()
                        .any(|old| same_process(old, &p.identity))
                    && process.identity.parent != 1
            })
        {
            continue;
        }
        killed.push(expected.clone());
    }
    killed
}

fn cleanup(receipt: &Receipt, snapshot: &[Process], manual: bool) -> Vec<u32> {
    let killed: Vec<_> = cleanup_candidates(receipt, snapshot, manual)
        .iter()
        .filter(|p| terminate(p))
        .map(|p| p.pid)
        .collect();
    if !killed.is_empty() {
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "process_cleanup.completed",
            serde_json::json!({ "root_pid": receipt.root.pid, "terminated": killed, "manual": manual }),
        );
    }
    killed
}

/// 只跟随指定调试端口的实例；运行时记录归属，退出后有界清理。
pub struct ChildMonitor {
    stop: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl ChildMonitor {
    pub fn start(debug_port: u16, state_dir: PathBuf, executable: PathBuf) -> Option<Self> {
        if !cfg!(any(windows, target_os = "macos")) {
            return None;
        }
        let (stop, mut receiver) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            let mut receipt: Option<Receipt> = None;
            let mut attempts = 0;
            let mut exit_attempts = 0;
            let mut stop_attempts = 0;
            loop {
                let snapshot = match tokio::task::spawn_blocking(snapshot).await {
                    Ok(Ok(value)) => value,
                    _ => {
                        let _ = crate::diagnostic_log::append_diagnostic_log(
                            "process_cleanup.snapshot_unavailable",
                            serde_json::json!({ "debug_port": debug_port }),
                        );
                        break;
                    }
                };
                if receipt.is_none() {
                    attempts += 1;
                    receipt = find_root(&snapshot, debug_port, &executable).map(|root| Receipt {
                        root,
                        children: Vec::new(),
                    });
                    if attempts >= 60 || *receiver.borrow() {
                        break;
                    }
                }
                if let Some(current) = &mut receipt {
                    let previous = current.clone();
                    let alive = root_alive(current, &snapshot);
                    if alive {
                        update_receipt(current, &snapshot);
                    }
                    if previous != *current || !receipt_path(&state_dir, &current.root).exists() {
                        save(&state_dir, current);
                    }
                    if !alive {
                        let owned = current.clone();
                        let _ =
                            tokio::task::spawn_blocking(move || cleanup(&owned, &snapshot, false))
                                .await;
                        exit_attempts += 1;
                        if exit_attempts >= 3 {
                            if let Ok(Ok(remaining)) =
                                tokio::task::spawn_blocking(crate::owned_processes::snapshot).await
                            {
                                if !current.children.iter().any(|old| {
                                    remaining.iter().any(|p| same_process(old, &p.identity))
                                }) {
                                    let _ = std::fs::remove_file(receipt_path(
                                        &state_dir,
                                        &current.root,
                                    ));
                                }
                            }
                            break;
                        }
                    } else if *receiver.borrow() {
                        stop_attempts += 1;
                        if stop_attempts >= 5 {
                            break;
                        }
                    }
                }
                let interval = if *receiver.borrow() || exit_attempts > 0 {
                    Duration::from_millis(250)
                } else if receipt.is_some() {
                    Duration::from_secs(5)
                } else {
                    Duration::from_secs(1)
                };
                tokio::select! {
                    _ = tokio::time::sleep(interval) => {},
                    result = receiver.changed() => { if result.is_err() { break; } }
                }
            }
        });
        Some(Self { stop, task })
    }

    pub async fn finish(self) {
        self.stop.send_replace(true);
        let _ = self.task.await;
    }
}

fn find_root(snapshot: &[Process], debug_port: u16, executable: &Path) -> Option<ProcessIdentity> {
    snapshot
        .iter()
        .find(|p| {
            !p.identity.birth.is_empty()
                && p.identity.kind.is_empty()
                && p.identity.executable == executable
                && has_debug_port(&p.arguments, debug_port)
                && !p.arguments.iter().any(|arg| arg.starts_with("--type="))
        })
        .map(|p| p.identity.clone())
}

fn has_debug_port(arguments: &[String], port: u16) -> bool {
    arguments
        .iter()
        .any(|arg| arg == &format!("--remote-debugging-port={port}"))
        || arguments
            .windows(2)
            .any(|args| args[0] == "--remote-debugging-port" && args[1] == port.to_string())
}

fn official_app(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    name == "Codex.exe"
        || name == "Codex"
        || crate::app_paths::is_supported_app_executable_name(name)
            && path
                .to_string_lossy()
                .to_ascii_lowercase()
                .contains("openai.codex_")
}

fn receipts(state_dirs: &[PathBuf]) -> anyhow::Result<Vec<(Receipt, PathBuf)>> {
    let mut receipts = Vec::new();
    for state_dir in state_dirs {
        let directory = state_dir.join("owned-app-children");
        if !directory.exists() {
            continue;
        }
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            if entry.path().extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            if let Ok(bytes) = std::fs::read(entry.path())
                && let Ok(receipt) = serde_json::from_slice::<Receipt>(&bytes)
            {
                receipts.push((receipt, state_dir.clone()));
            }
        }
    }
    Ok(receipts)
}

pub fn report(state_dirs: &[PathBuf]) -> anyhow::Result<ProcessReport> {
    let snapshot = snapshot()?;
    let mut owned = receipts(state_dirs)?;
    // 尚未接管的官方实例也只显示它当前可证明的后代，退出归属由监测记录承担。
    for root in snapshot.iter().filter(|p| {
        official_app(&p.identity.executable)
            && !p.arguments.iter().any(|arg| arg.starts_with("--type="))
    }) {
        let (mut receipt, directory) = owned
            .iter()
            .find(|(receipt, _)| same_process(&receipt.root, &root.identity))
            .cloned()
            .unwrap_or_else(|| {
                (
                    Receipt {
                        root: root.identity.clone(),
                        children: Vec::new(),
                    },
                    crate::paths::default_app_state_dir(),
                )
            });
        update_receipt(&mut receipt, &snapshot);
        if !receipt.children.is_empty() {
            save(&directory, &receipt);
        }
        owned.push((receipt, directory));
    }
    let mut seen = HashSet::new();
    let mut processes = Vec::new();
    for (receipt, state_dir) in owned {
        if !root_alive(&receipt, &snapshot)
            && !receipt
                .children
                .iter()
                .any(|old| snapshot.iter().any(|p| same_process(old, &p.identity)))
        {
            let _ = std::fs::remove_file(receipt_path(&state_dir, &receipt.root));
        }
        for expected in &receipt.children {
            if let Some(process) = snapshot
                .iter()
                .find(|p| same_process(expected, &p.identity))
                && !expected.kind.is_empty()
                && seen.insert(expected.pid)
            {
                let disconnected = disconnected(process, &snapshot);
                processes.push(ProcessRow {
                    pid: expected.pid,
                    kind: expected.kind.clone(),
                    memory_bytes: process.memory,
                    disconnected,
                    zombie: process.zombie,
                    can_cleanup: expected.kind == "app-server" && disconnected && !process.zombie,
                });
            }
        }
    }
    processes.sort_by_key(|p| p.pid);
    Ok(ProcessReport {
        supported: cfg!(any(windows, target_os = "macos")),
        processes,
    })
}

pub fn cleanup_disconnected(state_dirs: &[PathBuf]) -> anyhow::Result<Vec<u32>> {
    let snapshot = snapshot()?;
    let mut killed = Vec::new();
    for (receipt, _) in receipts(state_dirs)? {
        killed.extend(cleanup(&receipt, &snapshot, true));
    }
    Ok(killed)
}

#[cfg(windows)]
fn snapshot() -> anyhow::Result<Vec<Process>> {
    use crate::windows_integration as native;
    let processes = native::enumerate_processes();
    anyhow::ensure!(!processes.is_empty(), "进程快照暂时不可用");
    let mut descendant_ids = HashSet::new();
    for root in processes
        .iter()
        .filter(|p| p.executable_path.as_deref().is_some_and(official_app))
    {
        descendant_ids.extend(native::descendant_process_ids(&processes, root.process_id));
    }
    Ok(processes
        .iter()
        .map(|process| {
            let executable = process.executable_path.clone().unwrap_or_default();
            let name = process.exe_file.to_ascii_lowercase();
            let relevant = crate::app_paths::is_supported_app_executable_name(&name)
                || matches!(name.as_str(), "codex.exe" | "node.exe");
            let birth = (relevant || descendant_ids.contains(&process.process_id))
                .then(|| native::process_birth_id(process.process_id))
                .flatten();
            let arguments = relevant
                .then(|| {
                    native::process_command_line(process.process_id)
                        .and_then(|line| native::command_line_arguments(&line))
                })
                .flatten()
                .unwrap_or_default();
            let kind = child_kind(&executable, &arguments)
                .unwrap_or_default()
                .to_string();
            let memory = (!kind.is_empty())
                .then(|| native::process_memory_bytes(process.process_id))
                .flatten();
            Process {
                identity: ProcessIdentity {
                    pid: process.process_id,
                    parent: process.parent_process_id,
                    birth: birth.map(|v| v.to_string()).unwrap_or_default(),
                    started: birth.unwrap_or(0),
                    executable,
                    kind,
                },
                arguments,
                memory,
                zombie: false,
            }
        })
        .collect())
}

#[cfg(windows)]
fn terminate(expected: &ProcessIdentity) -> bool {
    expected.birth.parse().ok().is_some_and(|birth| {
        crate::windows_integration::terminate_owned_child(
            expected.pid,
            birth,
            &expected.executable,
            &expected.kind,
        )
    })
}

#[cfg(target_os = "macos")]
fn snapshot() -> anyhow::Result<Vec<Process>> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,rss=,stat=,lstart=,args="])
        .env("LC_ALL", "C")
        .output()?;
    if !output.status.success() {
        anyhow::bail!("无法读取进程快照");
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(parse_macos_process)
        .collect())
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_process(line: &str) -> Option<Process> {
    let mut fields = line.split_whitespace();
    let pid = fields.next()?.parse().ok()?;
    let parent = fields.next()?.parse().ok()?;
    let memory = fields.next()?.parse::<u64>().ok()?.checked_mul(1024);
    let stat = fields.next()?;
    let start = (0..5).map(|_| fields.next()).collect::<Option<Vec<_>>>()?;
    let month = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ]
    .iter()
    .position(|m| *m == start[1])?
        + 1;
    let started = format!(
        "{}{:02}{:02}{}",
        start[4],
        month,
        start[2].parse::<u32>().ok()?,
        start[3].replace(':', "")
    )
    .parse()
    .ok()?;
    let birth = start.join(" ");
    let command = fields.collect::<Vec<_>>().join(" ");
    // 主程序路径允许空格；只识别已核对的 bundle 主程序边界。
    let boundary = [
        "/Contents/MacOS/Codex",
        "/Contents/MacOS/ChatGPT",
        "/Contents/Resources/codex",
        "/Contents/Resources/node",
        "/Contents/Resources/app.asar.unpacked/node",
    ]
    .iter()
    .find_map(|marker| command.find(marker).map(|index| index + marker.len()));
    let executable = if let Some(end) = boundary {
        PathBuf::from(&command[..end])
    } else {
        PathBuf::from(command.split_whitespace().next()?)
    };
    let arguments: Vec<String> = if let Some(end) = boundary {
        std::iter::once(executable.to_string_lossy().to_string())
            .chain(command[end..].split_whitespace().map(str::to_string))
            .collect()
    } else {
        command.split_whitespace().map(str::to_string).collect()
    };
    let kind = child_kind(&executable, &arguments)
        .unwrap_or_default()
        .to_string();
    Some(Process {
        identity: ProcessIdentity {
            pid,
            parent,
            birth,
            started,
            executable,
            kind,
        },
        arguments,
        memory,
        zombie: stat.starts_with('Z'),
    })
}

#[cfg(target_os = "macos")]
fn terminate(expected: &ProcessIdentity) -> bool {
    // ps/kill 没有 Windows 句柄语义；发送信号前再次读取代际与用途，证据不足时跳过。
    let Ok(snapshot) = snapshot() else {
        return false;
    };
    if !snapshot.iter().any(|p| {
        same_process(expected, &p.identity) && p.identity.kind == expected.kind && !p.zombie
    }) {
        return false;
    }
    std::process::Command::new("kill")
        .args(["-TERM", &expected.pid.to_string()])
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn snapshot() -> anyhow::Result<Vec<Process>> {
    Ok(Vec::new())
}
#[cfg(not(any(windows, target_os = "macos")))]
fn terminate(_: &ProcessIdentity) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    fn process(pid: u32, parent: u32, started: u64, kind: &str) -> Process {
        Process {
            identity: ProcessIdentity {
                pid,
                parent,
                started,
                birth: started.to_string(),
                executable: PathBuf::from(if kind == "app-server" {
                    "codex.exe"
                } else {
                    "ChatGPT.exe"
                }),
                kind: kind.into(),
            },
            arguments: Vec::new(),
            memory: Some(1),
            zombie: false,
        }
    }
    #[test]
    fn tracks_only_descendants_and_rejects_reused_parent_pids() {
        let root = process(1, 0, 10, "");
        let snapshot = vec![
            root.clone(),
            process(2, 1, 11, ""),
            process(3, 2, 12, "app-server"),
            process(4, 99, 13, "app-server"),
            process(5, 1, 1, "app-server"),
        ];
        let mut receipt = Receipt {
            root: root.identity.clone(),
            children: Vec::new(),
        };
        update_receipt(&mut receipt, &snapshot);
        assert_eq!(
            receipt.children.iter().map(|c| c.pid).collect::<Vec<_>>(),
            [2, 3]
        );
        let mut changed = snapshot;
        changed[0].identity.birth = "new".into();
        assert!(descendants(&changed, &receipt.root).is_empty());
        assert!(!same_process(
            &receipt.children[1],
            &process(3, 2, 99, "app-server").identity
        ));
    }
    #[test]
    fn cleanup_requires_exit_and_preserves_other_instances_and_reused_children() {
        let root = process(101, 0, 10, "");
        let server = process(102, 101, 11, "app-server");
        let mut node = process(103, 102, 12, "node");
        node.identity.executable = PathBuf::from("node.exe");
        let other = process(104, 999, 13, "app-server");
        let mut receipt = Receipt {
            root: root.identity.clone(),
            children: Vec::new(),
        };
        update_receipt(
            &mut receipt,
            &[root.clone(), server.clone(), node.clone(), other.clone()],
        );
        assert!(
            cleanup_candidates(
                &receipt,
                &[root.clone(), server.clone(), node.clone(), other.clone()],
                false
            )
            .is_empty()
        );
        let candidates = cleanup_candidates(
            &receipt,
            &[server.clone(), node.clone(), other.clone()],
            false,
        );
        assert_eq!(
            candidates.iter().map(|p| p.pid).collect::<HashSet<_>>(),
            HashSet::from([102, 103])
        );
        let candidates = cleanup_candidates(
            &receipt,
            &[server.clone(), node.clone(), other.clone()],
            true,
        );
        assert_eq!(candidates.iter().map(|p| p.pid).collect::<Vec<_>>(), [102]);
        let mut reused = server.clone();
        reused.identity.birth = "9999".into();
        assert!(
            cleanup_candidates(&receipt, &[reused, node.clone(), other.clone()], false).is_empty()
        );
        let mut zombie = server;
        zombie.zombie = true;
        assert!(cleanup_candidates(&receipt, &[zombie], false).is_empty());
    }

    #[test]
    fn refresh_retains_confirmed_children_with_disconnected_parents() {
        let root = process(101, 0, 10, "");
        let middle = process(102, 101, 11, "");
        let server = process(103, 102, 12, "app-server");
        let mut receipt = Receipt {
            root: root.identity.clone(),
            children: Vec::new(),
        };
        update_receipt(&mut receipt, &[root.clone(), middle, server.clone()]);
        update_receipt(&mut receipt, &[root, server.clone()]);
        assert_eq!(receipt.children, [server.identity]);
    }

    #[test]
    fn reads_receipts_only_from_selected_instance_directories() {
        let temp = tempfile::tempdir().unwrap();
        let main = temp.path().join("main");
        let multi = temp.path().join("multi");
        let root = process(101, 0, 10, "").identity;
        let receipt = Receipt {
            root,
            children: vec![process(102, 101, 11, "app-server").identity],
        };
        save(&main, &receipt);
        save(&multi, &receipt);
        let selected = receipts(&[main.clone(), multi.clone()]).unwrap();
        assert_eq!(selected.len(), 2);
        assert_eq!(selected[0].1, main);
        assert_eq!(selected[1].1, multi);
        assert!(
            receipts(&[temp.path().join("unrelated")])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn detects_only_exact_app_server_subcommands() {
        assert_eq!(
            child_kind(
                Path::new("codex.exe"),
                &["codex.exe".into(), "app-server".into()]
            ),
            Some("app-server")
        );
        assert_eq!(
            child_kind(
                Path::new("codex.exe"),
                &["codex.exe".into(), "exec".into(), "app-server".into()]
            ),
            None
        );
        assert!(!has_debug_port(
            &["--remote-debugging-port=9229".into()],
            922
        ));
    }
    #[test]
    fn macos_snapshot_keeps_zombies_and_spaced_bundle_paths() {
        let p=parse_macos_process("123 1 1024 Z Mon Oct 12 12:34:56 2026 /Applications/Codex App.app/Contents/MacOS/Codex --remote-debugging-port=9229").unwrap();
        assert!(p.zombie);
        assert_eq!(p.memory, Some(1048576));
        assert!(has_debug_port(&p.arguments, 9229));
        assert_eq!(
            p.identity.executable,
            PathBuf::from("/Applications/Codex App.app/Contents/MacOS/Codex")
        );
    }
}

#[cfg(all(test, windows))]
mod windows_live_tests {
    use super::*;
    use std::process::{Child, Command, Stdio};

    struct Children(Vec<Child>, Vec<(u32, u64)>);
    impl Drop for Children {
        fn drop(&mut self) {
            for child in &mut self.0 {
                let _ = child.kill();
                let _ = child.wait();
            }
            for (pid, birth) in &self.1 {
                if crate::windows_integration::process_birth_id(*pid) == Some(*birth) {
                    let _ = crate::windows_integration::terminate_process(*pid);
                }
            }
        }
    }

    #[tokio::test]
    async fn windows_exit_cleanup_leaves_vscode_children_running() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("OpenAI.Codex_test").join("app");
        std::fs::create_dir_all(&app).unwrap();
        let output = Command::new("where.exe").arg("node.exe").output().unwrap();
        let node = PathBuf::from(
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .next()
                .unwrap(),
        );
        for name in ["ChatGPT.exe", "codex.exe", "node.exe", "Code.exe"] {
            if std::fs::hard_link(&node, app.join(name)).is_err() {
                std::fs::copy(&node, app.join(name)).unwrap();
            }
        }
        std::fs::write(app.join("app-server"), "setInterval(()=>{},1000)").unwrap();
        std::fs::write(app.join("worker.cjs"), "setInterval(()=>{},1000)").unwrap();
        std::fs::write(app.join("parent.cjs"), r#"const {spawn}=require('child_process'),{writeFileSync}=require('fs'),{join}=require('path'); const p=spawn(join(__dirname,'codex.exe'),['app-server'],{cwd:__dirname,stdio:'ignore'}); const n=spawn(join(__dirname,'node.exe'),['worker.cjs'],{cwd:__dirname,stdio:'ignore'});writeFileSync(process.argv[2],JSON.stringify([p.pid,n.pid]));setInterval(()=>{},1000);"#).unwrap();
        let port = crate::ports::find_available_loopback_port();
        let spawn = |name: &str, file: &str| {
            Command::new(app.join(name))
                .arg(app.join("parent.cjs"))
                .arg(temp.path().join(file))
                .arg(format!("--remote-debugging-port={port}"))
                .creation_flags(crate::windows_integration::CREATE_NO_WINDOW)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap()
        };
        use std::os::windows::process::CommandExt;
        let mut children = Children(
            vec![
                spawn("ChatGPT.exe", "app.json"),
                spawn("Code.exe", "code.json"),
            ],
            Vec::new(),
        );
        for _ in 0..50 {
            if temp.path().join("app.json").exists() && temp.path().join("code.json").exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let own: Vec<u32> =
            serde_json::from_slice(&std::fs::read(temp.path().join("app.json")).unwrap()).unwrap();
        let other: Vec<u32> =
            serde_json::from_slice(&std::fs::read(temp.path().join("code.json")).unwrap()).unwrap();
        children
            .1
            .extend(own.iter().chain(other.iter()).filter_map(|pid| {
                crate::windows_integration::process_birth_id(*pid).map(|birth| (*pid, birth))
            }));
        let state = temp.path().join("state");
        let monitor = ChildMonitor::start(port, state.clone(), app.join("ChatGPT.exe")).unwrap();
        for _ in 0..50 {
            if std::fs::read_dir(state.join("owned-app-children"))
                .is_ok_and(|mut entries| entries.next().is_some())
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            own.iter()
                .chain(other.iter())
                .all(|pid| crate::windows_integration::process_birth_id(*pid).is_some())
        );
        children.0[0].kill().unwrap();
        children.0[0].wait().unwrap();
        // 自然退出路径先由监督任务处理，再执行生命周期收尾。
        for _ in 0..80 {
            if snapshot()
                .unwrap()
                .iter()
                .all(|p| !own.contains(&p.identity.pid))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        monitor.finish().await;
        let remaining = snapshot().unwrap();
        assert!(
            own.iter()
                .all(|pid| !remaining.iter().any(|p| p.identity.pid == *pid)),
            "official fixture children survived: {:?}; receipts: {:?}",
            remaining
                .iter()
                .filter(|p| own.contains(&p.identity.pid))
                .map(|p| (&p.identity, &p.arguments))
                .collect::<Vec<_>>(),
            std::fs::read_dir(state.join("owned-app-children"))
                .unwrap()
                .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
                .collect::<Vec<_>>()
        );
        assert!(
            other
                .iter()
                .all(|pid| remaining.iter().any(|p| p.identity.pid == *pid)),
            "VS Code fixture was affected"
        );
        // Drop 时仅按原始代际结束测试夹具，避免 PID 复用后的进程受影响。
        children.1.retain(|(pid, _)| other.contains(pid));
    }
}
