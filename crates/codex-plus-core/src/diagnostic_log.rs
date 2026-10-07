use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{Value, json};

static TEST_LOG_PATH: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

const MAX_DIAGNOSTIC_LOG_BYTES: u64 = 50 * 1024 * 1024;
const COMPACTED_DIAGNOSTIC_LOG_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
struct DiagnosticRecord {
    timestamp_ms: u64,
    pid: u32,
    event: String,
    detail: Value,
}

pub fn append_diagnostic_log(event: &str, detail: impl Serialize) -> std::io::Result<()> {
    let path = diagnostic_log_path();
    let detail = serde_json::to_value(detail).unwrap_or_else(|error| {
        json!({
            "serialization_error": error.to_string()
        })
    });
    let record = DiagnosticRecord {
        timestamp_ms: now_ms(),
        pid: std::process::id(),
        event: event.to_string(),
        detail,
    };
    let line = serde_json::to_string(&record).unwrap_or_else(|error| {
        json!({
            "timestamp_ms": now_ms(),
            "pid": std::process::id(),
            "event": "diagnostic_log.serialization_failed",
            "detail": {
                "message": error.to_string()
            }
        })
        .to_string()
    });

    append_log_line(&path, &line)
}

/// 追加日志的句柄缓存。
///
/// 代理路径每个请求要写 4 条以上诊断日志，而每条日志原先都要 stat（压缩检查）、
/// open、write、close 各一次。缓存句柄后每条只剩一次 write；压缩检查改成看自维护
/// 的字节数，超阈值才 stat。用的是不带缓冲的 `std::fs::File`，写完立刻可读——
/// 读日志的测试与诊断流程不需要额外的 flush。
struct CachedLogFile {
    file: std::fs::File,
    bytes: u64,
}

fn log_file_cache() -> &'static Mutex<HashMap<PathBuf, CachedLogFile>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedLogFile>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_log_file_cache() -> std::sync::MutexGuard<'static, HashMap<PathBuf, CachedLogFile>> {
    log_file_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn append_log_line(path: &Path, line: &str) -> std::io::Result<()> {
    let mut cache = lock_log_file_cache();
    if !cache.contains_key(path) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // 压缩只在换新句柄时判断一次：句柄在手上时文件只由本函数追加，字节数
        // 自己记着，不必每条日志都 stat。
        compact_diagnostic_log_if_needed(path)?;
        let bytes = std::fs::metadata(path).map(|part| part.len()).unwrap_or(0);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        cache.insert(path.to_path_buf(), CachedLogFile { file, bytes });
    }
    let needs_compaction = {
        let entry = cache.get_mut(path).expect("日志句柄在上面的分支里刚插入");
        writeln!(entry.file, "{line}")?;
        entry.bytes = entry.bytes.saturating_add(line.len() as u64 + 1);
        entry.bytes > MAX_DIAGNOSTIC_LOG_BYTES
    };
    if needs_compaction {
        // 压缩是 temp + rename，会替换掉被追加的文件：旧句柄作废，丢掉让下次重开。
        drop(cache);
        compact_diagnostic_log_if_needed(path)?;
        let _ = lock_log_file_cache().remove(path);
    }
    Ok(())
}

pub fn clear_diagnostic_log() -> std::io::Result<()> {
    let path = diagnostic_log_path();
    clear_diagnostic_log_path(&path)
}

fn clear_diagnostic_log_path(path: &Path) -> std::io::Result<()> {
    // 先丢掉缓存句柄：留着它会继续往已删除的文件里写，看起来像「清空没生效」。
    let _ = lock_log_file_cache().remove(path);
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

pub fn diagnostic_log_path() -> PathBuf {
    if let Some(lock) = TEST_LOG_PATH.get() {
        if let Ok(guard) = lock.lock() {
            if let Some(path) = &*guard {
                return path.clone();
            }
        }
    }
    crate::paths::default_diagnostic_log_path()
}

#[doc(hidden)]
pub fn set_diagnostic_log_path_for_tests(path: Option<PathBuf>) {
    let lock = TEST_LOG_PATH.get_or_init(|| Mutex::new(None));
    *lock.lock().expect("test log path lock poisoned") = path;
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn compact_diagnostic_log_if_needed(path: &Path) -> std::io::Result<()> {
    compact_diagnostic_log(
        path,
        MAX_DIAGNOSTIC_LOG_BYTES,
        COMPACTED_DIAGNOSTIC_LOG_BYTES,
    )
}

fn compact_diagnostic_log(
    path: &Path,
    max_bytes: u64,
    compacted_bytes: u64,
) -> std::io::Result<()> {
    let len = match std::fs::metadata(path) {
        Ok(metadata) => metadata.len(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if len <= max_bytes {
        return Ok(());
    }

    let keep = compacted_bytes.min(len);
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(len - keep))?;
    let mut tail = Vec::with_capacity(keep as usize);
    file.read_to_end(&mut tail)?;
    drop(file);
    if len > keep {
        if let Some(pos) = tail.iter().position(|byte| *byte == b'\n') {
            tail.drain(..=pos);
        }
    }

    crate::settings::atomic_write(path, &tail).map_err(std::io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_diagnostic_log_keeps_tail_and_drops_partial_first_line() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("codex-plus.log");
        std::fs::write(&path, "line-1\nline-2\nline-3\nline-4\n").unwrap();

        compact_diagnostic_log(&path, 12, 16).unwrap();

        let contents = std::fs::read_to_string(path).unwrap();
        assert_eq!(contents, "line-3\nline-4\n");
    }

    #[test]
    fn clear_diagnostic_log_ignores_missing_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("missing.log");

        clear_diagnostic_log_path(&path).unwrap();
    }

    #[test]
    fn appends_are_visible_to_readers_and_clear_reopens_the_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("codex-plus.log");

        // 缓存句柄后写入仍要立刻可读（读日志的测试与诊断流程都依赖这一点）。
        append_log_line(&path, "line-1").unwrap();
        append_log_line(&path, "line-2").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "line-1\nline-2\n");

        // 清空必须丢掉句柄，否则后续追加会写进已删除的旧文件。
        clear_diagnostic_log_path(&path).unwrap();
        append_log_line(&path, "line-3").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "line-3\n");
    }

    #[test]
    fn cached_handle_keeps_appending_after_the_file_is_truncated() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("codex-plus.log");
        append_log_line(&path, "line-1").unwrap();

        // 外部把文件截空（测试里清日志就是这么做的）：句柄是 append 模式，
        // 后续写入必须落在新文件末尾，而不是留在旧偏移上。
        std::fs::write(&path, "").unwrap();
        append_log_line(&path, "line-2").unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "line-2\n");
    }
}
