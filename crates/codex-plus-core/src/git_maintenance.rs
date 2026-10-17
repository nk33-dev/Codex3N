use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmptyGitDirectory {
    pub workspace: PathBuf,
    pub fingerprint: String,
}

fn plain_directory(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return false;
        }
    }
    true
}

pub fn recorded_workspaces(home: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let path = home.join(".codex-global-state.json");
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error).context("读取官方工作区记录失败"),
    };
    let state: Value = serde_json::from_str(&text).context("官方工作区记录格式无效")?;
    let mut roots = BTreeSet::new();
    let mut add = |value: &Value| {
        let paths: Vec<&str> = if let Some(items) = value.as_array() {
            items.iter().filter_map(Value::as_str).collect()
        } else {
            value.as_str().into_iter().collect()
        };
        for text in paths {
            let path = PathBuf::from(text);
            if path.is_absolute() && plain_directory(&path) {
                roots.insert(path);
            }
        }
    };
    for key in ["electron-saved-workspace-roots", "active-workspace-roots"] {
        add(&state[key]);
    }
    if let Some(labels) = state["electron-workspace-root-labels"].as_object() {
        for path in labels.keys() {
            add(&Value::String(path.clone()));
        }
    }
    if let Some(projects) = state["local-projects"].as_object() {
        for project in projects.values() {
            add(&project["rootPaths"]);
        }
    }
    Ok(roots.into_iter().collect())
}

fn fingerprint(workspace: &Path) -> anyhow::Result<Option<String>> {
    let git = workspace.join(".git");
    if !plain_directory(workspace) || !plain_directory(&git) {
        return Ok(None);
    }
    // HEAD 即使是坏链接也不归本工具处理；只处理确实不存在的目录项。
    match fs::symlink_metadata(git.join("HEAD")) {
        Ok(_) => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let metadata = fs::symlink_metadata(&git)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&git)? {
        let entry = entry?;
        let item = fs::symlink_metadata(entry.path())?;
        entries.push(format!(
            "{:?}:{:?}:{:?}:{}",
            entry.file_name(),
            item.created().ok(),
            item.modified().ok(),
            item.len()
        ));
    }
    entries.sort();
    let mut hash = Sha256::new();
    hash.update(format!(
        "{:?}:{:?}:{:?}:{:?}",
        git.canonicalize()?,
        metadata.created().ok(),
        metadata.modified().ok(),
        entries
    ));
    Ok(Some(format!("{:x}", hash.finalize())))
}

pub fn scan(home: &Path) -> anyhow::Result<Vec<EmptyGitDirectory>> {
    let mut result = Vec::new();
    for workspace in recorded_workspaces(home)? {
        if let Some(fingerprint) = fingerprint(&workspace)? {
            result.push(EmptyGitDirectory {
                workspace,
                fingerprint,
            });
        }
    }
    Ok(result)
}

pub fn quarantine(home: &Path, candidate: &EmptyGitDirectory) -> anyhow::Result<PathBuf> {
    if !recorded_workspaces(home)?.contains(&candidate.workspace)
        || fingerprint(&candidate.workspace)?.as_deref() != Some(&candidate.fingerprint)
    {
        bail!("目录或工作区记录已变化，请重新扫描");
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis();
    let destination = candidate
        .workspace
        .join(format!(".git.codex3n-empty-{timestamp}"));
    if destination.try_exists()? {
        bail!("备份目录已存在，请稍后重试");
    }
    if fingerprint(&candidate.workspace)?.as_deref() != Some(&candidate.fingerprint) {
        bail!("目录已变化，请重新扫描");
    }
    fs::rename(candidate.workspace.join(".git"), &destination).context("重命名 .git 失败")?;
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scans_only_recorded_roots_and_preserves_git_files_and_head() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        for root in ["empty", "valid", "worktree", "unrecorded", "modern"] {
            fs::create_dir(home.join(root)).unwrap();
        }
        for root in ["empty", "valid", "unrecorded", "modern"] {
            fs::create_dir(home.join(root).join(".git")).unwrap();
        }
        fs::write(home.join("valid/.git/HEAD"), "ref: refs/heads/main").unwrap();
        fs::write(
            home.join("worktree/.git"),
            "gitdir: ../valid/.git/worktrees/test",
        )
        .unwrap();
        fs::write(home.join(".codex-global-state.json"), json!({
            "electron-saved-workspace-roots": [home.join("empty"),home.join("valid"),home.join("worktree")],
            "local-projects": {"id": {"rootPaths": [home.join("modern")]}}
        }).to_string()).unwrap();
        let candidates = scan(home).unwrap();
        assert_eq!(candidates.len(), 2);
        let candidate = candidates
            .iter()
            .find(|c| c.workspace.ends_with("empty"))
            .unwrap();
        let backup = quarantine(home, candidate).unwrap();
        assert!(backup.is_dir());
        assert!(!candidate.workspace.join(".git").exists());
        assert!(home.join("unrecorded/.git").is_dir());
    }

    #[cfg(windows)]
    #[test]
    fn skips_junctions_and_rejects_removed_workspace_records() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let real = home.join("real");
        let linked = home.join("linked");
        fs::create_dir_all(real.join(".git")).unwrap();
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&linked)
            .arg(&real)
            .output()
            .unwrap();
        assert!(output.status.success());
        let record = home.join(".codex-global-state.json");
        fs::write(
            &record,
            json!({"electron-saved-workspace-roots":[real,linked]}).to_string(),
        )
        .unwrap();
        let candidates = scan(home).unwrap();
        assert_eq!(candidates.len(), 1);
        fs::write(&record, "{}").unwrap();
        assert!(quarantine(home, &candidates[0]).is_err());
        std::fs::remove_dir(linked).unwrap();
        assert!(real.join(".git").exists());
    }

    #[test]
    fn refuses_changes_since_scan_and_unrecorded_paths() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        fs::create_dir(home.join(".git")).unwrap();
        fs::write(
            home.join(".codex-global-state.json"),
            json!({"active-workspace-roots":[home]}).to_string(),
        )
        .unwrap();
        let candidate = scan(home).unwrap().remove(0);
        fs::write(home.join(".git/config"), "changed").unwrap();
        assert!(quarantine(home, &candidate).is_err());
        let candidate = scan(home).unwrap().remove(0);
        fs::write(home.join(".git/HEAD"), "ref: refs/heads/main").unwrap();
        assert!(quarantine(home, &candidate).is_err());
        assert!(home.join(".git/HEAD").exists());
    }
}
