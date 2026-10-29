use super::{ClaudeSession, ClaudeSessionStore, now_ms, path_key, safety};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePreview {
    pub token: String,
    pub sessions: Vec<ClaudeSession>,
    pub file_count: usize,
    pub backup_root: PathBuf,
}

pub(super) struct StoredPreview {
    created: Instant,
    targets: Vec<(String, String)>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub key: String,
    pub title: String,
    pub status: String,
    pub message: String,
    pub backup_token: Option<String>,
}

#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteReport {
    pub outcomes: Vec<DeleteOutcome>,
    pub stopped: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSummary {
    pub token: String,
    pub title: String,
    pub session_id: String,
    pub cwd: String,
    pub created_at_ms: i64,
    pub complete: bool,
    pub restored: bool,
    pub file_count: usize,
}

#[derive(Default, Serialize)]
pub struct BackupPage {
    pub backups: Vec<BackupSummary>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
enum AssetKind {
    File,
    History,
    Index,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct Asset {
    root: PathBuf,
    path: PathBuf,
    kind: AssetKind,
    sha256: String,
}

struct PlannedAsset {
    asset: Asset,
    after: Option<Vec<u8>>,
    removed: Vec<Value>,
}

#[derive(Deserialize, Serialize)]
struct Manifest {
    version: u32,
    token: String,
    session: ClaudeSession,
    created_at_ms: i64,
    assets: Vec<Asset>,
    complete: bool,
    restored: bool,
}

impl ClaudeSessionStore {
    /// keys 和 project_path 二选一；预览只读文件，目标快照只驻留后端内存。
    pub fn preview_delete(
        &mut self,
        keys: &[String],
        project_path: Option<&str>,
    ) -> Result<DeletePreview> {
        ensure!(
            keys.is_empty() != project_path.is_none(),
            "请选择会话或项目"
        );
        let (all, _) = self.inventory()?;
        let mut requested: HashSet<_> = keys.iter().cloned().collect();
        let sessions: Vec<_> = all
            .into_iter()
            .filter(|session| {
                if let Some(project) = project_path {
                    !project.trim().is_empty()
                        && path_key(Path::new(&session.cwd)) == path_key(Path::new(project))
                } else {
                    requested.remove(&session.key)
                }
            })
            .collect();
        ensure!(requested.is_empty(), "部分会话已不存在，请刷新列表");
        ensure!(!sessions.is_empty(), "没有可删除的会话");
        let mut file_count = 0;
        let mut targets = Vec::new();
        for session in &sessions {
            let plan = self.plan_assets(session)?;
            file_count += plan.len();
            targets.push((session.key.clone(), signature(&plan)?));
        }
        self.previews
            .retain(|_, preview| preview.created.elapsed() < Duration::from_secs(600));
        ensure!(self.previews.len() < 16, "待确认操作过多，请稍后重试");
        let token = uuid::Uuid::new_v4().to_string();
        self.previews.insert(
            token.clone(),
            StoredPreview {
                created: Instant::now(),
                targets,
            },
        );
        Ok(DeletePreview {
            token,
            sessions,
            file_count,
            backup_root: self.backup_root.clone(),
        })
    }

    pub fn delete(&mut self, token: &str) -> Result<DeleteReport> {
        self.delete_with_guard(token, safety::ensure_claude_stopped)
    }

    fn delete_with_guard(
        &mut self,
        token: &str,
        mut guard: impl FnMut() -> Result<()>,
    ) -> Result<DeleteReport> {
        guard()?;
        let preview = self
            .previews
            .remove(token)
            .context("删除预览已失效，请重新确认")?;
        ensure!(
            preview.created.elapsed() < Duration::from_secs(600),
            "删除预览已过期，请重新确认"
        );
        let mut report = DeleteReport::default();
        for (key, expected) in preview.targets {
            if let Err(error) = guard() {
                report.stopped = true;
                report.outcomes.push(DeleteOutcome {
                    key,
                    title: String::new(),
                    status: "failed".into(),
                    message: error.to_string(),
                    backup_token: None,
                });
                break;
            }
            let mut backup_token = None;
            let mut title = String::new();
            let result = (|| -> Result<()> {
                let session = self.find(&key)?;
                title = session.title.clone();
                let plan = self.plan_assets(&session)?;
                ensure!(signature(&plan)? == expected, "会话文件已变化，请重新预览");
                let mut manifest = self.write_snapshot(&session, &plan)?;
                backup_token = Some(manifest.token.clone());
                guard()?;
                let current = self.plan_assets(&session)?;
                ensure!(
                    signature(&current)? == expected,
                    "备份后会话文件发生变化，请重新预览"
                );
                for planned in &plan {
                    guard()?;
                    safety::check_path(&planned.asset.root, &planned.asset.path)?;
                    ensure!(
                        hash_file(&planned.asset.path)? == planned.asset.sha256,
                        "文件已变化，已停止删除：{}",
                        planned.asset.path.display()
                    );
                    if let Some(after) = &planned.after {
                        codex_plus_core::settings::atomic_write(&planned.asset.path, after)?;
                    } else {
                        fs::remove_file(&planned.asset.path)?;
                    }
                }
                manifest.complete = true;
                self.save_manifest(&manifest)?;
                self.cache.remove(&session.transcript_path);
                remove_empty_session_dirs(&session.transcript_path)?;
                Ok(())
            })();
            let status = if result.is_ok() {
                "ok"
            } else if backup_token.is_some() {
                "partial"
            } else {
                "failed"
            };
            report.outcomes.push(DeleteOutcome {
                key,
                title,
                status: status.into(),
                message: result
                    .err()
                    .map(|error| format!("{error:#}"))
                    .unwrap_or_else(|| "已删除并备份".into()),
                backup_token,
            });
            if let Err(error) = guard() {
                report.stopped = true;
                if let Some(last) = report.outcomes.last_mut() {
                    last.message.push_str(&format!("；批处理已停止：{error}"));
                }
                break;
            }
        }
        if let Err(error) = self.prune_backups() {
            if let Some(last) = report.outcomes.last_mut() {
                last.message.push_str(&format!("；旧备份清理失败：{error}"));
            }
        }
        Ok(report)
    }

    fn plan_assets(&self, session: &ClaudeSession) -> Result<Vec<PlannedAsset>> {
        ensure!(
            session.protected_reason.is_none(),
            "{}",
            session.protected_reason.as_deref().unwrap_or("")
        );
        let root = self.root_for(&session.transcript_path)?.to_path_buf();
        let mut paths = vec![(
            root.clone(),
            session.transcript_path.clone(),
            AssetKind::File,
        )];
        let directory = session.transcript_path.with_extension("");
        safety::check_path(&root, &directory)?;
        if directory.try_exists()? {
            for path in safety::files_under(&root, &directory)? {
                paths.push((root.clone(), path, AssetKind::File));
            }
        }
        for (path, kind) in [
            (root.join("history.jsonl"), AssetKind::History),
            (
                session
                    .transcript_path
                    .with_file_name("sessions-index.json"),
                AssetKind::Index,
            ),
        ] {
            safety::check_path(&root, &path)?;
            if path.try_exists()? {
                paths.push((root.clone(), path, kind));
            }
        }
        let mut warnings = Vec::new();
        for (path, metadata) in self.desktop_metadata(&mut warnings)? {
            let id = metadata["cliSessionId"].as_str();
            let cwd_matches = metadata["cwd"]
                .as_str()
                .is_some_and(|cwd| path_key(Path::new(cwd)) == path_key(Path::new(&session.cwd)));
            if id == Some(&session.id) {
                ensure!(cwd_matches, "桌面端会话的项目路径不匹配");
                paths.push((self.root_for(&path)?.to_path_buf(), path, AssetKind::File));
            } else if id.is_none() && cwd_matches {
                anyhow::bail!("该项目存在无法关联的桌面端记录，已停止删除");
            }
        }
        ensure!(
            warnings.is_empty(),
            "无法完整检查桌面端会话信息：{}",
            warnings.join("；")
        );
        let mut plan = Vec::new();
        for (root, path, kind) in paths {
            safety::check_path(&root, &path)?;
            let before_hash = hash_file(&path)?;
            let (after, removed) = if matches!(kind, AssetKind::File) {
                (None, Vec::new())
            } else {
                let bytes = read_shared(&path)?;
                let (after, removed) = remove_entries(&bytes, &kind, &session.id)?;
                if removed.is_empty() {
                    continue;
                }
                (Some(after), removed)
            };
            ensure!(
                hash_file(&path)? == before_hash,
                "会话文件正在变化，请稍后重试"
            );
            plan.push(PlannedAsset {
                asset: Asset {
                    root,
                    path,
                    kind,
                    sha256: before_hash,
                },
                after,
                removed,
            });
        }
        plan.sort_by(|a, b| a.asset.path.cmp(&b.asset.path));
        Ok(plan)
    }

    fn write_snapshot(&self, session: &ClaudeSession, plan: &[PlannedAsset]) -> Result<Manifest> {
        safety::check_path(&self.backup_root, &self.backup_root)?;
        fs::create_dir_all(&self.backup_root)?;
        private_permissions(&self.backup_root, true)?;
        let token = format!("{}-{}", now_ms(), uuid::Uuid::new_v4());
        let directory = self.backup_root.join(&token);
        fs::create_dir(&directory)?;
        private_permissions(&directory, true)?;
        for (index, planned) in plan.iter().enumerate() {
            safety::check_path(&planned.asset.root, &planned.asset.path)?;
            let destination = directory.join(format!("{index}.bin"));
            fs::copy(&planned.asset.path, &destination)?;
            private_permissions(&destination, false)?;
            ensure!(
                hash_file(&destination)? == planned.asset.sha256,
                "备份时文件发生变化，未删除会话"
            );
            fs::OpenOptions::new()
                .write(true)
                .open(destination)?
                .sync_all()?;
        }
        let manifest = Manifest {
            version: 1,
            token,
            session: session.clone(),
            created_at_ms: now_ms(),
            assets: plan.iter().map(|planned| planned.asset.clone()).collect(),
            complete: false,
            restored: false,
        };
        self.save_manifest(&manifest)?;
        Ok(manifest)
    }

    fn save_manifest(&self, manifest: &Manifest) -> Result<()> {
        let path = self.backup_root.join(&manifest.token).join("manifest.json");
        safety::check_path(&self.backup_root, &path)?;
        codex_plus_core::settings::atomic_write(&path, &serde_json::to_vec_pretty(manifest)?)?;
        private_permissions(&path, false)?;
        fs::OpenOptions::new().write(true).open(path)?.sync_all()?;
        Ok(())
    }

    pub fn backups(&self) -> Result<BackupPage> {
        let mut page = BackupPage::default();
        safety::check_path(&self.backup_root, &self.backup_root)?;
        if !self.backup_root.try_exists()? {
            return Ok(page);
        }
        for entry in fs::read_dir(&self.backup_root)? {
            let entry = entry?;
            let token = entry.file_name().to_string_lossy().into_owned();
            match self.read_manifest(&token) {
                Ok(manifest) => page.backups.push(BackupSummary {
                    token,
                    title: manifest.session.title,
                    session_id: manifest.session.id,
                    cwd: manifest.session.cwd,
                    created_at_ms: manifest.created_at_ms,
                    complete: manifest.complete,
                    restored: manifest.restored,
                    file_count: manifest.assets.len(),
                }),
                Err(error) => page.warnings.push(format!("备份 {token}：{error}")),
            }
        }
        page.backups.sort_by(|a, b| {
            b.created_at_ms
                .cmp(&a.created_at_ms)
                .then_with(|| a.token.cmp(&b.token))
        });
        Ok(page)
    }

    fn read_manifest(&self, token: &str) -> Result<Manifest> {
        let (epoch, uuid) = token.split_once('-').context("备份标识无效")?;
        ensure!(
            epoch.parse::<i64>().is_ok() && uuid::Uuid::parse_str(uuid).is_ok(),
            "备份标识无效"
        );
        let path = self.backup_root.join(token).join("manifest.json");
        safety::check_path(&self.backup_root, &path)?;
        let manifest: Manifest = serde_json::from_slice(&read_shared(&path)?)?;
        ensure!(
            manifest.version == 1 && manifest.token == token,
            "备份格式不匹配"
        );
        Ok(manifest)
    }

    pub fn restore(&mut self, token: &str) -> Result<()> {
        self.restore_with_guard(token, safety::ensure_claude_stopped)
    }

    fn restore_with_guard(
        &mut self,
        token: &str,
        mut guard: impl FnMut() -> Result<()>,
    ) -> Result<()> {
        guard()?;
        let mut manifest = self.read_manifest(token)?;
        let mut writes = Vec::new();
        let session_path = &manifest.session.transcript_path;
        let session_root = self.root_for(session_path)?;
        safety::check_path(session_root, session_path)?;
        let relative = session_path.strip_prefix(session_root)?;
        ensure!(
            relative.components().count() == 3
                && relative.starts_with("projects")
                && session_path
                    .extension()
                    .is_some_and(|extension| extension == "jsonl")
                && session_path.file_stem().and_then(|s| s.to_str()) == Some(&manifest.session.id)
                && uuid::Uuid::parse_str(&manifest.session.id).is_ok(),
            "备份中的会话路径无效"
        );
        for (index, asset) in manifest.assets.iter().enumerate() {
            self.validate_asset(&manifest.session, asset)?;
            let data = self.backup_root.join(token).join(format!("{index}.bin"));
            safety::check_path(&self.backup_root, &data)?;
            ensure!(hash_file(&data)? == asset.sha256, "备份内容校验失败");
            let existing = if asset.path.try_exists()? {
                Some(hash_file(&asset.path)?)
            } else {
                None
            };
            let replacement = match asset.kind {
                AssetKind::File => {
                    ensure!(
                        existing.as_ref().is_none_or(|hash| *hash == asset.sha256),
                        "目标已有不同内容，未覆盖：{}",
                        asset.path.display()
                    );
                    if existing.is_some() {
                        continue;
                    }
                    None
                }
                AssetKind::History | AssetKind::Index => {
                    let original = read_shared(&data)?;
                    let current = if existing.is_some() {
                        read_shared(&asset.path)?
                    } else {
                        match asset.kind {
                            AssetKind::Index => {
                                let mut value: Value = serde_json::from_slice(&original)?;
                                value["entries"] = Value::Array(Vec::new());
                                serde_json::to_vec(&value)?
                            }
                            _ => Vec::new(),
                        }
                    };
                    Some(merge_entries(
                        &original,
                        &current,
                        &asset.kind,
                        &manifest.session.id,
                    )?)
                }
            };
            writes.push((asset.clone(), data, replacement, existing));
        }
        for (asset, data, replacement, expected) in writes {
            guard()?;
            self.validate_asset(&manifest.session, &asset)?;
            let current = if asset.path.try_exists()? {
                Some(hash_file(&asset.path)?)
            } else {
                None
            };
            ensure!(current == expected, "恢复期间目标文件发生变化，已停止");
            if let Some(bytes) = replacement {
                codex_plus_core::settings::atomic_write(&asset.path, &bytes)?;
            } else {
                if let Some(parent) = asset.path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut target = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&asset.path)?;
                std::io::copy(&mut File::open(data)?, &mut target)?;
                target.flush()?;
                target.sync_all()?;
                private_permissions(&asset.path, false)?;
            }
        }
        manifest.restored = true;
        self.save_manifest(&manifest)?;
        self.cache.clear();
        Ok(())
    }

    fn validate_asset(&self, session: &ClaudeSession, asset: &Asset) -> Result<()> {
        let root = self.root_for(&asset.path)?;
        ensure!(
            path_key(root) == path_key(&asset.root),
            "备份来源目录不匹配"
        );
        safety::check_path(root, &asset.path)?;
        let session_root = self.root_for(&session.transcript_path)?;
        let owned = asset.path == session.transcript_path
            || asset
                .path
                .starts_with(session.transcript_path.with_extension(""));
        let valid = match asset.kind {
            AssetKind::History => asset.path == session_root.join("history.jsonl"),
            AssetKind::Index => {
                asset.path
                    == session
                        .transcript_path
                        .with_file_name("sessions-index.json")
            }
            AssetKind::File => {
                owned
                    || self.desktop_roots.iter().any(|desktop| {
                        asset.path.starts_with(desktop)
                            && asset
                                .path
                                .extension()
                                .is_some_and(|extension| extension == "json")
                            && asset
                                .path
                                .file_name()
                                .is_some_and(|name| name.to_string_lossy().starts_with("local_"))
                    })
            }
        };
        ensure!(valid, "备份包含不属于该会话的文件");
        Ok(())
    }

    fn prune_backups(&self) -> Result<()> {
        self.cleanup_expired_backups().map(|_| ())
    }

    pub fn cleanup_expired_backups(&self) -> Result<usize> {
        let backups = self.backups()?.backups;
        let mut removed = 0;
        for backup in backups
            .into_iter()
            .skip(crate::backup::RETAINED_BACKUP_MANIFESTS)
        {
            if backup.created_at_ms >= now_ms() - 7 * 24 * 60 * 60 * 1000 {
                continue;
            }
            self.delete_backup(&backup.token)
                .with_context(|| format!("已清理 {removed} 份备份，后续清理失败"))?;
            removed += 1;
        }
        Ok(removed)
    }

    pub fn delete_backup(&self, token: &str) -> Result<()> {
        self.read_manifest(token)?;
        let directory = self.backup_root.join(token);
        let paths = safety::files_under(&self.backup_root, &directory)?;
        ensure!(
            paths
                .iter()
                .all(|path| path.parent() == Some(directory.as_path())
                    && path
                        .file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name == "manifest.json"
                            || name
                                .strip_suffix(".bin")
                                .is_some_and(|stem| stem.parse::<usize>().is_ok()))),
            "备份目录包含未知文件"
        );
        for path in paths {
            safety::check_path(&self.backup_root, &path)?;
            fs::remove_file(path)?;
        }
        fs::remove_dir(&directory)?;
        Ok(())
    }
}

fn read_shared(path: &Path) -> Result<Vec<u8>> {
    const MAX_SHARED_BYTES: u64 = 64 * 1024 * 1024;
    let mut bytes = Vec::new();
    File::open(path)?
        .take(MAX_SHARED_BYTES + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_SHARED_BYTES,
        "索引或备份清单超过 64 MiB，请先检查文件"
    );
    Ok(bytes)
}

fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn signature(plan: &[PlannedAsset]) -> Result<String> {
    let mut digest = Sha256::new();
    for planned in plan {
        digest.update(serde_json::to_vec(&(
            &planned.asset.root,
            &planned.asset.path,
            &planned.asset.kind,
        ))?);
        // 全局索引可能被本批次前一个会话修改；这里只固定本会话条目，执行时再校验整文件。
        if matches!(planned.asset.kind, AssetKind::File) {
            digest.update(planned.asset.sha256.as_bytes());
        } else {
            digest.update(serde_json::to_vec(&planned.removed)?);
        }
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn history_rows(bytes: &[u8]) -> Result<Vec<(String, Value)>> {
    let text = std::str::from_utf8(bytes).context("历史索引不是 UTF-8")?;
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            Ok((
                line.to_string(),
                serde_json::from_str(line).context("历史索引包含损坏记录，未修改")?,
            ))
        })
        .collect()
}

fn index_value(bytes: &[u8]) -> Result<Value> {
    let value: Value = serde_json::from_slice(bytes).context("会话索引损坏，未修改")?;
    ensure!(value["entries"].is_array(), "无法识别会话索引格式，未修改");
    Ok(value)
}

fn remove_entries(bytes: &[u8], kind: &AssetKind, id: &str) -> Result<(Vec<u8>, Vec<Value>)> {
    let mut removed = Vec::new();
    let after = match kind {
        AssetKind::History => {
            let mut after = String::new();
            for (raw, value) in history_rows(bytes)? {
                if value["sessionId"].as_str() == Some(id) {
                    removed.push(Value::String(raw));
                } else {
                    after.push_str(&raw);
                    after.push('\n');
                }
            }
            after.into_bytes()
        }
        AssetKind::Index => {
            let mut value = index_value(bytes)?;
            value["entries"].as_array_mut().unwrap().retain(|entry| {
                if entry["sessionId"].as_str() == Some(id) {
                    removed.push(entry.clone());
                    false
                } else {
                    true
                }
            });
            serde_json::to_vec_pretty(&value)?
        }
        AssetKind::File => anyhow::bail!("文件不属于共享索引"),
    };
    Ok((after, removed))
}

fn merge_entries(original: &[u8], current: &[u8], kind: &AssetKind, id: &str) -> Result<Vec<u8>> {
    match kind {
        AssetKind::History => {
            let saved: Vec<_> = history_rows(original)?
                .into_iter()
                .filter(|(_, value)| value["sessionId"].as_str() == Some(id))
                .collect();
            let present = history_rows(current)?;
            let relevant: Vec<_> = present
                .iter()
                .filter(|(_, value)| value["sessionId"].as_str() == Some(id))
                .collect();
            ensure!(
                relevant
                    .iter()
                    .all(|(_, value)| saved.iter().any(|(_, old)| old == value)),
                "历史索引已有不同的会话记录"
            );
            let mut text = std::str::from_utf8(current)?.to_string();
            for (raw, value) in saved {
                if present.iter().any(|(_, existing)| existing == &value) {
                    continue;
                }
                if !text.is_empty() && !text.ends_with('\n') {
                    text.push('\n');
                }
                text.push_str(&raw);
                text.push('\n');
            }
            Ok(text.into_bytes())
        }
        AssetKind::Index => {
            let original = index_value(original)?;
            let mut current = index_value(current)?;
            let saved: Vec<_> = original["entries"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["sessionId"].as_str() == Some(id))
                .collect();
            let present = current["entries"].as_array_mut().unwrap();
            ensure!(
                present
                    .iter()
                    .filter(|entry| entry["sessionId"].as_str() == Some(id))
                    .all(|entry| saved.contains(&entry)),
                "会话索引已有不同内容"
            );
            for entry in saved {
                if !present.contains(entry) {
                    present.push(entry.clone());
                }
            }
            Ok(serde_json::to_vec_pretty(&current)?)
        }
        AssetKind::File => anyhow::bail!("文件不属于共享索引"),
    }
}

fn private_permissions(path: &Path, directory: bool) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            path,
            fs::Permissions::from_mode(if directory { 0o700 } else { 0o600 }),
        )?;
    }
    #[cfg(not(unix))]
    let _ = (path, directory);
    Ok(())
}

fn remove_empty_session_dirs(transcript: &Path) -> Result<()> {
    let directory = transcript.with_extension("");
    if !directory.try_exists()? {
        return Ok(());
    }
    fn remove_empty(root: &Path, directory: &Path) -> Result<()> {
        safety::check_path(root, directory)?;
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            safety::check_path(root, &path)?;
            if path.is_dir() {
                remove_empty(root, &path)?;
            }
        }
        if fs::read_dir(directory)?.next().is_none() {
            fs::remove_dir(directory)?;
        }
        Ok(())
    }
    remove_empty(&directory, &directory)
}

#[cfg(test)]
mod tests;
