#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SessionRef {
    pub session_id: String,
    pub title: String,
}

impl SessionRef {
    pub fn new(
        session_id: impl Into<String>,
        title: impl Into<String>,
    ) -> anyhow::Result<SessionRef> {
        let session_id = session_id.into();
        if session_id.is_empty() {
            anyhow::bail!("session_id cannot be empty");
        }

        Ok(SessionRef {
            session_id,
            title: title.into(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeleteStatus {
    ServerDeleted,
    LocalDeleted,
    Partial,
    Failed,
    Undone,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DeleteResult {
    pub status: DeleteStatus,
    pub session_id: String,
    pub message: String,
    pub undo_token: Option<String>,
    pub backup_path: Option<String>,
}

pub fn local_delete_process_guard(
    session_id: &str,
    blocking_process_ids: &[u32],
) -> Option<DeleteResult> {
    if blocking_process_ids.is_empty() {
        return None;
    }
    Some(DeleteResult {
        status: DeleteStatus::Failed,
        session_id: session_id.to_string(),
        message: format!(
            "Codex App、ChatGPT 或 VS Code Codex 仍在运行，无法安全执行本地回退删除；请完全退出后在管理工具重试。阻塞进程：{}",
            blocking_process_ids
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(", ")
        ),
        undo_token: None,
        backup_path: None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportStatus {
    Exported,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ExportResult {
    pub status: ExportStatus,
    pub session_id: String,
    pub message: String,
    pub filename: Option<String>,
    pub markdown: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_ref_new_rejects_empty_session_id() {
        let err = SessionRef::new("", "Untitled").unwrap_err();

        assert!(err.to_string().contains("session_id"));
    }

    #[test]
    fn session_ref_new_preserves_fields() {
        let session = SessionRef::new("session-123", "My Session").unwrap();

        assert_eq!(
            session,
            SessionRef {
                session_id: "session-123".to_string(),
                title: "My Session".to_string(),
            }
        );
    }

    #[test]
    fn delete_status_uses_snake_case_json_values() {
        assert_eq!(
            serde_json::to_value(DeleteStatus::ServerDeleted).unwrap(),
            json!("server_deleted")
        );
        assert_eq!(
            serde_json::from_value::<DeleteStatus>(json!("server_deleted")).unwrap(),
            DeleteStatus::ServerDeleted
        );
    }

    #[test]
    fn local_delete_process_guard_reports_blocking_processes() {
        assert!(local_delete_process_guard("t1", &[]).is_none());
        let result = local_delete_process_guard("t1", &[12, 34]).unwrap();
        assert_eq!(result.status, DeleteStatus::Failed);
        assert_eq!(result.session_id, "t1");
        assert!(result.message.contains("12, 34"));
        assert!(result.message.contains("完全退出"));
    }

    #[test]
    fn export_status_uses_snake_case_json_values() {
        assert_eq!(
            serde_json::to_value(ExportStatus::Exported).unwrap(),
            json!("exported")
        );
        assert_eq!(
            serde_json::from_value::<ExportStatus>(json!("exported")).unwrap(),
            ExportStatus::Exported
        );
    }

    #[test]
    fn delete_result_json_shape_matches_rust_model() {
        let result = DeleteResult {
            status: DeleteStatus::Partial,
            session_id: "session-123".to_string(),
            message: "deleted locally only".to_string(),
            undo_token: Some("undo-123".to_string()),
            backup_path: None,
        };

        let value = serde_json::to_value(&result).unwrap();

        assert_eq!(
            value,
            json!({
                "status": "partial",
                "session_id": "session-123",
                "message": "deleted locally only",
                "undo_token": "undo-123",
                "backup_path": null
            })
        );
        assert_eq!(
            serde_json::from_value::<DeleteResult>(value).unwrap(),
            result
        );
    }

    #[test]
    fn export_result_json_shape_matches_rust_model() {
        let result = ExportResult {
            status: ExportStatus::Exported,
            session_id: "session-123".to_string(),
            message: "exported markdown".to_string(),
            filename: Some("session-123.md".to_string()),
            markdown: Some("# Session\n\nBody".to_string()),
        };

        let value = serde_json::to_value(&result).unwrap();

        assert_eq!(
            value,
            json!({
                "status": "exported",
                "session_id": "session-123",
                "message": "exported markdown",
                "filename": "session-123.md",
                "markdown": "# Session\n\nBody"
            })
        );
        assert_eq!(
            serde_json::from_value::<ExportResult>(value).unwrap(),
            result
        );
    }

    #[test]
    fn failed_export_result_accepts_null_filename_and_markdown() {
        let value = json!({
            "status": "failed",
            "session_id": "s1",
            "message": "err",
            "filename": null,
            "markdown": null
        });

        let result = serde_json::from_value::<ExportResult>(value.clone()).unwrap();

        assert_eq!(serde_json::to_value(result).unwrap(), value);
    }
}
