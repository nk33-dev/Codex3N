//! 收藏和主动反馈共用实例内的 SQLite；事务避免管理器与注入页覆盖彼此的更新。
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::Round;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Project {
    pub host_id: String,
    pub working_directory: String,
}

impl Project {
    fn normalize(&mut self) -> anyhow::Result<()> {
        ensure!(
            !self.host_id.is_empty() && self.host_id.len() <= 256,
            "项目主机无效"
        );
        let directory = self.working_directory.trim().replace('\\', "/");
        ensure!(
            directory.len() <= 4096 && !directory.contains('\0'),
            "项目目录无效"
        );
        let windows = directory.as_bytes().get(1) == Some(&b':');
        ensure!(
            directory.starts_with('/') || (windows && directory.as_bytes().get(2) == Some(&b'/')),
            "需要完整项目目录"
        );
        self.working_directory = if windows {
            directory.to_lowercase()
        } else {
            directory
        };
        while self.working_directory.len() > 1
            && self.working_directory.ends_with('/')
            && !self.working_directory.ends_with(":/")
        {
            self.working_directory.pop();
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Favorite {
    pub id: String,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub project: Option<Project>,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_used_at: i64,
}

impl Favorite {
    fn normalize(&mut self) -> anyhow::Result<()> {
        self.title = self.title.trim().to_string();
        ensure!(
            !self.title.is_empty() && self.title.chars().count() <= 200,
            "请填写标题，最多 200 字"
        );
        ensure!(
            !self.body.trim().is_empty() && self.body.chars().count() <= 20_000,
            "正文需要 1–20000 字"
        );
        ensure!(
            self.id.len() <= 80 && self.tags.len() <= 20,
            "收藏格式不正确"
        );
        let mut tags = Vec::new();
        for tag in &self.tags {
            let tag = tag.trim();
            ensure!(tag.chars().count() <= 64, "标签最多 64 字");
            if !tag.is_empty() && !tags.iter().any(|existing: &String| existing == tag) {
                tags.push(tag.to_string());
            }
        }
        self.tags = tags;
        if let Some(project) = &mut self.project {
            project.normalize()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationMetadata {
    pub mode: String,
    pub scenario: String,
    pub model: String,
    pub system_prompt: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Feedback {
    pub id: String,
    pub original: String,
    pub generated: String,
    pub edited: String,
    pub history: Vec<Round>,
    pub metadata: GenerationMetadata,
    pub rating: String,
    pub note: String,
    pub created_at: i64,
}

impl Feedback {
    fn validate(&self) -> anyhow::Result<()> {
        ensure!(
            self.id.len() <= 80 && ["useful", "improve"].contains(&self.rating.as_str()),
            "请选择反馈评价"
        );
        ensure!(
            !self.original.trim().is_empty() && self.original.chars().count() <= 20_000,
            "原稿无效"
        );
        ensure!(
            !self.generated.trim().is_empty() && !self.edited.trim().is_empty(),
            "结果为空"
        );
        ensure!(
            self.generated.len() <= 400_000
                && self.edited.len() <= 400_000
                && self.note.chars().count() <= 3000,
            "反馈内容过长"
        );
        ensure!(
            ["rewrite", "grill"].contains(&self.metadata.mode.as_str())
                && super::scenario_rule(&self.metadata.scenario).is_some(),
            "生成信息无效"
        );
        ensure!(
            self.metadata.model.len() <= 512 && self.metadata.system_prompt.len() <= 400_000,
            "规则过长"
        );
        super::grill::validate(&self.history).map_err(anyhow::Error::msg)?;
        ensure!(
            serde_json::to_vec(&self.history)?.len() <= 120_000,
            "追问记录过长"
        );
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Import {
    version: u32,
    favorites: Vec<Favorite>,
}

pub fn default_path() -> PathBuf {
    crate::paths::default_settings_path().with_file_name("prompt-enhance.sqlite3")
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn open(path: &Path) -> anyhow::Result<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    ensure!(
        conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))? <= 1,
        "数据库版本过新"
    );
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS favorites (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        PRAGMA user_version=1;",
    )?;
    Ok(conn)
}

fn favorites(conn: &Connection) -> anyhow::Result<Vec<Favorite>> {
    let mut stmt = conn.prepare("SELECT data FROM favorites")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
}

fn id(payload: &Value) -> anyhow::Result<&str> {
    let id = payload
        .get("id")
        .and_then(Value::as_str)
        .context("缺少记录 ID")?;
    ensure!(!id.is_empty() && id.len() <= 80, "记录 ID 无效");
    Ok(id)
}

/// 只接收结构化内容，不接收前端提供的数据库路径。
pub fn execute(path: &Path, action: &str, payload: Value) -> Value {
    match execute_inner(path, action, payload) {
        Ok(value) => value,
        // SQLite、JSON 错误可能带正文；响应和日志均不转发原始错误。
        Err(_) => json!({"status":"failed","message":"收藏或反馈操作失败，请检查内容格式后重试"}),
    }
}

fn execute_inner(path: &Path, action: &str, payload: Value) -> anyhow::Result<Value> {
    ensure!(
        serde_json::to_vec(&payload)?.len() <= 8 * 1024 * 1024,
        "内容超过 8 MiB"
    );
    let mut conn = open(path)?;
    match action {
        "library/list" => {
            let mut project: Option<Project> =
                serde_json::from_value(payload.get("project").cloned().unwrap_or(Value::Null))?;
            if let Some(project) = &mut project {
                project.normalize()?;
            }
            let all = payload.get("all").and_then(Value::as_bool) == Some(true);
            let scope = payload
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or("available");
            let query = payload
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let mut items = favorites(&conn)?;
            items.retain(|item| {
                let visible = match scope {
                    "global" => item.project.is_none(),
                    "project" => item.project.is_some() && (all || item.project == project),
                    _ => {
                        all || item.project.is_none()
                            || (project.is_some() && item.project == project)
                    }
                };
                visible
                    && (query.is_empty()
                        || format!("{}\n{}\n{}", item.title, item.body, item.tags.join(" "))
                            .to_lowercase()
                            .contains(&query))
            });
            let recent = payload.get("sort").and_then(Value::as_str) != Some("updated");
            items.sort_by_key(|item| {
                std::cmp::Reverse((
                    item.pinned,
                    if recent {
                        item.last_used_at
                    } else {
                        item.updated_at
                    },
                    item.updated_at,
                    item.id.clone(),
                ))
            });
            Ok(json!({"status":"ok","favorites":items}))
        }
        "library/save" => {
            let mut item: Favorite = serde_json::from_value(payload)?;
            item.normalize()?;
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let previous: Option<String> = tx
                .query_row("SELECT data FROM favorites WHERE id=?1", [&item.id], |r| {
                    r.get(0)
                })
                .optional()?;
            let time = now();
            if item.id.is_empty() {
                item.id = uuid::Uuid::new_v4().to_string();
            }
            if let Some(previous) = previous {
                let old: Favorite = serde_json::from_str(&previous)?;
                item.created_at = old.created_at;
                item.last_used_at = old.last_used_at;
            } else {
                item.created_at = time;
                item.last_used_at = 0;
            }
            item.updated_at = time;
            tx.execute(
                "INSERT OR REPLACE INTO favorites VALUES (?1,?2)",
                params![item.id, serde_json::to_string(&item)?],
            )?;
            tx.commit()?;
            Ok(json!({"status":"ok","favorite":item}))
        }
        "library/delete" | "feedback/delete" => {
            let sql = if action == "library/delete" {
                "DELETE FROM favorites WHERE id=?1"
            } else {
                "DELETE FROM feedback WHERE id=?1"
            };
            conn.execute(sql, [id(&payload)?])?;
            Ok(json!({"status":"ok"}))
        }
        "library/use" => {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let raw: String = tx.query_row(
                "SELECT data FROM favorites WHERE id=?1",
                [id(&payload)?],
                |r| r.get(0),
            )?;
            let mut item: Favorite = serde_json::from_str(&raw)?;
            item.last_used_at = now();
            tx.execute(
                "UPDATE favorites SET data=?2 WHERE id=?1",
                params![item.id, serde_json::to_string(&item)?],
            )?;
            tx.commit()?;
            Ok(json!({"status":"ok"}))
        }
        "library/export" => {
            Ok(json!({"status":"ok","document":{"version":1,"favorites":favorites(&conn)?}}))
        }
        "library/import-preview" | "library/import" => {
            let mut document: Import = serde_json::from_value(payload)?;
            ensure!(
                document.version == 1 && document.favorites.len() <= 5000,
                "收藏文件版本或数量无效"
            );
            for item in &mut document.favorites {
                item.normalize()?;
                ensure!(!item.id.is_empty(), "收藏缺少 ID");
            }
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let mut inserted = 0;
            let mut skipped = 0;
            for item in document.favorites {
                if tx.execute(
                    "INSERT OR IGNORE INTO favorites VALUES (?1,?2)",
                    params![item.id, serde_json::to_string(&item)?],
                )? == 1
                {
                    inserted += 1;
                } else {
                    skipped += 1;
                }
            }
            if action == "library/import" {
                tx.commit()?;
            } else {
                tx.rollback()?;
            }
            Ok(json!({"status":"ok","inserted":inserted,"skipped":skipped}))
        }
        "feedback/save" => {
            let mut item: Feedback = serde_json::from_value(payload)?;
            item.validate()?;
            item.id = uuid::Uuid::new_v4().to_string();
            item.created_at = now();
            conn.execute(
                "INSERT INTO feedback VALUES (?1,?2)",
                params![item.id, serde_json::to_string(&item)?],
            )?;
            Ok(json!({"status":"ok","id":item.id}))
        }
        "feedback/list" | "feedback/export" => {
            let mut stmt = conn.prepare("SELECT data FROM feedback ORDER BY rowid DESC")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            let mut items: Vec<Feedback> = rows
                .map(|row| Ok(serde_json::from_str(&row?)?))
                .collect::<anyhow::Result<_>>()?;
            let rating = payload.get("rating").and_then(Value::as_str).unwrap_or("");
            let query = payload
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            items.retain(|item| {
                (rating.is_empty() || item.rating == rating)
                    && (query.is_empty()
                        || format!("{}\n{}\n{}", item.original, item.edited, item.note)
                            .to_lowercase()
                            .contains(&query))
            });
            if action == "feedback/export" {
                Ok(json!({"status":"ok","document":{"version":1,"feedback":items}}))
            } else {
                Ok(json!({"status":"ok","feedback":items}))
            }
        }
        _ => bail!("未知操作"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn save(path: &Path, title: &str, project: Value) -> Value {
        execute(
            path,
            "library/save",
            json!({"title":title,"body":"正文与 @文件","tags":["rust"],"project":project}),
        )["favorite"]
            .clone()
    }

    #[test]
    fn favorites_scope_search_update_use_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.db");
        let global = save(&path, "通用", Value::Null);
        let project = json!({"hostId":"local","workingDirectory":"/workspace/One/"});
        let mut local = save(&path, "项目", project.clone());
        save(
            &path,
            "另一个",
            json!({"hostId":"local","workingDirectory":"/workspace/Two"}),
        );
        assert_eq!(
            execute(&path, "library/list", json!({}))["favorites"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            execute(
                &path,
                "library/list",
                json!({"project":project,"query":"RUST"})
            )["favorites"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            execute(&path, "library/use", json!({"id":local["id"]}))["status"],
            "ok"
        );
        local["pinned"] = json!(true);
        local["title"] = json!("修改标题");
        let updated = execute(&path, "library/save", local.clone())["favorite"].clone();
        assert!(updated["lastUsedAt"].as_i64().unwrap() > 0);
        assert_eq!(updated["createdAt"], local["createdAt"]);
        assert_eq!(
            execute(&path, "library/list", json!({"all":true}))["favorites"][0]["id"],
            local["id"]
        );
        execute(&path, "library/delete", json!({"id":global["id"]}));
        assert!(
            execute(&path, "library/list", json!({}))["favorites"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn import_preview_duplicates_and_invalid_document_do_not_change_records() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.db");
        let item = save(&path, "原有", Value::Null);
        let mut new = item.clone();
        new["id"] = json!("new");
        let document = json!({"version":1,"favorites":[item,new]});
        assert_eq!(
            execute(&path, "library/import-preview", document.clone())["inserted"],
            1
        );
        assert_eq!(
            execute(&path, "library/list", json!({"all":true}))["favorites"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut invalid = document.clone();
        invalid["favorites"][1]["body"] = json!("");
        assert_eq!(
            execute(&path, "library/import", invalid)["status"],
            "failed"
        );
        let imported = execute(&path, "library/import", document);
        assert_eq!(imported["inserted"], 1);
        assert_eq!(imported["skipped"], 1);
        assert_eq!(
            execute(&path, "library/export", json!({}))["document"]["favorites"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn concurrent_writers_keep_all_favorites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.db");
        execute(&path, "library/list", json!({}));
        let handles: Vec<_> = (0..8)
            .map(|n| {
                let path = path.clone();
                std::thread::spawn(move || save(&path, &format!("收藏{n}"), Value::Null))
            })
            .collect();
        for handle in handles {
            assert!(handle.join().unwrap()["id"].is_string());
        }
        assert_eq!(
            execute(&path, "library/list", json!({}))["favorites"]
                .as_array()
                .unwrap()
                .len(),
            8
        );
    }

    #[test]
    fn feedback_requires_explicit_save_and_does_not_accept_context_or_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.db");
        assert!(
            execute(&path, "feedback/list", json!({}))["feedback"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let data = json!({"original":"需求","generated":"生成","edited":"改后","rating":"improve","note":"太长","metadata":{"mode":"rewrite","scenario":"general","model":"test","systemPrompt":"规则"}});
        let mut invalid = data.clone();
        invalid["apiKey"] = json!("private-value");
        let error = execute(&path, "feedback/save", invalid);
        assert_eq!(error["status"], "failed");
        assert!(!error.to_string().contains("private-value"));
        execute(&path, "feedback/save", data);
        assert_eq!(
            execute(&path, "feedback/list", json!({"rating":"improve"}))["feedback"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(
            execute(&path, "feedback/list", json!({"rating":"useful"}))["feedback"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let export = execute(&path, "feedback/export", json!({}));
        let id = export["document"]["feedback"][0]["id"].clone();
        execute(&path, "feedback/delete", json!({"id":id}));
        assert!(
            execute(&path, "feedback/list", json!({}))["feedback"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
