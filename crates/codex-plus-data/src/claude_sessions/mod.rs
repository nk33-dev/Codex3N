mod deletion;
mod reader;
mod safety;

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub use deletion::{BackupPage, BackupSummary, DeleteOutcome, DeletePreview, DeleteReport};
pub use reader::{MessageBlock, MessagePage, SessionMessage};
pub use safety::ensure_claude_stopped;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    pub key: String,
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub created_at_ms: Option<i64>,
    pub updated_at_ms: i64,
    pub transcript_path: PathBuf,
    pub file_size: u64,
    pub desktop: bool,
    pub protected_reason: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub sessions: Vec<ClaudeSession>,
    pub total_count: usize,
    pub offset: usize,
    pub limit: usize,
    pub has_more: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, PartialEq, Eq)]
struct FileStamp {
    length: u64,
    modified: u128,
}

impl FileStamp {
    fn read(path: &Path) -> Result<Self> {
        let metadata = fs::metadata(path)?;
        Ok(Self {
            length: metadata.len(),
            modified: metadata.modified()?.duration_since(UNIX_EPOCH)?.as_nanos(),
        })
    }
}

pub struct ClaudeSessionStore {
    roots: Vec<PathBuf>,
    desktop_roots: Vec<PathBuf>,
    backup_root: PathBuf,
    cache: HashMap<PathBuf, (FileStamp, ClaudeSession)>,
    previews: HashMap<String, deletion::StoredPreview>,
}

impl Default for ClaudeSessionStore {
    fn default() -> Self {
        let home = directories::BaseDirs::new()
            .map(|dirs| dirs.home_dir().to_path_buf())
            .unwrap_or_default();
        let mut desktop_roots = Vec::new();
        #[cfg(windows)]
        let supports: Vec<PathBuf> = ["LOCALAPPDATA", "APPDATA"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect();
        #[cfg(target_os = "macos")]
        let supports = vec![home.join("Library/Application Support")];
        #[cfg(not(any(windows, target_os = "macos")))]
        let supports = vec![
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config")),
        ];
        for support in supports {
            for name in ["Claude", "Claude-3p"] {
                desktop_roots.push(support.join(name).join("claude-code-sessions"));
            }
        }
        Self::new(
            vec![
                home.join(".claude"),
                codex_plus_core::tools::default_claude_home_dir(),
            ],
            desktop_roots,
            codex_plus_core::paths::default_app_state_dir().join("backups/claude-sessions"),
        )
    }
}

impl ClaudeSessionStore {
    pub fn new(roots: Vec<PathBuf>, desktop_roots: Vec<PathBuf>, backup_root: PathBuf) -> Self {
        Self {
            roots: unique_roots(roots),
            desktop_roots: unique_roots(desktop_roots),
            backup_root: if backup_root.is_absolute() {
                backup_root
            } else {
                std::env::current_dir()
                    .unwrap_or_default()
                    .join(backup_root)
            },
            cache: HashMap::new(),
            previews: HashMap::new(),
        }
    }

    pub fn list(&mut self, query: &str, offset: usize, limit: usize) -> Result<SessionPage> {
        let (sessions, warnings) = self.inventory()?;
        let terms: Vec<_> = query.split_whitespace().map(str::to_lowercase).collect();
        let mut matches: Vec<_> = sessions
            .into_iter()
            .filter(|session| {
                let text =
                    format!("{} {} {}", session.title, session.cwd, session.id).to_lowercase();
                terms.iter().all(|term| text.contains(term))
            })
            .collect();
        matches.sort_by(|a, b| {
            b.updated_at_ms
                .cmp(&a.updated_at_ms)
                .then_with(|| a.key.cmp(&b.key))
        });
        let total_count = matches.len();
        let limit = limit.clamp(1, 100);
        let offset = offset.min(total_count.saturating_sub(1) / limit * limit);
        let sessions = matches.into_iter().skip(offset).take(limit).collect();
        Ok(SessionPage {
            sessions,
            total_count,
            offset,
            limit,
            has_more: offset.saturating_add(limit) < total_count,
            warnings,
        })
    }

    pub fn messages(&mut self, key: &str, offset: usize, limit: usize) -> Result<MessagePage> {
        let session = self.find(key)?;
        let root = self.root_for(&session.transcript_path)?;
        safety::check_path(root, &session.transcript_path)?;
        reader::messages(&session.transcript_path, offset, limit.clamp(1, 100))
    }

    fn find(&mut self, key: &str) -> Result<ClaudeSession> {
        self.inventory()?
            .0
            .into_iter()
            .find(|session| session.key == key)
            .context("会话已变化或不存在，请刷新列表")
    }

    fn root_for(&self, path: &Path) -> Result<&Path> {
        self.roots
            .iter()
            .chain(&self.desktop_roots)
            .filter(|root| path.starts_with(root))
            .max_by_key(|root| root.components().count())
            .map(PathBuf::as_path)
            .context("会话文件不在允许的目录中")
    }

    fn inventory(&mut self) -> Result<(Vec<ClaudeSession>, Vec<String>)> {
        let mut sessions = Vec::new();
        let mut warnings = Vec::new();
        let mut seen = HashSet::new();
        for root in &self.roots {
            let projects = root.join("projects");
            let result = (|| -> Result<()> {
                safety::check_path(root, &projects)?;
                if !projects.try_exists()? {
                    return Ok(());
                }
                for project in fs::read_dir(&projects)? {
                    let project = project?.path();
                    safety::check_path(root, &project)?;
                    if !project.is_dir()
                        || project
                            .file_name()
                            .is_some_and(|name| name.to_string_lossy().starts_with("ssh-"))
                    {
                        continue;
                    }
                    for entry in fs::read_dir(&project)? {
                        let path = entry?.path();
                        if path.extension().is_none_or(|ext| ext != "jsonl")
                            || path
                                .file_stem()
                                .and_then(|stem| stem.to_str())
                                .is_none_or(|stem| uuid::Uuid::parse_str(stem).is_err())
                        {
                            continue;
                        }
                        let result = (|| -> Result<Option<ClaudeSession>> {
                            safety::check_path(root, &path)?;
                            let stamp = FileStamp::read(&path)?;
                            let mut summary = match self.cache.get(&path) {
                                Some((cached, summary)) if cached == &stamp => summary.clone(),
                                _ => reader::summary(&path)?,
                            };
                            if matches!(
                                summary.protected_reason.as_deref(),
                                Some("子代理记录" | "远程或 WSL 会话")
                            ) {
                                return Ok(None);
                            }
                            ensure!(stamp == FileStamp::read(&path)?, "会话正在写入，请稍后刷新");
                            summary.desktop = false;
                            self.cache.insert(path.clone(), (stamp, summary.clone()));
                            Ok(Some(summary))
                        })();
                        match result {
                            Ok(Some(summary)) if seen.insert(summary.key.clone()) => {
                                sessions.push(summary)
                            }
                            Ok(_) => {}
                            Err(error) => warnings.push(format!("{}：{error}", path.display())),
                        }
                    }
                }
                Ok(())
            })();
            if let Err(error) = result {
                warnings.push(format!("{}：{error}", projects.display()));
            }
        }
        self.cache
            .retain(|_, (_, session)| seen.contains(&session.key));
        // 同一配置根目录下的重复 ID 无法明确归属全局 history.jsonl，禁止破坏性操作。
        let mut identities = HashMap::new();
        for session in &sessions {
            let root = self.root_for(&session.transcript_path)?;
            *identities
                .entry((root.to_path_buf(), session.id.clone()))
                .or_insert(0) += 1;
        }
        for session in &mut sessions {
            let root = self.root_for(&session.transcript_path)?;
            if identities[&(root.to_path_buf(), session.id.clone())] > 1 {
                session.protected_reason = Some("同一配置目录存在重复会话 ID".into());
            }
        }
        let metadata = self.desktop_metadata(&mut warnings)?;
        for session in &mut sessions {
            for (_, record) in &metadata {
                if record.get("cliSessionId").and_then(|v| v.as_str()) == Some(&session.id) {
                    if identities
                        .iter()
                        .filter(|((_, id), _)| id == &session.id)
                        .map(|(_, count)| count)
                        .sum::<usize>()
                        > 1
                    {
                        session.protected_reason = Some("桌面端记录关联到多个会话文件".into());
                    }
                    match record.get("cwd").and_then(|v| v.as_str()) {
                        Some(cwd)
                            if path_key(Path::new(cwd)) == path_key(Path::new(&session.cwd)) =>
                        {
                            session.desktop = true;
                            if let Some(title) = record.get("title").and_then(|v| v.as_str())
                                && !title.trim().is_empty()
                            {
                                session.title = title.to_string();
                            }
                        }
                        Some(_) => {
                            session.protected_reason = Some("桌面端会话关联存在歧义".into());
                        }
                        None => {
                            session.protected_reason = Some("桌面端会话缺少项目路径".into());
                        }
                    }
                }
            }
        }
        Ok((sessions, warnings))
    }

    fn desktop_metadata(
        &self,
        warnings: &mut Vec<String>,
    ) -> Result<Vec<(PathBuf, serde_json::Value)>> {
        let mut metadata = Vec::new();
        for root in &self.desktop_roots {
            let result = (|| -> Result<()> {
                safety::check_path(root, root)?;
                if !root.try_exists()? {
                    return Ok(());
                }
                for path in safety::files_under(root, root)? {
                    if path.extension().is_none_or(|ext| ext != "json")
                        || path
                            .file_name()
                            .is_none_or(|name| !name.to_string_lossy().starts_with("local_"))
                    {
                        continue;
                    }
                    let value: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)
                        .with_context(|| format!("桌面端会话信息损坏：{}", path.display()))?;
                    if value.get("vmProcessName").is_some()
                        || value
                            .get("cwd")
                            .and_then(|v| v.as_str())
                            .is_some_and(|cwd| cwd.starts_with("/sessions/"))
                    {
                        continue;
                    }
                    metadata.push((path, value));
                }
                Ok(())
            })();
            if let Err(error) = result {
                warnings.push(error.to_string());
            }
        }
        Ok(metadata)
    }
}

fn unique_roots(roots: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    roots
        .into_iter()
        .map(|root| {
            if root.is_absolute() {
                root
            } else {
                std::env::current_dir().unwrap_or_default().join(root)
            }
        })
        .map(|root| {
            if safety::check_path(&root, &root).is_ok() {
                fs::canonicalize(&root).unwrap_or(root)
            } else {
                root
            }
        })
        .filter(|root| seen.insert(path_key(root)))
        .collect()
}

fn path_key(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    let text = text.strip_prefix("//?/").unwrap_or(&text);
    let text = if text == "/" {
        text
    } else {
        text.trim_end_matches('/')
    };
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.to_string()
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests;
