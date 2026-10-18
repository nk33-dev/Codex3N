use super::*;
use serde_json::json;
use std::io::Write;

fn fixture() -> (tempfile::TempDir, ClaudeSessionStore, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("claude");
    let project = root.join("projects/test-project");
    fs::create_dir_all(&project).unwrap();
    let store = ClaudeSessionStore::new(
        vec![root.clone(), root],
        vec![directory.path().join("desktop/claude-code-sessions")],
        directory.path().join("backups"),
    );
    (directory, store, project)
}

fn write_session(project: &Path, id: &str, title: &str) -> PathBuf {
    let path = project.join(format!("{id}.jsonl"));
    fs::write(
        &path,
        format!(
            "{}\n",
            json!({
                "uuid":"message-one", "parentUuid": null, "type":"user", "sessionId":id,
                "cwd": project.to_string_lossy(), "timestamp":"2026-10-17T01:00:00Z",
                "message":{"role":"user","content":title}
            })
        ),
    )
    .unwrap();
    path
}

#[test]
fn search_covers_all_pages_and_duplicate_roots_are_deduplicated() {
    let (_directory, mut store, project) = fixture();
    for number in 0..55 {
        write_session(
            &project,
            &uuid::Uuid::new_v4().to_string(),
            &format!("session-{number}"),
        );
    }
    assert_eq!(store.list("", 0, 50).unwrap().total_count, 55);
    let second = store.list("", 50, 50).unwrap();
    assert_eq!(second.sessions.len(), 5);
    assert!(!second.has_more);
    let found = store.list("session-54", 0, 50).unwrap();
    assert_eq!(found.sessions.len(), 1);
    assert_eq!(found.total_count, 1);
    assert_eq!(store.roots.len(), 1);
}

#[test]
fn unreadable_record_keeps_healthy_sessions_and_reports_warning() {
    let (_directory, mut store, project) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let path = write_session(&project, &id, "hello");
    let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
    writeln!(file, "{{broken json").unwrap();
    let page = store.list("", 0, 50).unwrap();
    assert_eq!(page.total_count, 1);
    assert!(!page.sessions[0].warnings.is_empty());
    let detail = store.messages(&page.sessions[0].key, 0, 50).unwrap();
    assert_eq!(detail.messages.len(), 1);
    assert!(!detail.warnings.is_empty());
}

#[test]
fn follows_latest_branch_and_merges_streamed_assistant_blocks() {
    let (_directory, mut store, project) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let path = project.join(format!("{id}.jsonl"));
    let records = [
        json!({"uuid":"root","type":"user","message":{"content":"start"}}),
        json!({"uuid":"old","parentUuid":"root","type":"assistant","message":{"id":"old-api","content":[{"type":"text","text":"discarded branch"}]}}),
        json!({"uuid":"current","parentUuid":"root","type":"assistant","message":{"id":"api","content":[{"type":"text","text":"current branch"}]}}),
        json!({"uuid":"tool","parentUuid":"current","type":"assistant","message":{"id":"api","content":[{"type":"tool_use","name":"Read","input":{"file_path":"file.txt"}}]}}),
        json!({"uuid":"side","parentUuid":"root","isSidechain":true,"type":"assistant","message":{"content":"subagent"}}),
    ];
    fs::write(
        path,
        records
            .into_iter()
            .map(|value| value.to_string() + "\n")
            .collect::<String>(),
    )
    .unwrap();
    let key = store.list("", 0, 50).unwrap().sessions[0].key.clone();
    let page = store.messages(&key, 0, 1).unwrap();
    assert_eq!(page.total_count, 2);
    assert!(page.has_more);
    let page = store.messages(&key, 1, 50).unwrap();
    assert_eq!(page.messages[0].blocks.len(), 2);
    assert_eq!(page.messages[0].blocks[0].text, "current branch");
    assert_eq!(page.messages[0].blocks[1].kind, "tool_use");
}

#[test]
fn duplicate_ids_in_different_projects_remain_distinct_and_protected() {
    let (_directory, mut store, project) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    write_session(&project, &id, "one");
    let other = project.with_file_name("another-project");
    fs::create_dir_all(&other).unwrap();
    write_session(&other, &id, "two");
    let page = store.list("", 0, 50).unwrap();
    assert_eq!(page.total_count, 2);
    assert_ne!(page.sessions[0].key, page.sessions[1].key);
    assert!(
        page.sessions
            .iter()
            .all(|session| session.protected_reason.is_some())
    );
}

#[test]
fn desktop_metadata_is_optional_and_nested_subagents_are_not_listed() {
    let (_directory, mut store, project) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    write_session(&project, &id, "cli title");
    let child_dir = project.join(&id).join("subagents");
    fs::create_dir_all(&child_dir).unwrap();
    fs::write(child_dir.join("agent-one.jsonl"), "{}\n").unwrap();
    assert_eq!(store.list("", 0, 50).unwrap().total_count, 1);
    let desktop = store.desktop_roots[0].join("account/org");
    fs::create_dir_all(&desktop).unwrap();
    fs::write(
        desktop.join("local_desktop.json"),
        json!({
            "cliSessionId":id, "cwd":project.to_string_lossy(), "title":"desktop title"
        })
        .to_string(),
    )
    .unwrap();
    let page = store.list("", 0, 50).unwrap();
    assert!(page.sessions[0].desktop);
    assert_eq!(page.sessions[0].title, "desktop title");
}

#[test]
fn summary_reads_tail_metadata_without_loading_large_transcript() {
    let (_directory, mut store, project) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let path = write_session(&project, &id, "first prompt");
    let mut file = fs::OpenOptions::new().append(true).open(path).unwrap();
    for _ in 0..4000 {
        writeln!(
            file,
            "{}",
            json!({"type":"progress","data":"x".repeat(1000)})
        )
        .unwrap();
    }
    writeln!(
        file,
        "{}",
        json!({"type":"custom-title","customTitle":"saved title"})
    )
    .unwrap();
    let page = store.list("", 0, 50).unwrap();
    assert_eq!(page.sessions[0].title, "saved title");
    assert!(page.sessions[0].file_size > 4_000_000);
}

#[test]
fn process_matching_covers_native_and_script_cli_without_blocking_other_node_apps() {
    assert!(safety::claude_executable("claude.exe"));
    assert!(safety::claude_executable("claude-desktop.exe"));
    assert!(safety::claude_script(
        r#"node.exe "C:\npm\node_modules\@anthropic-ai\claude-code\cli.js""#
    ));
    assert!(!safety::claude_script("node.exe vite --host 127.0.0.1"));
    assert!(!safety::claude_executable("codex-plus-manager.exe"));
}

#[test]
fn rejects_parent_traversal() {
    let (_directory, store, project) = fixture();
    assert!(safety::check_path(&store.roots[0], &project.join("../secret")).is_err());
}

#[test]
fn top_level_legacy_subagent_without_cwd_is_not_a_main_session() {
    let (_directory, mut store, project) = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    fs::write(
        project.join(format!("{id}.jsonl")),
        json!({
            "type":"assistant", "isSidechain":true, "sessionId":id,
            "message":{"content":"child result"}
        })
        .to_string(),
    )
    .unwrap();
    assert!(store.list("", 0, 50).unwrap().sessions.is_empty());
}

#[cfg(unix)]
#[test]
fn rejects_symlink_escape() {
    let (directory, mut store, project) = fixture();
    let outside = directory.path().join("outside");
    fs::write(&outside, "private").unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    std::os::unix::fs::symlink(&outside, project.join(format!("{id}.jsonl"))).unwrap();
    let page = store.list("", 0, 50).unwrap();
    assert!(page.sessions.is_empty());
    assert!(!page.warnings.is_empty());
    assert_eq!(fs::read_to_string(outside).unwrap(), "private");
}

#[test]
#[ignore = "显式运行时只读检查当前机器的 Claude 会话"]
fn inspect_local_claude_sessions() {
    let mut store = ClaudeSessionStore::default();
    let page = store.list("", 0, 50).unwrap();
    println!(
        "sessions={}, page={}, warnings={}",
        page.total_count,
        page.sessions.len(),
        page.warnings.len()
    );
    for session in page.sessions.iter().take(3) {
        let detail = store.messages(&session.key, 0, 50).unwrap();
        println!(
            "messages={}, warnings={}",
            detail.total_count,
            detail.warnings.len()
        );
    }
    println!(
        "process_guard={}",
        safety::ensure_claude_stopped()
            .map_or_else(|error| error.to_string(), |_| "stopped".into())
    );
}
