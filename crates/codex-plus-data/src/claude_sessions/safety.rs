use anyhow::{Context, Result, ensure};
use std::fs;
use std::path::{Component, Path, PathBuf};

pub(super) fn check_path(root: &Path, path: &Path) -> Result<()> {
    ensure!(
        root.is_absolute() && path.starts_with(root),
        "文件超出允许的目录"
    );
    ensure!(
        !path
            .components()
            .any(|part| matches!(part, Component::ParentDir)),
        "路径包含上级目录"
    );
    // 同时检查祖先目录，Windows junction 也属于重解析点，不能只检查 symlink。
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                ensure!(
                    metadata.is_file() || metadata.is_dir() || metadata.file_type().is_symlink(),
                    "路径包含不支持的文件类型：{}",
                    ancestor.display()
                );
                let linked = metadata.file_type().is_symlink();
                #[cfg(windows)]
                let linked = {
                    use std::os::windows::fs::MetadataExt;
                    linked || metadata.file_attributes() & 0x400 != 0
                };
                ensure!(
                    !linked,
                    "路径包含符号链接或重解析点：{}",
                    ancestor.display()
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).context("无法检查文件路径"),
        }
    }
    Ok(())
}

pub(super) fn files_under(root: &Path, directory: &Path) -> Result<Vec<PathBuf>> {
    fn walk(root: &Path, directory: &Path, depth: usize, paths: &mut Vec<PathBuf>) -> Result<()> {
        ensure!(depth < 32, "会话目录层级过深");
        check_path(root, directory)?;
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            check_path(root, &path)?;
            if path.is_dir() {
                walk(root, &path, depth + 1, paths)?;
            } else if path.is_file() {
                paths.push(path);
            } else {
                anyhow::bail!("会话目录包含不支持的文件类型");
            }
        }
        Ok(())
    }
    let mut paths = Vec::new();
    walk(root, directory, 0, &mut paths)?;
    paths.sort();
    Ok(paths)
}

pub fn ensure_claude_stopped() -> Result<()> {
    #[cfg(windows)]
    {
        for process in codex_plus_core::windows_try_enumerate_processes()? {
            let name = process.exe_file.to_lowercase();
            ensure!(
                !claude_executable(&name),
                "Claude 正在运行，请完全退出后重试"
            );
            if matches!(name.as_str(), "node.exe" | "bun.exe" | "deno.exe") {
                let command = codex_plus_core::windows_process_command_line(process.process_id)
                    .context("无法检查脚本进程，请退出相关 Node/Bun/Deno 进程后重试")?;
                ensure!(
                    !claude_script(&command),
                    "Claude Code 正在运行，请完全退出后重试"
                );
            }
        }
    }
    #[cfg(unix)]
    {
        let output = std::process::Command::new("ps")
            .args(["-axo", "comm=,args="])
            .output()
            .context("无法检查 Claude 运行状态")?;
        ensure!(output.status.success(), "无法检查 Claude 运行状态");
        let text = String::from_utf8(output.stdout)?;
        for line in text.lines() {
            let executable = line.split_whitespace().next().unwrap_or("");
            let name = executable.rsplit('/').next().unwrap_or("").to_lowercase();
            let script_runtime = matches!(name.as_str(), "node" | "bun" | "deno");
            ensure!(
                !claude_executable(&name) && !(script_runtime && claude_script(line)),
                "Claude 正在运行，请完全退出后重试"
            );
        }
    }
    #[cfg(not(any(windows, unix)))]
    anyhow::bail!("当前平台无法检查 Claude 运行状态");
    Ok(())
}

pub(super) fn claude_executable(name: &str) -> bool {
    let name = name.trim_end_matches(".exe");
    matches!(
        name,
        "claude" | "claude-desktop" | "claude-3p" | "claude cn"
    ) || name.starts_with("claude helper")
        || name.starts_with("claude-3p helper")
        || name.starts_with("claude cn helper")
}

pub(super) fn claude_script(command: &str) -> bool {
    let normalized = command.to_lowercase().replace('\\', "/");
    normalized.contains("/@anthropic-ai/claude-code/")
        || normalized.contains("/claude-code/cli.js")
        || normalized.contains("/claude-code/cli.mjs")
}
