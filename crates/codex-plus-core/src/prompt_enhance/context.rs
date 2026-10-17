//! 本机项目参考材料：按设置白名单读取，字符预算与磁盘读取量分别设限。
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use super::PromptEnhanceRequest;
use crate::settings::PromptEnhanceContextSettings;

const TOTAL_CHARS: usize = 14_000;
const MAX_FILE_BYTES: u64 = 32_768;
const MAX_ENTRIES: usize = 200;
const SCAN_ENTRIES: usize = 400;
const IGNORE: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".cache",
    "vendor",
    "bin",
    "obj",
];
const MANIFESTS: &[&str] = &[
    "Cargo.toml",
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "Pipfile",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "global.json",
    "Directory.Build.props",
];

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectContext {
    pub enabled: bool,
    pub sections: Vec<Section>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Section {
    pub kind: String,
    pub files: Vec<String>,
    pub truncated: bool,
    pub skipped: Vec<String>,
    #[serde(skip_serializing)]
    text: String,
}

impl ProjectContext {
    pub fn text(&self) -> String {
        self.sections
            .iter()
            .filter(|section| !section.text.is_empty())
            .map(|section| format!("[{}]\n{}", section.kind, section.text))
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

fn truncate(text: &str, limit: usize) -> (String, bool) {
    let mut chars = text.chars();
    let kept: String = chars.by_ref().take(limit).collect();
    (kept, chars.next().is_some())
}

fn section(kind: &str) -> Section {
    Section {
        kind: kind.into(),
        files: Vec::new(),
        truncated: false,
        skipped: Vec::new(),
        text: String::new(),
    }
}

// 先确认普通文件及规范路径，再读取有限字节；FIFO、越界链接不进入读取路径。
fn read_file(root: &Path, relative: &str) -> Result<(String, bool), &'static str> {
    let path = root.join(relative);
    let path = fs::canonicalize(path).map_err(|_| "不可读取")?;
    if !path.starts_with(root) {
        return Err("链接超出项目目录");
    }
    if !fs::metadata(&path).map_err(|_| "不可读取")?.is_file() {
        return Err("不是普通文件");
    }
    let file = File::open(&path).map_err(|_| "不可读取")?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取失败")?;
    let cut = bytes.len() > MAX_FILE_BYTES as usize;
    bytes.truncate(MAX_FILE_BYTES as usize);
    // 截断点可以落在多字节字符中；只舍弃尾部残片，正文中的二进制或非 UTF-8 文件跳过。
    let text = match std::str::from_utf8(&bytes) {
        Ok(text) => text.to_string(),
        Err(error) if cut && error.error_len().is_none() => {
            std::str::from_utf8(&bytes[..error.valid_up_to()])
                .map_err(|_| "不是 UTF-8 文本")?
                .to_string()
        }
        Err(_) => return Err("不是 UTF-8 文本"),
    };
    if text.contains('\0') {
        return Err("不是文本文件");
    }
    Ok((text, cut))
}

fn add_file(part: &mut Section, root: &Path, name: &str, budget: usize) {
    if part.text.chars().count() >= budget {
        part.truncated = true;
        return;
    }
    match read_file(root, name) {
        Ok((text, cut)) => {
            let value = format!("{}\n{}\n", name, text);
            let remaining = budget.saturating_sub(part.text.chars().count());
            let (text, truncated) = truncate(&value, remaining);
            part.truncated |= cut || truncated;
            if !text.is_empty() {
                part.files.push(name.to_string());
                part.text.push_str(&text);
            }
        }
        Err(reason) => part.skipped.push(format!("{name}：{reason}")),
    }
}

fn directory(root: &Path) -> Section {
    let mut part = section("directory");
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut count = 0;
    let mut scanned = 0;
    while let Some((dir, depth)) = pending.pop() {
        if !fs::canonicalize(&dir).is_ok_and(|path| path.starts_with(root)) {
            part.skipped.push("目录链接超出项目目录".into());
            continue;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            part.skipped.push("部分目录不可读取".into());
            continue;
        };
        let mut visible = Vec::new();
        for entry in entries {
            if scanned >= SCAN_ENTRIES {
                part.truncated = true;
                break;
            }
            scanned += 1;
            let Ok(entry) = entry else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().to_string();
            if IGNORE.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            // 不遍历链接，防止环与目录边界变化。
            if kind.is_symlink() {
                continue;
            }
            visible.push((name, entry.path(), kind.is_dir()));
        }
        visible.sort_by(|a, b| a.0.cmp(&b.0));
        let mut children = Vec::new();
        for (name, path, is_dir) in visible {
            if count >= MAX_ENTRIES {
                part.truncated = true;
                break;
            }
            count += 1;
            let relative = path.strip_prefix(root).unwrap_or(Path::new(&name));
            part.text.push_str(&format!(
                "{}{}\n",
                relative.to_string_lossy().replace('\\', "/"),
                if is_dir { "/" } else { "" }
            ));
            if is_dir && depth == 0 {
                children.push((path, depth + 1));
            }
        }
        pending.extend(children.into_iter().rev());
        if count >= MAX_ENTRIES || scanned >= SCAN_ENTRIES {
            part.truncated |= !pending.is_empty();
            break;
        }
    }
    let (text, cut) = truncate(&part.text, 2000);
    part.text = text;
    part.truncated |= cut;
    part
}

fn root_path(request: &PromptEnhanceRequest) -> Result<PathBuf, &'static str> {
    if request.host_id != "local" {
        return Err("未确认本机会话或当前会话属于远程主机");
    }
    let path = Path::new(&request.working_directory);
    // UNC 与设备路径可能触发网络或设备访问，不作为本机项目上下文。
    if !path.is_absolute()
        || request.working_directory.starts_with("\\\\")
        || request.working_directory.starts_with("//")
    {
        return Err("未取得当前输入框的本机工作目录");
    }
    let root = fs::canonicalize(path).map_err(|_| "项目目录不可读取")?;
    if !root.is_dir() {
        return Err("项目目录不可读取");
    }
    Ok(root)
}

fn collect_files(
    request: &PromptEnhanceRequest,
    config: &PromptEnhanceContextSettings,
    branch: &str,
) -> ProjectContext {
    let mut result = ProjectContext {
        enabled: config.enabled,
        ..Default::default()
    };
    if !config.enabled {
        return result;
    }
    let root = match root_path(request) {
        Ok(root) => root,
        Err(reason) => {
            let mut part = section("project");
            part.skipped.push(reason.into());
            result.sections.push(part);
            return result;
        }
    };
    if config.project {
        let mut part = section("project");
        let name = root.file_name().unwrap_or_default().to_string_lossy();
        let (text, cut) = truncate(&format!("项目：{name}\n分支：{branch}"), 512);
        part.text = text;
        part.truncated = cut;
        result.sections.push(part);
    }
    if config.instructions {
        let mut part = section("instructions");
        let names: Vec<_> = ["AGENTS.md", "CLAUDE.md"]
            .into_iter()
            .filter(|name| root.join(name).exists())
            .collect();
        if names.is_empty() {
            if let Some(name) = ["README.md", "README", "README.rst", "README.txt"]
                .into_iter()
                .find(|name| root.join(name).exists())
            {
                add_file(&mut part, &root, name, 6000);
            } else {
                part.skipped.push("未找到项目说明".into());
            }
        } else {
            for name in names {
                add_file(&mut part, &root, name, 6000);
            }
        }
        result.sections.push(part);
    }
    if config.manifests {
        let mut part = section("manifests");
        for name in MANIFESTS
            .iter()
            .copied()
            .filter(|name| root.join(name).exists())
        {
            add_file(&mut part, &root, name, 6000);
        }
        // .NET 项目文件名不固定，仍只读取顶层的已知清单后缀。
        if let Ok(entries) = fs::read_dir(&root) {
            let mut names: Vec<_> = entries
                .take(SCAN_ENTRIES)
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .filter(|name| {
                    [".csproj", ".fsproj", ".vbproj"]
                        .iter()
                        .any(|ext| name.ends_with(ext))
                })
                .collect();
            names.sort();
            for name in names.into_iter().take(8) {
                add_file(&mut part, &root, &name, 6000);
            }
        }
        if part.files.is_empty() && part.skipped.is_empty() {
            part.skipped.push("未找到主要清单".into());
        }
        result.sections.push(part);
    }
    if config.directory {
        result.sections.push(directory(&root));
    }
    let mut remaining = TOTAL_CHARS;
    for part in &mut result.sections {
        // 标题与分隔符也计入总预算，确保发给模型的整份参考材料不超限。
        let overhead = part.kind.chars().count() + 5;
        let (text, cut) = truncate(&part.text, remaining.saturating_sub(overhead));
        if !text.is_empty() {
            remaining = remaining.saturating_sub(overhead);
        }
        remaining = remaining.saturating_sub(text.chars().count());
        part.text = text;
        part.truncated |= cut;
    }
    result
}

pub(super) async fn collect(
    request: &PromptEnhanceRequest,
    config: &PromptEnhanceContextSettings,
) -> ProjectContext {
    if !config.enabled {
        return ProjectContext::default();
    }
    let mut branch = "不可用".to_string();
    if config.project
        && let Ok(root) = root_path(request)
    {
        let mut command = tokio::process::Command::new("git");
        command
            .args([
                "--no-optional-locks",
                "symbolic-ref",
                "--short",
                "-q",
                "HEAD",
            ])
            .current_dir(root)
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        if let Ok(Ok(output)) = tokio::time::timeout(Duration::from_secs(2), command.output()).await
            && output.status.success()
        {
            branch = String::from_utf8_lossy(&output.stdout)
                .trim()
                .chars()
                .take(480)
                .collect();
        }
    }
    let request = request.clone();
    let config = config.clone();
    tokio::task::spawn_blocking(move || collect_files(&request, &config, &branch))
        .await
        .unwrap_or_else(|_| {
            let mut part = section("project");
            part.skipped.push("读取项目上下文失败".into());
            ProjectContext {
                enabled: true,
                sections: vec![part],
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> PromptEnhanceContextSettings {
        PromptEnhanceContextSettings {
            enabled: true,
            project: true,
            instructions: true,
            manifests: true,
            directory: true,
        }
    }
    fn request(root: &Path) -> PromptEnhanceRequest {
        PromptEnhanceRequest {
            working_directory: root.to_string_lossy().to_string(),
            host_id: "local".into(),
            ..Default::default()
        }
    }
    #[test]
    fn disabled_remote_and_missing_paths_do_not_read_files() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("AGENTS.md"), "private").unwrap();
        let mut req = request(root.path());
        assert!(
            collect_files(&req, &Default::default(), "")
                .text()
                .is_empty()
        );
        req.host_id = "ssh:remote".into();
        let context = collect_files(&req, &config(), "");
        assert!(context.text().is_empty());
        assert!(!context.sections[0].skipped.is_empty());
        req.host_id = "local".into();
        req.working_directory = "relative/path".into();
        assert!(collect_files(&req, &config(), "").text().is_empty());
    }
    #[test]
    fn budgets_unicode_fallback_and_directory_limits() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("README.md"), "中😀".repeat(10000)).unwrap();
        fs::write(root.path().join("Cargo.toml"), "a".repeat(32000)).unwrap();
        fs::create_dir(root.path().join("target")).unwrap();
        fs::write(root.path().join("target/secret"), "ignored").unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/main.rs"), "fn main(){}").unwrap();
        let result = collect_files(&request(root.path()), &config(), "personal");
        assert!(
            result
                .sections
                .iter()
                .map(|part| part.text.chars().count())
                .sum::<usize>()
                <= TOTAL_CHARS
        );
        assert_eq!(result.sections[1].files, ["README.md"]);
        assert!(result.sections[1].truncated);
        assert!(result.text().chars().count() <= TOTAL_CHARS);
        assert!(result.text().contains("personal"));
        assert!(result.text().contains("src/main.rs"));
        assert!(!result.text().contains("target/"));
        fs::write(root.path().join("AGENTS.md"), "project instructions").unwrap();
        fs::write(root.path().join("CLAUDE.md"), "claude instructions").unwrap();
        let result = collect_files(&request(root.path()), &config(), "");
        assert_eq!(result.sections[1].files, ["AGENTS.md", "CLAUDE.md"]);
        assert!(!result.sections[1].text.contains("README.md"));
        for i in 0..250 {
            fs::write(root.path().join(format!("file-{i}")), "").unwrap();
        }
        let result = collect_files(&request(root.path()), &config(), "");
        let tree = result.sections.last().unwrap();
        assert!(tree.truncated);
        assert!(tree.text.lines().count() <= MAX_ENTRIES);
    }
    #[test]
    fn canonical_file_paths_stay_inside_root() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("project");
        fs::create_dir(&root).unwrap();
        fs::write(parent.path().join("secret"), "private").unwrap();
        let root = fs::canonicalize(root).unwrap();
        assert!(read_file(&root, "../secret").is_err());
    }

    #[test]
    fn missing_and_binary_files_are_reported() {
        let root = tempfile::tempdir().unwrap();
        let result = collect_files(&request(root.path()), &config(), "");
        assert!(!result.sections[1].skipped.is_empty());
        fs::write(root.path().join("AGENTS.md"), [0, 255]).unwrap();
        let result = collect_files(&request(root.path()), &config(), "");
        assert!(result.sections[1].text.is_empty());
        assert!(!result.sections[1].skipped.is_empty());
    }
    #[cfg(unix)]
    #[test]
    fn links_outside_root_are_not_read() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret"), "private").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), root.path().join("AGENTS.md"))
            .unwrap();
        let result = collect_files(&request(root.path()), &config(), "");
        assert!(result.sections[1].text.is_empty());
        assert!(!result.sections[1].skipped.is_empty());
    }
}
