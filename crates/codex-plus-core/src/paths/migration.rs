use anyhow::Context;
use fs2::FileExt;
use std::fs::{self, OpenOptions};
use std::path::Path;

/// 在日志、数据库和 GUI 启动前迁移；显式实例目录始终保持原有隔离。
pub fn initialize_user_state() -> anyhow::Result<()> {
    if super::state_dir_override().is_some() {
        return crate::settings::SettingsStore::default().migrate();
    }
    let target = super::default_app_state_dir();
    anyhow::ensure!(target.is_absolute(), "无法定位用户配置目录");
    let legacy = super::legacy_app_state_dir();
    import_state(&legacy, &target)?;
    crate::settings::SettingsStore::default().migrate()?;
    Ok(())
}

fn import_state(legacy: &Path, target: &Path) -> anyhow::Result<()> {
    let parent = target.parent().context("用户配置目录无效")?;
    fs::create_dir_all(parent)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(target.with_extension("migration.lock"))?;
    lock.lock_exclusive()?;
    let marker = target.join(".state-imported");
    if marker.try_exists()? {
        return Ok(());
    }
    if target.join("settings.json").try_exists()? {
        crate::settings::atomic_write(&marker, b"1")?;
        return Ok(());
    }
    let staging = parent.join(format!(".Codex3N-import-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staging, fs::Permissions::from_mode(0o700))?;
    }
    let result = (|| -> anyhow::Result<()> {
        if legacy.try_exists()? {
            let source_lock = OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(legacy.join("settings.json.lock"))?;
            source_lock.lock_exclusive()?;
            let settings = legacy.join("settings.json");
            if settings.try_exists()? {
                let bytes = fs::read(&settings)?;
                let value: serde_json::Value =
                    serde_json::from_slice(&bytes).context("旧配置损坏，导入已停止")?;
                anyhow::ensure!(value.is_object(), "旧配置必须是 JSON 对象");
                backup_once(&settings, &bytes)?;
            }
            copy_state(legacy, &staging)?;
            for name in ["settings.json", "skills.json"] {
                let path = staging.join(name);
                if path.is_file() {
                    let mut value: serde_json::Value = serde_json::from_slice(&fs::read(&path)?)?;
                    if relocate_paths(&mut value, legacy, target) {
                        crate::settings::atomic_write(&path, &serde_json::to_vec_pretty(&value)?)?;
                    }
                }
            }
        }
        crate::settings::atomic_write(
            &staging.join("migration.log"),
            b"state-directory: imported to platform user configuration directory\n",
        )?;
        crate::settings::atomic_write(&staging.join(".state-imported"), b"1")?;
        // 日志等后台读写可能提前建目录；先归档这份目录，不能因此跳过旧配置导入。
        let prior = target.with_extension(format!("before-import-{}", uuid::Uuid::new_v4()));
        let had_target = target.try_exists()?;
        if had_target {
            fs::rename(target, &prior)?;
        }
        if let Err(error) = fs::rename(&staging, target) {
            if had_target {
                fs::rename(&prior, target).context("恢复导入前目录失败")?;
            }
            return Err(error).context("发布用户配置目录失败");
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn relocate_paths(value: &mut serde_json::Value, old: &Path, new: &Path) -> bool {
    match value {
        serde_json::Value::String(text) => {
            if let Ok(relative) = Path::new(text).strip_prefix(old) {
                *text = new.join(relative).to_string_lossy().into_owned();
                true
            } else {
                false
            }
        }
        serde_json::Value::Object(map) => map.values_mut().fold(false, |changed, value| {
            relocate_paths(value, old, new) || changed
        }),
        serde_json::Value::Array(items) => items.iter_mut().fold(false, |changed, value| {
            relocate_paths(value, old, new) || changed
        }),
        _ => false,
    }
}

pub(crate) fn backup_once(path: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let backup = path.with_file_name(format!(
        "{}.bak",
        path.file_name()
            .context("配置文件名无效")?
            .to_string_lossy()
    ));
    match OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&backup)
    {
        Ok(mut file) => {
            file.set_permissions(fs::metadata(path)?.permissions())?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error).context("配置备份失败"),
    }
    Ok(())
}

fn copy_state(source: &Path, target: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();
        // 运行锁和 SQLite 边车不属于快照；数据库通过在线备份读取已提交事务。
        if name_text.ends_with(".lock")
            || name_text.ends_with("-wal")
            || name_text.ends_with("-shm")
            || name_text == "latest-status.json"
        {
            continue;
        }
        let path = entry.path();
        let destination = target.join(&name);
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            let link = fs::read_link(&path)?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(link, destination)?;
            #[cfg(windows)]
            if path.is_dir() {
                std::os::windows::fs::symlink_dir(link, destination)?;
            } else {
                std::os::windows::fs::symlink_file(link, destination)?;
            }
        } else if kind.is_dir() {
            copy_state(&path, &destination)?;
        } else if kind.is_file() {
            use std::io::Read;
            let mut header = [0; 16];
            let count = fs::File::open(&path)?.read(&mut header)?;
            if count == 16 && &header == b"SQLite format 3\0" {
                let source_db = rusqlite::Connection::open_with_flags(
                    &path,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                )?;
                let mut target_db = rusqlite::Connection::open(&destination)?;
                let backup = rusqlite::backup::Backup::new(&source_db, &mut target_db)?;
                backup.run_to_completion(128, std::time::Duration::from_millis(10), None)?;
            } else {
                fs::copy(&path, &destination)
                    .with_context(|| format!("迁移 {} 失败", name_text))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_settings_secrets_plugins_and_live_sqlite_once() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("old");
        let new = temp.path().join("new");
        fs::create_dir_all(old.join("plugins")).unwrap();
        let bytes =
            br#"{"codexAppLowPower":true,"codexAppSessionDelete":false,"future":{"enabled":true}}"#;
        fs::write(old.join("settings.json"), bytes).unwrap();
        fs::write(old.join("secret.key"), b"synthetic-key").unwrap();
        fs::write(old.join("plugins/custom.js"), b"synthetic-plugin").unwrap();
        fs::create_dir(&new).unwrap();
        fs::write(new.join("early.log"), b"synthetic-startup-log").unwrap();
        let db = rusqlite::Connection::open(old.join("prompt-enhance.sqlite3")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE saved(value TEXT); INSERT INTO saved VALUES('kept');").unwrap();
        import_state(&old, &new).unwrap();
        assert_eq!(fs::read(old.join("settings.json.bak")).unwrap(), bytes);
        assert_eq!(fs::read(new.join("settings.json")).unwrap(), bytes);
        assert_eq!(fs::read(new.join("secret.key")).unwrap(), b"synthetic-key");
        assert!(new.join("plugins/custom.js").is_file());
        let copied = rusqlite::Connection::open(new.join("prompt-enhance.sqlite3")).unwrap();
        assert_eq!(
            copied
                .query_row("SELECT value FROM saved", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "kept"
        );
        fs::remove_file(new.join("settings.json")).unwrap();
        import_state(&old, &new).unwrap();
        assert!(!new.join("settings.json").exists());
        assert!(new.join("migration.log").is_file());
    }

    #[test]
    fn invalid_legacy_data_does_not_publish_defaults() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("old");
        let new = temp.path().join("new");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("settings.json"), b"broken").unwrap();
        assert!(import_state(&old, &new).is_err());
        assert!(!new.exists());
        assert_eq!(fs::read(old.join("settings.json")).unwrap(), b"broken");
    }
}
