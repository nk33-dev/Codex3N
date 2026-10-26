use anyhow::Context;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const COPY_BUFFER_BYTES: usize = 64 * 1024;

/// 至少保留的最新备份份数。
const RETAINED_BACKUP_MANIFESTS: usize = 10;
/// 超过这个时长、且不在最新 [`RETAINED_BACKUP_MANIFESTS`] 份之内的备份才回收。
/// 按时长而不是只按份数：一次批量删除几十个会话时，同一次操作的备份必须全部保留。
const BACKUP_RETENTION_SECS: u64 = 7 * 24 * 60 * 60;

#[derive(Debug, Clone)]
pub struct BackupStore {
    root: PathBuf,
    file_byte_limit: Option<u64>,
    #[cfg(test)]
    fail_before_manifest: bool,
}

#[derive(Debug)]
pub(crate) struct BackupFileSource {
    pub path: PathBuf,
    pub original_path: String,
}

struct PendingBackupFiles {
    created: Vec<PathBuf>,
    committed: bool,
}
impl Drop for PendingBackupFiles {
    fn drop(&mut self) {
        if !self.committed {
            // 只清理本次 create_new 获得的 blob；不遍历、不清理历史备份或用户源文件。
            for path in &self.created {
                let _ = fs::remove_file(path);
            }
        }
    }
}

impl BackupStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            file_byte_limit: None,
            #[cfg(test)]
            fail_before_manifest: false,
        }
    }

    /// 默认保留原有撤销能力；显式预算超限时拒绝删除，不自动清理历史备份。
    pub fn with_file_byte_limit(mut self, limit: u64) -> Self {
        self.file_byte_limit = Some(limit);
        self
    }

    pub fn write_backup(
        &self,
        session_id: &str,
        source_db: &Path,
        tables: Value,
    ) -> anyhow::Result<String> {
        Ok(self
            .write_backup_with_files(session_id, source_db, tables, &[])?
            .0)
    }

    pub(crate) fn write_backup_with_files(
        &self,
        session_id: &str,
        source_db: &Path,
        mut tables: Value,
        files: &[BackupFileSource],
    ) -> anyhow::Result<(String, Vec<Value>)> {
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let token = format!("{epoch}-{}", Uuid::new_v4().simple());
        private_directory(&self.root, false).with_context(|| {
            format!("failed to create backup directory {}", self.root.display())
        })?;
        let estimated = files
            .iter()
            .try_fold(0_u64, |size, file| -> anyhow::Result<u64> {
                let metadata = fs::metadata(&file.path)?;
                if !metadata.is_file() {
                    anyhow::bail!("backup source is not a file: {}", file.path.display());
                }
                size.checked_add(metadata.len())
                    .ok_or_else(|| anyhow::anyhow!("backup size overflow"))
            })?;
        let budget = self
            .file_byte_limit
            .unwrap_or(u64::MAX)
            .min(fs2::available_space(&self.root)?);
        if estimated > budget {
            anyhow::bail!(
                "backup requires {estimated} bytes, available file budget is {budget}; original data was not deleted"
            );
        }
        let mut entries = Vec::new();
        let mut copied_total = 0_u64;
        let mut pending = PendingBackupFiles {
            created: Vec::new(),
            committed: false,
        };
        if !files.is_empty() {
            let directory = self.root.join(format!("{token}.files"));
            private_directory(&directory, true)?;
            for file in files {
                let name = format!("{}.blob", Uuid::new_v4().simple());
                let blob = directory.join(&name);
                let mut input = File::open(&file.path)?;
                let mut output = new_private_file(&blob)?;
                pending.created.push(blob.clone());
                let (size, sha256) =
                    copy_hashed(&mut input, &mut output, budget.saturating_sub(copied_total))?;
                output.sync_all()?;
                copied_total = copied_total
                    .checked_add(size)
                    .ok_or_else(|| anyhow::anyhow!("backup size overflow"))?;
                // 读取完成后再检查实际源内容，变化中的 rollout 不可被当成完整备份。
                if hash_file(&file.path)? != (size, sha256.clone()) {
                    anyhow::bail!("rollout changed while backing up: {}", file.path.display());
                }
                let mut entry = json!({"path": file.path, "blob_ref": format!("{token}.files/{name}"), "size_bytes": size, "sha256": sha256});
                if file.path.to_string_lossy() != file.original_path {
                    entry["source_path"] = json!(file.original_path);
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    entry["unix_mode"] = json!(input.metadata()?.permissions().mode());
                }
                entries.push(entry);
            }
            tables
                .as_object_mut()
                .ok_or_else(|| anyhow::anyhow!("backup tables must be an object"))?
                .insert("__files".into(), Value::Array(entries.clone()));
        }
        #[cfg(test)]
        if self.fail_before_manifest {
            anyhow::bail!("fixture manifest publication failure");
        }
        if !files.is_empty() {
            sync_directory(&self.root.join(format!("{token}.files")))?;
        }
        let payload = json!({"version": 2, "token": token, "session_id": session_id, "source_db": source_db, "tables": tables});
        // blob 完整并持久化后再发布 manifest；调用方只有拿到 token 才可删除数据库行。
        private_atomic_write(
            &self.path_for(&token),
            &serde_json::to_vec_pretty(&payload)?,
        )?;
        pending.committed = true;
        sync_file(&self.path_for(&token))?;
        let _ = self.prune_retained_backups(&token);
        Ok((token, entries))
    }

    fn prune_retained_backups(&self, current: &str) -> anyhow::Result<()> {
        let Ok(entries) = fs::read_dir(&self.root) else {
            return Ok(());
        };
        let mut manifests: Vec<(u64, String)> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let kind = entry.file_type().ok()?;
                if !kind.is_file() || kind.is_symlink() {
                    return None;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                let token = name.strip_suffix(".json")?;
                let epoch = backup_token_epoch(token)?;
                (token != current).then(|| (epoch, token.to_string()))
            })
            .collect();
        manifests.sort_by(|left, right| right.0.cmp(&left.0));
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        for (epoch, token) in manifests.into_iter().skip(RETAINED_BACKUP_MANIFESTS - 1) {
            if now.saturating_sub(epoch) < BACKUP_RETENTION_SECS {
                continue;
            }
            let Ok(bytes) = fs::read(self.path_for(&token)) else {
                continue;
            };
            let Ok(snapshot) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            // 分离文件快照仍是用户的恢复来源，自动回收只处理内联快照。
            if snapshot
                .pointer("/tables/__files")
                .and_then(Value::as_array)
                .is_some_and(|files| files.iter().any(|file| file.get("blob_ref").is_some()))
            {
                continue;
            }
            if fs::remove_file(self.path_for(&token)).is_ok() {
                remove_backup_blob_directory(&self.root, &token);
            }
        }
        Ok(())
    }

    /// 只保留最近 `keep` 份快照，返回删除的份数。
    ///
    /// 文件名是 `<epoch>-<uuid>.json`，epoch 定长（10 位），按文件名倒序即按
    /// 时间倒序，不需要读文件内容。
    pub fn prune(&self, keep: usize) -> anyhow::Result<usize> {
        self.prune_older_than(keep, u64::MAX)
    }

    /// 保留最近 `keep` 份，以及 epoch 不早于 `keep_since` 的快照。
    pub fn prune_older_than(&self, keep: usize, keep_since: u64) -> anyhow::Result<usize> {
        let entries = match fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to read {}", self.root.to_string_lossy()));
            }
        };
        let mut names = Vec::new();
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
                names.push(name.to_string());
            }
        }
        names.sort_by(|left, right| right.cmp(left));
        let mut removed = 0usize;
        for name in names.into_iter().skip(keep) {
            let epoch = name
                .split('-')
                .next()
                .and_then(|value| value.parse::<u64>().ok());
            if epoch.is_some_and(|epoch| epoch >= keep_since) {
                continue;
            }
            let snapshot: serde_json::Value =
                serde_json::from_slice(&fs::read(self.root.join(&name))?)?;
            if snapshot
                .pointer("/tables/__files")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|files| files.iter().any(|file| file.get("blob_ref").is_some()))
            {
                continue;
            }
            fs::remove_file(self.root.join(&name)).with_context(|| {
                format!("failed to prune backup {}", self.root.join(&name).display())
            })?;
            removed += 1;
        }
        Ok(removed)
    }

    pub fn read_backup(&self, token: &str) -> anyhow::Result<Value> {
        let text = fs::read_to_string(self.path_for(token))
            .with_context(|| format!("Backup token not found: {token}"))?;
        Ok(serde_json::from_str(&text)?)
    }

    pub fn path_for(&self, token: &str) -> PathBuf {
        let safe: String = token
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
            .collect();
        self.root.join(format!("{safe}.json"))
    }

    fn blob_path(&self, token: &str, entry: &Value) -> anyhow::Result<PathBuf> {
        if token.is_empty()
            || !token
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        {
            anyhow::bail!("invalid blob backup token");
        }
        let relative = Path::new(
            entry["blob_ref"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missing blob reference"))?,
        );
        let parts = relative.components().collect::<Vec<_>>();
        if parts.len() != 2
            || !parts
                .iter()
                .all(|part| matches!(part, Component::Normal(_)))
            || parts[0].as_os_str() != std::ffi::OsStr::new(&format!("{token}.files"))
        {
            anyhow::bail!("blob reference escapes owning backup");
        }
        let directory = self.root.join(format!("{token}.files"));
        let path = self.root.join(relative);
        if fs::symlink_metadata(&directory)?.file_type().is_symlink()
            || fs::symlink_metadata(&path)?.file_type().is_symlink()
        {
            anyhow::bail!("blob symlinks are not supported");
        }
        let root = fs::canonicalize(&self.root)?;
        let canonical_dir = fs::canonicalize(&directory)?;
        let canonical = fs::canonicalize(&path)?;
        if canonical_dir.parent() != Some(root.as_path())
            || canonical.parent() != Some(canonical_dir.as_path())
            || !canonical.is_file()
        {
            anyhow::bail!("blob reference escapes owning backup");
        }
        Ok(canonical)
    }

    pub(crate) fn validate_file_backup(&self, token: &str, entry: &Value) -> anyhow::Result<()> {
        if let Some(content) = entry.get("content_b64").and_then(Value::as_str) {
            let mut reader = base64::read::DecoderReader::new(
                content.as_bytes(),
                &base64::engine::general_purpose::STANDARD,
            );
            std::io::copy(&mut reader, &mut std::io::sink())?;
            return Ok(());
        }
        let path = self.blob_path(token, entry)?;
        let (bytes, hash) = hash_file(&path)?;
        if entry["size_bytes"].as_u64() != Some(bytes)
            || entry["sha256"].as_str() != Some(hash.as_str())
        {
            anyhow::bail!("backup blob size/hash mismatch");
        }
        Ok(())
    }

    pub(crate) fn source_file_unchanged(&self, entry: &Value) -> anyhow::Result<()> {
        let path = Path::new(
            entry["path"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missing original file path"))?,
        );
        let (bytes, hash) = hash_file(path)?;
        if entry["size_bytes"].as_u64() != Some(bytes)
            || entry["sha256"].as_str() != Some(hash.as_str())
        {
            anyhow::bail!("rollout changed after backup: {}", path.display());
        }
        Ok(())
    }

    pub(crate) fn restore_file(&self, token: &str, entry: &Value) -> anyhow::Result<()> {
        self.validate_file_backup(token, entry)?;
        let path = Path::new(
            entry["path"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("missing restore path"))?,
        );
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("restore path has no parent"))?;
        fs::create_dir_all(parent)?;
        let temporary = parent.join(format!(".codex-restore-{}", Uuid::new_v4().simple()));
        let result = (|| -> anyhow::Result<()> {
            let mut output = new_private_file(&temporary)?;
            if let Some(content) = entry.get("content_b64").and_then(Value::as_str) {
                let mut reader = base64::read::DecoderReader::new(
                    content.as_bytes(),
                    &base64::engine::general_purpose::STANDARD,
                );
                std::io::copy(&mut reader, &mut output)?;
            } else {
                let mut reader = File::open(self.blob_path(token, entry)?)?;
                let (size, hash) = copy_hashed(
                    &mut reader,
                    &mut output,
                    entry["size_bytes"]
                        .as_u64()
                        .ok_or_else(|| anyhow::anyhow!("missing backup size"))?,
                )?;
                if entry["size_bytes"].as_u64() != Some(size)
                    || entry["sha256"].as_str() != Some(hash.as_str())
                {
                    anyhow::bail!("backup changed while restoring");
                }
            }
            #[cfg(unix)]
            if let Some(mode) = entry["unix_mode"].as_u64() {
                use std::os::unix::fs::PermissionsExt;
                output.set_permissions(fs::Permissions::from_mode(mode as u32))?;
            }
            output.sync_all()?;
            drop(output);
            // 硬链接发布是 create-if-absent；并发重建的目标不会被 rename 覆盖。
            fs::hard_link(&temporary, path).context("restore target exists or filesystem does not support atomic non-replacing publication")?;
            sync_directory(parent)?;
            Ok(())
        })();
        let _ = fs::remove_file(&temporary);
        result
    }
}

pub(crate) fn new_private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

pub(crate) fn private_directory(path: &Path, exclusive: bool) -> std::io::Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(std::io::Error::other(
            "managed backup directory must not be a symlink",
        ));
    }
    if exclusive {
        fs::create_dir(path)?;
    } else {
        fs::create_dir_all(path)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

pub(crate) fn private_atomic_write(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    codex_plus_core::settings::atomic_write_with(path, |file| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(bytes)?;
        file.sync_all()
    })?;
    if let Some(parent) = path.parent() {
        sync_directory(parent)?;
    }
    Ok(())
}

/// 把已写好的文件刷到磁盘。
///
/// 必须用可写句柄：Windows 的 `FlushFileBuffers` 要求 `GENERIC_WRITE`，
/// `File::open` 拿到的只读句柄刷盘必然返回 `ERROR_ACCESS_DENIED (5)`，
/// provider 同步因此整次 skipped（#2612）。不截断、不创建，只为刷盘而打开。
pub(crate) fn sync_file(path: &Path) -> std::io::Result<()> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)?
        .sync_all()
}

pub(crate) fn sync_directory(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        File::open(if path.as_os_str().is_empty() {
            Path::new(".")
        } else {
            path
        })?
        .sync_all()?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn copy_hashed(
    reader: &mut impl Read,
    writer: &mut impl Write,
    limit: u64,
) -> anyhow::Result<(u64, String)> {
    let mut buffer = [0_u8; COPY_BUFFER_BYTES];
    let mut size = 0_u64;
    let mut hash = Sha256::new();
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        size = size
            .checked_add(count as u64)
            .ok_or_else(|| anyhow::anyhow!("backup size overflow"))?;
        if size > limit {
            anyhow::bail!("backup file byte budget exceeded; original data was not deleted");
        }
        writer.write_all(&buffer[..count])?;
        hash.update(&buffer[..count]);
    }
    Ok((size, format!("{:x}", hash.finalize())))
}
fn hash_file(path: &Path) -> anyhow::Result<(u64, String)> {
    copy_hashed(&mut File::open(path)?, &mut std::io::sink(), u64::MAX)
}

/// 解析 `write_backup_with_files` 生成的 token：`{epoch}-{uuid 简写}`。
fn backup_token_epoch(token: &str) -> Option<u64> {
    let (epoch, id) = token.split_once('-')?;
    if id.len() != 32 || !id.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    epoch.parse().ok()
}

/// 删除某份备份的 blob 目录。逐条删除、不递归到符号链接目标。
fn remove_backup_blob_directory(root: &Path, token: &str) {
    let directory = root.join(format!("{token}.files"));
    let Ok(metadata) = fs::symlink_metadata(&directory) else {
        return;
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return;
    }
    if let Ok(entries) = fs::read_dir(&directory) {
        for entry in entries.filter_map(Result::ok) {
            if entry.file_type().is_ok_and(|file_type| file_type.is_file()) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let _ = fs::remove_dir(&directory);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copy_is_bounded_and_writer_failure_is_propagated() {
        struct Large {
            remaining: usize,
            largest: usize,
        }
        impl Read for Large {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                self.largest = self.largest.max(buffer.len());
                let size = buffer.len().min(self.remaining);
                buffer[..size].fill(1);
                self.remaining -= size;
                Ok(size)
            }
        }
        let mut source = Large {
            remaining: 9 * 1024 * 1024,
            largest: 0,
        };
        let (size, _) = copy_hashed(&mut source, &mut std::io::sink(), u64::MAX).unwrap();
        assert_eq!(size, 9 * 1024 * 1024);
        assert_eq!(source.largest, COPY_BUFFER_BYTES);
        struct Fails;
        impl Write for Fails {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("fixture full disk"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        assert!(copy_hashed(&mut &b"fixture"[..], &mut Fails, 100).is_err());
    }
    #[test]
    fn changed_source_is_detected_after_manifest_is_committed() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout");
        fs::write(&path, b"before").unwrap();
        let store = BackupStore::new(temp.path().join("backups"));
        let (_, entries) = store
            .write_backup_with_files(
                "fixture",
                Path::new("fake.db"),
                json!({}),
                &[BackupFileSource {
                    path: path.clone(),
                    original_path: path.to_string_lossy().into(),
                }],
            )
            .unwrap();
        fs::write(&path, b"concurrent append").unwrap();
        assert!(store.source_file_unchanged(&entries[0]).is_err());
    }
    #[test]
    fn failed_manifest_does_not_leave_blob_data_or_delete_source() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("rollout");
        fs::write(&source, b"synthetic source").unwrap();
        let root = temp.path().join("backups");
        let mut store = BackupStore::new(&root);
        store.fail_before_manifest = true;
        assert!(
            store
                .write_backup_with_files(
                    "fixture",
                    Path::new("fake.db"),
                    json!({}),
                    &[BackupFileSource {
                        path: source.clone(),
                        original_path: source.to_string_lossy().into()
                    }]
                )
                .is_err()
        );
        assert_eq!(fs::read(&source).unwrap(), b"synthetic source");
        for entry in fs::read_dir(&root).unwrap() {
            let path = entry.unwrap().path();
            assert!(path.is_dir());
            assert_eq!(fs::read_dir(path).unwrap().count(), 0);
        }
    }

    #[test]
    fn sync_file_flushes_through_a_writable_handle_without_changing_content() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("manifest.json");
        fs::write(&path, b"{\"version\":2}").unwrap();
        sync_file(&path).unwrap();
        assert_eq!(
            fs::read(&path).unwrap(),
            b"{\"version\":2}",
            "刷盘不能截断或改写内容"
        );
        assert!(
            sync_file(&temp.path().join("missing.json")).is_err(),
            "不存在的文件不能被创建"
        );
        assert!(!temp.path().join("missing.json").exists());
    }

    #[test]
    fn old_backups_are_pruned_after_the_retention_limit() {
        // issue #2544：删除会话的备份从不清理，长期使用后目录可达 GB 级。
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("backups");
        let store = BackupStore::new(&root);
        fs::create_dir_all(&root).unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let old_epoch = now - BACKUP_RETENTION_SECS - 3600;
        let make = |epoch: u64, index: usize| {
            let token = format!("{epoch}-{index:032x}");
            fs::write(store.path_for(&token), b"{}").unwrap();
            fs::create_dir_all(root.join(format!("{token}.files"))).unwrap();
            fs::write(root.join(format!("{token}.files")).join("a.blob"), b"x").unwrap();
            token
        };
        let stale: Vec<_> = (0..12)
            .map(|index| make(old_epoch + index as u64, index))
            .collect();
        let foreign = root.join("env-conflicts-1700000000000.json");
        fs::write(&foreign, b"[]").unwrap();

        let source = temp.path().join("rollout.jsonl");
        fs::write(&source, b"synthetic rollout").unwrap();
        let (fresh, _) = store
            .write_backup_with_files(
                "fixture",
                Path::new("fake.db"),
                json!({}),
                &[BackupFileSource {
                    path: source.clone(),
                    original_path: source.to_string_lossy().into(),
                }],
            )
            .unwrap();

        assert!(store.path_for(&fresh).exists(), "刚写的备份必须保留");
        assert!(root.join(format!("{fresh}.files")).is_dir());
        // 保留最新 10 份（含刚写的），其余超期的连同 blob 目录删除。
        for token in &stale[..3] {
            assert!(!store.path_for(token).exists(), "{token} 应被回收");
            assert!(!root.join(format!("{token}.files")).exists());
        }
        for token in &stale[3..] {
            assert!(
                store.path_for(token).exists(),
                "{token} 在最新 10 份内，应保留"
            );
        }
        assert!(foreign.exists(), "其它功能的备份不能被当成会话备份回收");
    }

    #[test]
    fn recent_backups_from_one_batch_are_all_kept() {
        // 一次批量删除几十个会话：未超期的备份即使超过 10 份也全部保留。
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("backups");
        let store = BackupStore::new(&root);
        let tokens: Vec<_> = (0..15)
            .map(|_| {
                store
                    .write_backup("fixture", Path::new("fake.db"), json!({}))
                    .unwrap()
            })
            .collect();
        for token in &tokens {
            assert!(store.path_for(token).exists(), "{token} 被提前回收");
        }
    }

    #[test]
    fn backup_written_after_clock_rollback_is_never_pruned() {
        // 已有 10 份「未来时间」的备份（时钟回拨后），新写的备份仍必须保留。
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("backups");
        let store = BackupStore::new(&root);
        fs::create_dir_all(&root).unwrap();
        let future = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        for index in 0..10 {
            fs::write(
                store.path_for(&format!("{}-{index:032x}", future + index)),
                b"{}",
            )
            .unwrap();
        }
        let token = store
            .write_backup("fixture", Path::new("fake.db"), json!({}))
            .unwrap();
        assert!(store.read_backup(&token).is_ok());
    }
}

#[cfg(test)]
mod retention_tests {
    use super::BackupStore;
    use std::fs;

    #[test]
    fn recent_backups_survive_the_count_limit() {
        let dir = tempfile::tempdir().unwrap();
        for epoch in [100, 200, 300, 400] {
            fs::write(dir.path().join(format!("{epoch}-x.json")), "{}").unwrap();
        }
        let store = BackupStore::new(dir.path());
        // 只留 1 份，但 200 之后的都在保护期内。
        assert_eq!(store.prune_older_than(1, 200).unwrap(), 1);
        assert!(!dir.path().join("100-x.json").exists());
        assert!(dir.path().join("200-x.json").exists());
        assert_eq!(store.prune(1).unwrap(), 2);
        assert!(dir.path().join("400-x.json").exists());
    }

    #[test]
    fn automatic_retention_preserves_manifests_referencing_recovery_files() {
        let dir = tempfile::tempdir().unwrap();
        let store = BackupStore::new(dir.path());
        let token = format!("100-{:032x}", 1);
        let blob_dir = dir.path().join(format!("{token}.files"));
        fs::create_dir(&blob_dir).unwrap();
        fs::write(blob_dir.join("source.blob"), b"recovery data").unwrap();
        fs::write(
            store.path_for(&token),
            serde_json::to_vec(&serde_json::json!({
                "tables":{"__files":[{"blob_ref":format!("{token}.files/source.blob")}]}
            }))
            .unwrap(),
        )
        .unwrap();
        for number in 2..15 {
            fs::write(store.path_for(&format!("200-{number:032x}")), b"{}").unwrap();
        }
        store
            .write_backup(
                "new",
                std::path::Path::new("fixture.db"),
                serde_json::json!({}),
            )
            .unwrap();
        assert!(store.path_for(&token).is_file());
        assert_eq!(
            fs::read(blob_dir.join("source.blob")).unwrap(),
            b"recovery data"
        );
    }
}
