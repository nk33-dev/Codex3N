use super::shared::{CommandResult, failed, ok};
use codex_plus_data::claude_sessions::ClaudeSessionStore;
use serde_json::{Value, json};
use std::sync::{Mutex, OnceLock};

async fn execute(
    task: impl FnOnce(&mut ClaudeSessionStore) -> anyhow::Result<Value> + Send + 'static,
) -> CommandResult<Value> {
    tauri::async_runtime::spawn_blocking(move || {
        static STORE: OnceLock<Mutex<ClaudeSessionStore>> = OnceLock::new();
        let result = (|| {
            let mut store = STORE
                .get_or_init(|| Mutex::new(ClaudeSessionStore::default()))
                .lock()
                .map_err(|_| anyhow::anyhow!("会话管理状态异常，请重启管理器"))?;
            task(&mut store)
        })();
        match result {
            Ok(value) => ok("操作完成", value),
            Err(error) => failed(&format!("{error:#}"), json!({})),
        }
    })
    .await
    .unwrap_or_else(|error| failed(&format!("会话操作失败：{error}"), json!({})))
}

#[tauri::command]
pub async fn list_claude_sessions(
    query: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
) -> CommandResult<Value> {
    execute(move |store| {
        Ok(serde_json::to_value(store.list(
            query.as_deref().unwrap_or(""),
            offset.unwrap_or(0),
            limit.unwrap_or(50),
        )?)?)
    })
    .await
}

#[tauri::command]
pub async fn read_claude_session(
    key: String,
    offset: Option<usize>,
    limit: Option<usize>,
) -> CommandResult<Value> {
    execute(move |store| {
        Ok(serde_json::to_value(store.messages(
            &key,
            offset.unwrap_or(0),
            limit.unwrap_or(50),
        )?)?)
    })
    .await
}

#[tauri::command]
pub async fn preview_claude_session_deletion(
    keys: Vec<String>,
    project_path: Option<String>,
) -> CommandResult<Value> {
    execute(move |store| {
        Ok(serde_json::to_value(
            store.preview_delete(&keys, project_path.as_deref())?,
        )?)
    })
    .await
}

#[tauri::command]
pub async fn delete_claude_sessions(token: String) -> CommandResult<Value> {
    let mut result = execute(move |store| Ok(serde_json::to_value(store.delete(&token)?)?)).await;
    if result.status == "ok"
        && (result.payload["stopped"].as_bool() == Some(true)
            || result.payload["outcomes"]
                .as_array()
                .is_some_and(|outcomes| outcomes.iter().any(|outcome| outcome["status"] != "ok")))
    {
        result.status = "partial".into();
        result.message = "部分会话未删除，请查看结果和备份".into();
    }
    result
}

#[tauri::command]
pub async fn list_claude_session_backups() -> CommandResult<Value> {
    execute(move |store| Ok(serde_json::to_value(store.backups()?)?)).await
}

#[tauri::command]
pub async fn restore_claude_session(token: String) -> CommandResult<Value> {
    execute(move |store| {
        store.restore(&token)?;
        Ok(json!({}))
    })
    .await
}
