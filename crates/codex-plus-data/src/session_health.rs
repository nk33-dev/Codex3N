use anyhow::{Context, bail};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHealthScan {
    pub scanned: usize,
    pub missing_ids: Vec<String>,
}

/// 只寻找缺少本地恢复来源的候选；调用方还须用本机 thread/read 确认失效。
pub fn scan_session_health(
    home: &Path,
    backup_dir: &Path,
    observed_ids: &[String],
) -> anyhow::Result<SessionHealthScan> {
    let mut known = BTreeSet::new();
    let mut protected = BTreeSet::new();
    for id in observed_ids {
        insert_id(&mut known, id);
    }
    let mut databases = BTreeSet::new();
    let paths = codex_plus_core::codex_sqlite::codex_thread_reference_db_paths_from_home(home);
    let mut roots = BTreeSet::from([home.to_path_buf(), home.join("sqlite")]);
    for path in paths {
        if let Some(parent) = path.parent() {
            roots.insert(parent.to_path_buf());
        }
        databases.insert(path);
    }
    // 常规数据库发现会忽略无法打开的文件；检查失效会话时必须让读取错误阻止隐藏。
    for root in roots {
        for path in directory_files(&root)? {
            if is_database(&path) {
                databases.insert(path);
            }
        }
    }
    for path in databases {
        if path.try_exists()? {
            inspect_database(&path, home, &mut known, &mut protected)?;
        }
    }
    let index = home.join("session_index.jsonl");
    if index.try_exists()? {
        for line in BufReader::new(File::open(index)?).lines() {
            let line = line?;
            if let Ok(value) = serde_json::from_str::<Value>(&line)
                && let Some(id) = value.get("id").and_then(Value::as_str)
            {
                insert_id(&mut known, id);
            }
        }
    }
    for root in [
        home.join("sessions"),
        home.join("archived_sessions"),
        home.join("backups_state"),
        backup_dir.to_path_buf(),
    ] {
        protect_files(&root, home, &mut protected)?;
    }
    Ok(SessionHealthScan {
        scanned: known.len(),
        missing_ids: known.difference(&protected).cloned().collect(),
    })
}

fn insert_id(ids: &mut BTreeSet<String>, value: &str) {
    if let Ok(id) =
        uuid::Uuid::parse_str(value.trim().strip_prefix("local:").unwrap_or(value.trim()))
    {
        ids.insert(id.to_string());
    }
}

fn directory_files(root: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(error).with_context(|| format!("无法检查目录 {}", root.display()));
        }
    };
    entries.map(|entry| Ok(entry?.path())).collect()
}

fn is_database(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|value| value.to_str()),
        Some("db" | "sqlite" | "sqlite3")
    )
}

fn columns(db: &Connection, table: &str) -> anyhow::Result<BTreeSet<String>> {
    Ok(db
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |row| row.get(1))?
        .collect::<Result<_, _>>()?)
}

fn inspect_database(
    path: &Path,
    home: &Path,
    known: &mut BTreeSet<String>,
    protected: &mut BTreeSet<String>,
) -> anyhow::Result<()> {
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("无法检查数据库 {}", path.display()))?;
    let catalog_local_host = crate::provider_sync::local_catalog_host_id(&db)?;
    for (table, id_column, path_column) in [
        ("threads", "id", "rollout_path"),
        ("local_thread_catalog", "thread_id", "source_detail"),
        ("sessions", "id", "rollout_path"),
    ] {
        let cols = columns(&db, table)?;
        if !cols.contains(id_column) {
            continue;
        }
        let path_expr = if cols.contains(path_column) {
            path_column
        } else {
            "NULL"
        };
        let archived_expr = if cols.contains("archived") {
            "archived"
        } else {
            "0"
        };
        let host_expr = if cols.contains("host_id") {
            "host_id"
        } else {
            "'local'"
        };
        let query =
            format!("SELECT {id_column}, {path_expr}, {archived_expr}, {host_expr} FROM {table}");
        let mut stmt = db.prepare(&query)?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        for row in rows {
            let (id, rollout, archived, host) = row?;
            insert_id(known, &id);
            let local_host = if table == "local_thread_catalog" {
                catalog_local_host.as_deref()
            } else {
                Some("local")
            };
            if table == "sessions"
                || archived.unwrap_or_default() != 0
                || host.as_deref().is_some_and(|host| Some(host) != local_host)
            {
                insert_id(protected, &id);
                continue;
            }
            if let Some(rollout) = rollout.filter(|path| !path.trim().is_empty()) {
                let rollout = Path::new(&rollout);
                let rollout = if rollout.is_absolute() {
                    rollout.to_path_buf()
                } else {
                    home.join(rollout)
                };
                if !rollout.starts_with(home) {
                    insert_id(protected, &id);
                    continue;
                }
                // 文件损坏、权限错误或临时挂载异常不能等同于不可恢复。
                match fs::metadata(&rollout) {
                    Ok(_) => insert_id(protected, &id),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(error)
                            .with_context(|| format!("无法检查会话文件 {}", rollout.display()));
                    }
                }
            }
        }
    }
    Ok(())
}

fn protect_files(root: &Path, home: &Path, protected: &mut BTreeSet<String>) -> anyhow::Result<()> {
    for path in directory_files(root)? {
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            bail!("恢复目录包含链接，无法完整检查：{}", path.display());
        }
        if metadata.is_dir() {
            protect_files(&path, home, protected)?;
        } else if path.extension().is_some_and(|ext| ext == "jsonl") {
            if let Some(stem) = path.file_stem().and_then(|value| value.to_str())
                && let Some(suffix) = stem.get(stem.len().saturating_sub(36)..)
            {
                insert_id(protected, suffix);
            }
            // 元数据通常是第一行；兼容重命名后的 rollout，不按标题猜测归属。
            let mut line = String::new();
            BufReader::new(File::open(&path)?).read_line(&mut line)?;
            if let Ok(value) = serde_json::from_str::<Value>(&line)
                && value["type"] == "session_meta"
                && let Some(id) = value["payload"]["id"].as_str()
            {
                insert_id(protected, id);
            }
        } else if path.extension().is_some_and(|ext| ext == "json") {
            let value: Value = serde_json::from_reader(File::open(&path)?)
                .with_context(|| format!("无法检查恢复备份 {}", path.display()))?;
            // 只有索引或数据库行的备份无法找回对话内容；保留含文件或消息正文的撤销备份。
            let has_files = value["tables"]["__files"].as_array().is_some_and(|files| {
                files.iter().any(|file| {
                    file["content_b64"]
                        .as_str()
                        .is_some_and(|content| !content.is_empty())
                })
            });
            let has_messages = value["tables"]["messages"]
                .as_array()
                .is_some_and(|rows| !rows.is_empty());
            if (has_files || has_messages)
                && let Some(id) = value["session_id"].as_str()
            {
                insert_id(protected, id);
            }
        } else if is_database(&path) {
            let mut backup_ids = BTreeSet::new();
            inspect_database(&path, home, &mut backup_ids, protected)?;
        }
    }
    Ok(())
}
