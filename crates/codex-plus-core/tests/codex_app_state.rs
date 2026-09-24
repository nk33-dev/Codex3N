use codex_plus_core::codex_app_state::{
    capture_app_state_snapshot, sync_app_state_after_provider_switch,
};
use serde_json::{Value, json};

#[test]
fn app_state_sync_restores_safe_state_and_ignores_sensitive_snapshot_keys() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let state_path = home.join(".codex-global-state.json");
    std::fs::write(
        &state_path,
        json!({
            "electron-saved-workspace-roots": ["C:/work/app", "C:\\work\\app\\"],
            "project-order": ["C:/work/app"],
            "active-workspace-roots": "C:/work/app",
            "electron-workspace-root-labels": {
                "C:/work/app/": "App"
            },
            "electron-avatar-overlay-bounds": {
                "x": 20,
                "y": 30,
                "width": 320,
                "height": 240
            },
            "electron-avatar-overlay-open": true,
            "electron-main-window-bounds": {
                "x": 10,
                "y": 10,
                "width": 1280,
                "height": 800
            },
            "thread-workspace-root-hints": {
                "thread-1": "C:/work/app",
                "local:thread-2": {
                    "workspaceRoot": "D:/work/other"
                }
            },
            "thread-projectless-output-directories": {
                "thread-1": "C:/work/app/out"
            },
            "thread-writable-roots": {
                "thread-1": ["C:/work/app"]
            },
            "projectless-thread-ids": ["thread-1", "thread-1"],
            "electron-persisted-atom-state": {
                "app-shell:right-panel-width:v2:/": 420,
                "avatar-overlay-mascot-width-px": 160,
                "composer-auto-context-enabled": false,
                "default-service-tier": "priority",
                "diff-filter": "all",
                "enter-behavior": "cmdAlways",
                "first-awake-pet-notification-avatar-ids": ["otter"],
                "has-seen-multi-agent-composer-banner": true,
                "electron:onboarding-workspace-autolaunch-applied": true,
                "sidebar-collapsed-sections-v1": ["cloud"],
                "sidebar-project-expanded-v1-codex:C:/work/app": true,
                "sidebar-width": 296,
                "thread-summary-panel-section-expanded-progress": false,
                "thread-client-id-v1:thread-1": "do-not-copy",
                "heartbeat-thread-permissions-by-id": {
                    "thread-1": "do-not-copy"
                },
                "prompt-history": ["secret"],
                "OPENAI_API_KEY": "do-not-copy",
                "provider-token-cache": "do-not-copy"
            },
            "prompt-history": ["secret"],
            "provider-token-cache": "secret"
        })
        .to_string(),
    )
    .unwrap();

    let snapshot_path = capture_app_state_snapshot(home)
        .unwrap()
        .expect("snapshot should be created");
    assert!(snapshot_path.is_file());

    std::fs::write(
        &state_path,
        json!({
            "electron-saved-workspace-roots": ["D:/fresh/app"],
            "active-workspace-roots": "D:/fresh/app",
            "thread-workspace-root-hints": {
                "thread-3": "D:/fresh/app"
            },
            "electron-persisted-atom-state": {
                "service-tier-default": "standard"
            }
        })
        .to_string(),
    )
    .unwrap();

    let result = sync_app_state_after_provider_switch(home).unwrap();
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(&state_path).unwrap()).unwrap();

    assert!(result.changed);
    assert!(result.backup_path.as_deref().unwrap().is_dir());
    assert!(result.snapshot_path.as_deref().unwrap().is_file());
    assert_eq!(
        state["electron-saved-workspace-roots"],
        json!(["D:\\fresh\\app", "C:\\work\\app"])
    );
    assert_eq!(
        state["active-workspace-roots"],
        json!(["D:\\fresh\\app", "C:\\work\\app"])
    );
    assert_eq!(
        state["electron-workspace-root-labels"],
        json!({"C:\\work\\app": "App"})
    );
    assert_eq!(state["electron-avatar-overlay-open"], true);
    assert_eq!(state["electron-avatar-overlay-bounds"]["width"], 320);
    assert_eq!(state["electron-main-window-bounds"]["height"], 800);
    assert_eq!(
        state["thread-workspace-root-hints"]["thread-1"],
        "C:/work/app"
    );
    assert_eq!(
        state["thread-workspace-root-hints"]["thread-3"],
        "D:/fresh/app"
    );
    assert_eq!(
        state["thread-projectless-output-directories"]["thread-1"],
        "C:/work/app/out"
    );
    assert_eq!(
        state["thread-writable-roots"]["thread-1"],
        json!(["C:/work/app"])
    );
    assert_eq!(state["projectless-thread-ids"], json!(["thread-1"]));
    assert_eq!(
        state["electron-persisted-atom-state"]["default-service-tier"],
        "priority"
    );
    assert_eq!(
        state["electron-persisted-atom-state"]["composer-auto-context-enabled"],
        false
    );
    assert_eq!(
        state["electron-persisted-atom-state"]["enter-behavior"],
        "cmdAlways"
    );
    assert_eq!(
        state["electron-persisted-atom-state"]["avatar-overlay-mascot-width-px"],
        160
    );
    assert_eq!(state["electron-persisted-atom-state"]["sidebar-width"], 296);
    assert_eq!(
        state["electron-persisted-atom-state"]["app-shell:right-panel-width:v2:/"],
        420
    );
    assert_eq!(
        state["electron-persisted-atom-state"]["sidebar-project-expanded-v1-codex:C:/work/app"],
        true
    );
    assert_eq!(
        state["electron-persisted-atom-state"]["has-seen-multi-agent-composer-banner"],
        true
    );
    assert_eq!(
        state["electron-persisted-atom-state"]["electron:onboarding-workspace-autolaunch-applied"],
        true
    );
    assert!(state.get("prompt-history").is_none());
    assert!(state.get("provider-token-cache").is_none());
    assert!(
        state["electron-persisted-atom-state"]
            .get("prompt-history")
            .is_none()
    );
    assert!(
        state["electron-persisted-atom-state"]
            .get("thread-client-id-v1:thread-1")
            .is_none()
    );
    assert!(
        state["electron-persisted-atom-state"]
            .get("heartbeat-thread-permissions-by-id")
            .is_none()
    );
    assert!(
        state["electron-persisted-atom-state"]
            .get("OPENAI_API_KEY")
            .is_none()
    );
    assert!(
        state["electron-persisted-atom-state"]
            .get("provider-token-cache")
            .is_none()
    );
}

#[test]
fn app_state_sync_normalizes_current_state_and_writes_backup_before_change() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let state_path = home.join(".codex-global-state.json");
    std::fs::write(
        &state_path,
        json!({
            "electron-saved-workspace-roots": ["C:/work/app", "C:\\work\\app\\"],
            "active-workspace-roots": "C:/work/app/",
            "projectless-thread-ids": ["thread-1", "thread-1"]
        })
        .to_string(),
    )
    .unwrap();

    let result = sync_app_state_after_provider_switch(home).unwrap();
    let backup_path = result
        .backup_path
        .expect("normalization should create backup");
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(&state_path).unwrap()).unwrap();
    let backup: Value = serde_json::from_str(
        &std::fs::read_to_string(backup_path.join(".codex-global-state.json")).unwrap(),
    )
    .unwrap();

    assert!(result.changed);
    assert_eq!(
        state["electron-saved-workspace-roots"],
        json!(["C:\\work\\app"])
    );
    assert_eq!(state["active-workspace-roots"], json!("C:\\work\\app"));
    assert_eq!(state["projectless-thread-ids"], json!(["thread-1"]));
    assert_eq!(
        backup["electron-saved-workspace-roots"],
        json!(["C:/work/app", "C:\\work\\app\\"])
    );
}

#[test]
fn modern_project_snapshot_restores_projects_without_importing_legacy_paths() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let state_path = home.join(".codex-global-state.json");
    std::fs::write(
        &state_path,
        json!({
            "electron-saved-workspace-roots": ["C:/old/work"],
            "project-order": ["C:/old/work"]
        })
        .to_string(),
    )
    .unwrap();
    let legacy_snapshot = capture_app_state_snapshot(home).unwrap().unwrap();

    let first_project = "11111111-1111-1111-1111-111111111111";
    let second_project = "22222222-2222-2222-2222-222222222222";
    let first_thread = "33333333-3333-3333-3333-333333333333";
    std::fs::write(
        &state_path,
        json!({
            "local-projects": {
                first_project: {"id": first_project, "name": "First", "rootPaths": ["C:/new/first"]},
                second_project: {"id": second_project, "name": "Second", "rootPaths": ["D:/new/second"]}
            },
            "project-order": [first_project, second_project],
            "thread-project-assignments": {
                first_thread: {"projectKind": "local", "projectId": second_project}
            },
            "thread-project-membership-host-ids": {first_thread: "local"},
            "app-server-project-id-by-legacy-project-id-by-host": {
                "local:C:/home": {first_project: "db-first", second_project: "db-second"}
            },
            "selected-project": {"type": "local", "projectId": second_project}
        })
        .to_string(),
    )
    .unwrap();
    let modern_snapshot = capture_app_state_snapshot(home).unwrap().unwrap();
    assert_ne!(modern_snapshot, legacy_snapshot);

    std::fs::write(
        &state_path,
        json!({
            "local-projects": {
                first_project: {"id": first_project, "name": "Renamed", "rootPaths": ["C:/new/first"]}
            },
            "project-order": [first_project],
            "app-server-project-id-by-legacy-project-id-by-host": {
                "local:C:/home": {first_project: "db-first-new"}
            },
            "app-server-projects-migration-by-host": {"local": {"version": 1}}
        })
        .to_string(),
    )
    .unwrap();

    let result = sync_app_state_after_provider_switch(home).unwrap();
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(&state_path).unwrap()).unwrap();
    assert!(result.changed);
    assert_eq!(state["local-projects"][first_project]["name"], "Renamed");
    assert_eq!(state["local-projects"][second_project]["name"], "Second");
    assert_eq!(
        state["project-order"],
        json!([first_project, second_project])
    );
    assert_eq!(
        state["thread-project-assignments"][first_thread]["projectId"],
        second_project
    );
    assert_eq!(state["selected-project"]["projectId"], second_project);
    assert_eq!(
        state["app-server-project-id-by-legacy-project-id-by-host"]["local:C:/home"][first_project],
        "db-first-new"
    );
    assert_eq!(
        state["app-server-project-id-by-legacy-project-id-by-host"]["local:C:/home"]
            [second_project],
        "db-second"
    );
    assert!(state.get("electron-saved-workspace-roots").is_none());
    assert_eq!(
        serde_json::from_str::<Value>(&std::fs::read_to_string(legacy_snapshot).unwrap()).unwrap()
            ["state"]["project-order"],
        json!(["C:\\old\\work"])
    );
}

#[test]
fn modern_capture_keeps_previous_projects_when_current_state_is_incomplete() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let state_path = home.join(".codex-global-state.json");
    std::fs::write(&state_path, json!({
        "local-projects": {"first": {"name": "First"}, "second": {"name": "Second"}},
        "project-order": ["first", "second"],
        "thread-project-assignments": {"thread": {"projectKind": "local", "projectId": "second"}},
        "app-server-project-id-by-legacy-project-id-by-host": {
            "local:C:/home": {"first": "db-first", "second": "db-second"}
        }
    }).to_string()).unwrap();
    let snapshot_path = capture_app_state_snapshot(home).unwrap().unwrap();

    std::fs::write(
        &state_path,
        json!({
            "local-projects": {"first": {"name": "Renamed"}},
            "project-order": ["first"],
            "app-server-project-id-by-legacy-project-id-by-host": {
                "local:C:/home": {"first": "db-first-new"}
            }
        })
        .to_string(),
    )
    .unwrap();
    capture_app_state_snapshot(home).unwrap();

    let snapshot: Value =
        serde_json::from_str(&std::fs::read_to_string(snapshot_path).unwrap()).unwrap();
    assert_eq!(
        snapshot["state"]["local-projects"]["second"]["name"],
        "Second"
    );
    assert_eq!(
        snapshot["state"]["local-projects"]["first"]["name"],
        "Renamed"
    );
    assert_eq!(
        snapshot["state"]["project-order"],
        json!(["first", "second"])
    );
    assert_eq!(
        snapshot["state"]["thread-project-assignments"]["thread"]["projectId"],
        "second"
    );
    assert_eq!(
        snapshot["state"]["app-server-project-id-by-legacy-project-id-by-host"]["local:C:/home"]["second"],
        "db-second"
    );
}

#[test]
fn modern_project_state_does_not_merge_legacy_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path();
    let state_path = home.join(".codex-global-state.json");
    std::fs::write(
        &state_path,
        json!({"project-order": ["C:/old/work"]}).to_string(),
    )
    .unwrap();
    capture_app_state_snapshot(home).unwrap();
    std::fs::write(
        &state_path,
        json!({
            "local-projects": {},
            "project-order": ["11111111-1111-1111-1111-111111111111"]
        })
        .to_string(),
    )
    .unwrap();

    let result = sync_app_state_after_provider_switch(home).unwrap();
    let state: Value =
        serde_json::from_str(&std::fs::read_to_string(&state_path).unwrap()).unwrap();
    assert!(!result.changed);
    assert_eq!(
        state["project-order"],
        json!(["11111111-1111-1111-1111-111111111111"])
    );
}
