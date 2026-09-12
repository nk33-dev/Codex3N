use anyhow::Context;
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct BackupStore {
    root: PathBuf,
}

/// 会话删除快照的保留份数。
///
/// 撤销入口是 Codex 界面里 10 秒后自动消失的一次性 toast，更早的快照没有任何
/// 消费者；而每份快照都把 rollout 全文 base64 内联进 JSON，不设上限时
/// `backups/` 会随删除次数无上限增长。50 份远超任何一次删除操作会用到的数量
/// （一次删除最多写入 3 份，多份快照对应同一次撤销）。
const SESSION_DELETE_BACKUP_KEEP_COUNT: usize = 50;

impl BackupStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn write_backup(
        &self,
        session_id: &str,
        source_db: &Path,
        tables: serde_json::Value,
    ) -> anyhow::Result<String> {
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let token = format!("{epoch}-{}", Uuid::new_v4().simple());
        fs::create_dir_all(&self.root).with_context(|| {
            format!(
                "failed to create backup directory {}",
                self.root.to_string_lossy()
            )
        })?;
        let payload = json!({
            "token": token,
            "session_id": session_id,
            "source_db": source_db.to_string_lossy(),
            "tables": tables,
        });
        fs::write(
            self.path_for(&token),
            serde_json::to_string_pretty(&payload)?,
        )?;
        // 快照已经落盘，清理失败不能反过来让删除操作报错；但也不能静默，
        // 否则磁盘只增不减这件事又没人看得见。
        if let Err(error) = self.prune(SESSION_DELETE_BACKUP_KEEP_COUNT) {
            let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                "session_delete_backup_prune_failed",
                json!({
                    "root": self.root.to_string_lossy(),
                    "error": error.to_string(),
                }),
            );
        }
        Ok(token)
    }

    /// 只保留最近 `keep` 份快照，返回删除的份数。
    ///
    /// 文件名是 `<epoch>-<uuid>.json`，epoch 定长（10 位），按文件名倒序即按
    /// 时间倒序，不需要读文件内容。
    pub fn prune(&self, keep: usize) -> anyhow::Result<usize> {
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
            fs::remove_file(self.root.join(&name)).with_context(|| {
                format!("failed to prune backup {}", self.root.join(&name).display())
            })?;
            removed += 1;
        }
        Ok(removed)
    }

    pub fn read_backup(&self, token: &str) -> anyhow::Result<serde_json::Value> {
        let path = self.path_for(token);
        let text = fs::read_to_string(&path)
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
}
