use super::shared::{CommandResult, failed, ok};
use codex_plus_data::BackupStore;
use serde_json::{Value, json};

async fn execute(
    task: impl FnOnce(BackupStore) -> anyhow::Result<Value> + Send + 'static,
) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = BackupStore::new(super::session_backup_root());
        match task(store) {
            Ok(value) => ok("操作完成", value),
            Err(error) => failed(&format!("{error:#}"), json!({})),
        }
    })
    .await
    .unwrap_or_else(|error| failed(&format!("备份操作失败：{error}"), json!({})))
}

#[tauri::command]
pub async fn list_local_session_backups() -> CommandResult<Value> {
    execute(|store| Ok(serde_json::to_value(store.list_session_backups()?)?)).await
}

#[tauri::command]
pub async fn cleanup_local_session_backups() -> CommandResult<Value> {
    execute(|store| Ok(json!({"removed": store.cleanup_expired_backups()?}))).await
}

#[tauri::command]
pub async fn delete_local_session_backup(token: String) -> CommandResult<Value> {
    execute(move |store| {
        store.delete_session_backup(&token)?;
        Ok(json!({}))
    })
    .await
}

#[tauri::command]
pub async fn restore_local_session_backup(token: String) -> CommandResult<Value> {
    execute(move |store| {
        let home = codex_plus_core::codex_sqlite::default_codex_home_dir();
        store.validate_session_backup(&token)?;
        anyhow::ensure!(
            codex_plus_core::watcher::find_session_index_cleanup_blocking_processes().is_empty(),
            "请先完全退出 Codex、ChatGPT 和 VS Code Codex 后恢复会话"
        );
        let paths = codex_plus_core::codex_sqlite::codex_session_db_paths_from_home(&home);
        let first = paths
            .first()
            .ok_or_else(|| anyhow::anyhow!("未找到本机会话数据库"))?;
        let adapter = codex_plus_data::SQLiteStorageAdapter::new(first.clone(), store)
            .with_allowed_db_paths(paths.clone())
            .with_codex_home(&home);
        let result = adapter.undo(&token);
        anyhow::ensure!(
            matches!(result.status, codex_plus_core::models::DeleteStatus::Undone),
            "{}",
            result.message
        );
        Ok(json!({}))
    })
    .await
}
