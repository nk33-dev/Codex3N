use super::*;
use serde_json::json;

struct Fixture {
    _temp: tempfile::TempDir,
    store: ClaudeSessionStore,
    project: PathBuf,
    id: String,
    path: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("claude");
        let project = root.join("projects/project");
        fs::create_dir_all(&project).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let path = project.join(format!("{id}.jsonl"));
        fs::write(
            &path,
            format!(
                "{}\n",
                json!({
                    "uuid":"one","type":"user","sessionId":id,"cwd":project.to_string_lossy(),
                    "message":{"content":"hello"}
                })
            ),
        )
        .unwrap();
        let store = ClaudeSessionStore::new(
            vec![root],
            vec![temp.path().join("desktop")],
            temp.path().join("backups"),
        );
        Self {
            _temp: temp,
            store,
            project,
            id,
            path,
        }
    }
    fn preview(&mut self) -> DeletePreview {
        let key = self.store.list("", 0, 50).unwrap().sessions[0].key.clone();
        self.store.preview_delete(&[key], None).unwrap()
    }
}

#[test]
fn delete_and_restore_preserve_shared_state_and_session_files() {
    let mut f = Fixture::new();
    let root = f.store.roots[0].clone();
    let history = root.join("history.jsonl");
    fs::write(
        &history,
        format!(
            "{}\n{}\n",
            json!({"sessionId":f.id,"display":"hello"}),
            json!({"sessionId":"other","display":"keep"})
        ),
    )
    .unwrap();
    let index = f.project.join("sessions-index.json");
    fs::write(&index, json!({"version":1,"extra":true,"entries":[{"sessionId":f.id,"summary":"hello"},{"sessionId":"other"}]}).to_string()).unwrap();
    let subagent = f.path.with_extension("").join("subagents/agent-one.jsonl");
    fs::create_dir_all(subagent.parent().unwrap()).unwrap();
    fs::write(&subagent, "subagent").unwrap();
    let memory = f.project.join("memory");
    fs::create_dir(&memory).unwrap();
    fs::write(memory.join("MEMORY.md"), "keep").unwrap();
    let desktop = f.store.desktop_roots[0].join("account/org");
    fs::create_dir_all(&desktop).unwrap();
    let metadata = desktop.join("local_test.json");
    fs::write(
        &metadata,
        json!({"cliSessionId":f.id,"cwd":f.project.to_string_lossy(),"title":"desktop"})
            .to_string(),
    )
    .unwrap();
    let preview = f.preview();
    let report = f
        .store
        .delete_with_guard(&preview.token, || Ok(()))
        .unwrap();
    assert_eq!(report.outcomes[0].status, "ok");
    assert!(!f.path.exists());
    assert!(!subagent.exists());
    assert!(!metadata.exists());
    assert!(memory.join("MEMORY.md").exists());
    assert!(!fs::read_to_string(&history).unwrap().contains(&f.id));
    fs::OpenOptions::new()
        .append(true)
        .open(&history)
        .unwrap()
        .write_all(b"{\"sessionId\":\"new\"}\n")
        .unwrap();
    let token = report.outcomes[0].backup_token.as_ref().unwrap();
    f.store.restore_with_guard(token, || Ok(())).unwrap();
    assert!(f.path.exists());
    assert_eq!(fs::read_to_string(&subagent).unwrap(), "subagent");
    assert!(metadata.exists());
    let rows = history_rows(&fs::read(history).unwrap()).unwrap();
    assert_eq!(rows.len(), 3);
    let value: Value = serde_json::from_slice(&fs::read(index).unwrap()).unwrap();
    assert_eq!(value["entries"].as_array().unwrap().len(), 2);
    assert_eq!(value["extra"], true);
    f.store.restore_with_guard(token, || Ok(())).unwrap();
    assert!(f.store.backups().unwrap().backups[0].restored);
}

#[test]
fn changed_preview_and_running_process_never_delete() {
    let mut f = Fixture::new();
    let preview = f.preview();
    assert!(
        f.store
            .delete_with_guard(&preview.token, || anyhow::bail!("running"))
            .is_err()
    );
    assert!(f.path.exists());
    fs::OpenOptions::new()
        .append(true)
        .open(&f.path)
        .unwrap()
        .write_all(b"{\"type\":\"summary\",\"summary\":\"changed\"}\n")
        .unwrap();
    let report = f
        .store
        .delete_with_guard(&preview.token, || Ok(()))
        .unwrap();
    assert_eq!(report.outcomes[0].status, "failed");
    assert!(f.path.exists());
    assert!(f.store.backups().unwrap().backups.is_empty());
}

#[test]
fn backup_failure_keeps_transcript() {
    let mut f = Fixture::new();
    fs::write(&f.store.backup_root, "not a directory").unwrap();
    let preview = f.preview();
    let report = f
        .store
        .delete_with_guard(&preview.token, || Ok(()))
        .unwrap();
    assert_eq!(report.outcomes[0].status, "failed");
    assert!(f.path.exists());
}

#[test]
fn restore_conflict_is_detected_before_any_write() {
    let mut f = Fixture::new();
    let preview = f.preview();
    let report = f
        .store
        .delete_with_guard(&preview.token, || Ok(()))
        .unwrap();
    fs::write(&f.path, "new conversation").unwrap();
    let token = report.outcomes[0].backup_token.as_ref().unwrap();
    assert!(f.store.restore_with_guard(token, || Ok(())).is_err());
    assert_eq!(fs::read_to_string(&f.path).unwrap(), "new conversation");
}

#[test]
fn restart_mid_delete_stops_and_keeps_backup_recoverable() {
    let mut f = Fixture::new();
    let preview = f.preview();
    let mut checks = 0;
    let report = f
        .store
        .delete_with_guard(&preview.token, || {
            checks += 1;
            ensure!(checks < 4, "Claude restarted");
            Ok(())
        })
        .unwrap();
    assert!(report.stopped);
    assert!(report.outcomes[0].backup_token.is_some());
    assert!(f.path.exists());
}

#[test]
fn project_preview_covers_every_page_and_batch_shared_index_changes_are_allowed() {
    let mut f = Fixture::new();
    let root = f.store.roots[0].clone();
    let mut history = String::new();
    history.push_str(&format!("{}\n", json!({"sessionId":f.id})));
    for number in 0..51 {
        let id = uuid::Uuid::new_v4().to_string();
        fs::write(f.project.join(format!("{id}.jsonl")), format!("{}\n", json!({
            "type":"user","sessionId":id,"cwd":f.project.to_string_lossy(),"message":{"content":number.to_string()}
        }))).unwrap();
        history.push_str(&format!("{}\n", json!({"sessionId":id})));
    }
    fs::write(root.join("history.jsonl"), history).unwrap();
    let preview = f
        .store
        .preview_delete(&[], Some(f.project.to_str().unwrap()))
        .unwrap();
    assert_eq!(preview.sessions.len(), 52);
    let report = f
        .store
        .delete_with_guard(&preview.token, || Ok(()))
        .unwrap();
    assert_eq!(report.outcomes.len(), 52);
    assert!(report.outcomes.iter().all(|outcome| outcome.status == "ok"));
    assert_eq!(f.store.backups().unwrap().backups.len(), 52);
}

#[test]
fn unknown_desktop_record_and_invalid_index_are_protected() {
    let mut f = Fixture::new();
    let desktop = f.store.desktop_roots[0].clone();
    fs::create_dir_all(&desktop).unwrap();
    fs::write(
        desktop.join("local_unknown.json"),
        json!({"cwd":f.project.to_string_lossy()}).to_string(),
    )
    .unwrap();
    let key = f.store.list("", 0, 50).unwrap().sessions[0].key.clone();
    assert!(f.store.preview_delete(&[key.clone()], None).is_err());
    fs::remove_file(desktop.join("local_unknown.json")).unwrap();
    fs::write(f.project.join("sessions-index.json"), "broken").unwrap();
    assert!(f.store.preview_delete(&[key], None).is_err());
    assert!(f.path.exists());
}

#[test]
fn forged_backup_path_cannot_escape_session_scope() {
    let mut f = Fixture::new();
    let preview = f.preview();
    let report = f
        .store
        .delete_with_guard(&preview.token, || Ok(()))
        .unwrap();
    let token = report.outcomes[0].backup_token.as_ref().unwrap();
    let mut manifest = f.store.read_manifest(token).unwrap();
    manifest.assets[0].path = f.store.roots[0].join("settings.json");
    f.store.save_manifest(&manifest).unwrap();
    assert!(f.store.restore_with_guard(token, || Ok(())).is_err());
    assert!(!f.store.roots[0].join("settings.json").exists());
}

#[cfg(windows)]
#[test]
fn filesystem_failure_keeps_partial_backup_and_restores_shared_rows() {
    use std::os::windows::fs::OpenOptionsExt;

    let mut f = Fixture::new();
    let history = f.store.roots[0].join("history.jsonl");
    fs::write(&history, format!("{}\n", json!({"sessionId":f.id}))).unwrap();
    let preview = f.preview();
    let mut checks = 0;
    let mut locked_file = None;
    let report = f
        .store
        .delete_with_guard(&preview.token, || {
            checks += 1;
            if checks == 4 {
                locked_file = Some(
                    fs::OpenOptions::new()
                        .read(true)
                        .share_mode(0)
                        .open(&f.path)?,
                );
            }
            Ok(())
        })
        .unwrap();
    drop(locked_file);
    assert_eq!(report.outcomes[0].status, "partial");
    assert!(f.path.exists());
    assert!(fs::read_to_string(&history).unwrap().is_empty());
    let token = report.outcomes[0].backup_token.as_ref().unwrap();
    f.store.restore_with_guard(token, || Ok(())).unwrap();
    assert!(fs::read_to_string(history).unwrap().contains(&f.id));
}
