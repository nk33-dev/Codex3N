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
    /// 旧数据里的置顶；迁移后界面不再使用。
    pub pinned: bool,
    /// 手动顺序，越小越靠前；新条目排在最前。
    pub order: i64,
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
    let mut conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS favorites (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, data TEXT NOT NULL);",
    )?;
    let version = conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))?;
    ensure!(version <= 2, "数据库版本过新");
    // v2：一次性把置顶优先、最近使用在前的旧顺序写成显式 order，之后完全按用户手动顺序。
    if version < 2 {
        migrate_orders(&mut conn)?;
        conn.pragma_update(None, "user_version", 2)?;
    }
    Ok(conn)
}

/// 旧版本没有 order；迁移只做一次，之后置顶字段只用于读旧数据。
fn migrate_orders(conn: &mut Connection) -> anyhow::Result<()> {
    let mut items = favorites(conn)?;
    items.sort_by_key(|item| {
        (
            std::cmp::Reverse(item.pinned),
            std::cmp::Reverse(item.last_used_at),
            std::cmp::Reverse(item.updated_at),
            item.id.clone(),
        )
    });
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    for (index, mut item) in items.into_iter().enumerate() {
        item.order = index as i64;
        tx.execute(
            "UPDATE favorites SET data=?2 WHERE id=?1",
            params![item.id, serde_json::to_string(&item)?],
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn manual(items: &[Favorite]) -> Vec<Favorite> {
    let mut ordered = items.to_vec();
    ordered.sort_by_key(|item| (item.order, item.updated_at, item.id.clone()));
    ordered
}

fn write_all(conn: &Connection, items: &[Favorite]) -> anyhow::Result<()> {
    for item in items {
        conn.execute(
            "UPDATE favorites SET data=?2 WHERE id=?1",
            params![item.id, serde_json::to_string(item)?],
        )?;
    }
    Ok(())
}

fn first_order(conn: &Connection) -> anyhow::Result<i64> {
    Ok(favorites(conn)?
        .iter()
        .map(|item| item.order)
        .min()
        .unwrap_or(0)
        - 1)
}

fn favorites(conn: &Connection) -> anyhow::Result<Vec<Favorite>> {
    let mut stmt = conn.prepare("SELECT data FROM favorites")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
}

fn favorites_for_list(
    conn: &Connection,
    query: &str,
    summary: bool,
) -> anyhow::Result<Vec<Favorite>> {
    let mut statement = conn.prepare("SELECT data FROM favorites")?;
    let mut rows = statement.query([])?;
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        let raw: String = row.get(0)?;
        let mut item: Favorite = serde_json::from_str(&raw)?;
        if !query.is_empty()
            && !format!("{}\n{}\n{}", item.title, item.body, item.tags.join(" "))
                .to_lowercase()
                .contains(query)
        {
            continue;
        }
        if summary {
            item.body = item.body.chars().take(180).collect();
        }
        items.push(item);
    }
    Ok(items)
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
    if action == "feedback/save" {
        return json!({"status":"failed","message":"反馈记录已停用"});
    }
    // 多个连接同时写入时，SQLite 偶尔会在拿到锁前返回 BUSY；短暂退避后重试，
    // 最终失败仍统一返回泛化错误。所有写操作都走事务或单条语句，重试不会重复提交。
    let mut attempt = 0;
    loop {
        match execute_inner(path, action, payload.clone()) {
            Ok(value) => return value,
            Err(error) if attempt < 3 && transient(&error) => {
                std::thread::sleep(Duration::from_millis(50 * (1 << attempt)));
                attempt += 1;
            }
            Err(error) => {
                #[cfg(test)]
                eprintln!("store action {action} failed: {error:#}");
                // SQLite、JSON 错误可能带正文；响应和日志均不转发原始错误。
                return json!({"status":"failed","message":"收藏操作失败，请检查内容后重试"});
            }
        }
    }
}

fn transient(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        let text = cause.to_string().to_ascii_lowercase();
        text.contains("database is locked")
            || text.contains("database table is locked")
            || text.contains("database is busy")
    })
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
            let tag = payload
                .get("tag")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let sort = payload
                .get("sort")
                .and_then(Value::as_str)
                .unwrap_or("manual");
            let limit = payload
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(5000)
                .clamp(1, 5000) as usize;
            let summary_only = payload.get("summaryOnly").and_then(Value::as_bool) == Some(true);
            let mut items = favorites_for_list(&conn, &query, summary_only)?;
            items.retain(|item| {
                let visible = match scope {
                    "all" => true,
                    "untagged" => item.tags.is_empty(),
                    "global" => item.project.is_none(),
                    "project" => item.project.is_some() && (all || item.project == project),
                    _ => {
                        all || item.project.is_none()
                            || (project.is_some() && item.project == project)
                    }
                };
                visible
            });
            let mut tags = items
                .iter()
                .flat_map(|item| item.tags.iter())
                .cloned()
                .collect::<Vec<_>>();
            tags.sort();
            tags.dedup();
            if !tag.is_empty() {
                items.retain(|item| item.tags.iter().any(|value| value == &tag));
            }
            match sort {
                "recent" => items.sort_by_key(|item| {
                    (
                        std::cmp::Reverse(item.last_used_at),
                        std::cmp::Reverse(item.updated_at),
                        item.id.clone(),
                    )
                }),
                "updated" => items.sort_by_key(|item| {
                    (
                        std::cmp::Reverse(item.updated_at),
                        std::cmp::Reverse(item.last_used_at),
                        item.id.clone(),
                    )
                }),
                // 默认按用户手动排的顺序；导出同样使用这个顺序。
                _ => items = manual(&items),
            }
            let total = items.len();
            let offset = payload
                .get("offset")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .min(usize::MAX as u64) as usize;
            let items: Vec<Value> = items.into_iter().skip(offset).take(limit).map(|item| {
                if summary_only {
                    let excerpt: String = item.body.chars().take(180).collect();
                    json!({"id":item.id,"title":item.title,"tags":item.tags,"project":item.project,
                        "order":item.order,"pinned":item.pinned,"excerpt":excerpt})
                } else { json!(item) }
            }).collect();
            Ok(
                json!({"status":"ok","favorites":items,"tags":tags,"total":total,"offset":offset,
                "hasMore":offset.saturating_add(items.len()) < total}),
            )
        }
        "library/get" => {
            let raw: String = conn.query_row(
                "SELECT data FROM favorites WHERE id=?1",
                [id(&payload)?],
                |row| row.get(0),
            )?;
            let item: Favorite = serde_json::from_str(&raw)?;
            Ok(json!({"status":"ok","favorite":item}))
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
                // 编辑保持原来的手动位置。
                item.order = old.order;
            } else {
                item.created_at = time;
                item.last_used_at = 0;
                item.order = first_order(&tx)?;
            }
            item.updated_at = time;
            tx.execute(
                "INSERT OR REPLACE INTO favorites VALUES (?1,?2)",
                params![item.id, serde_json::to_string(&item)?],
            )?;
            tx.commit()?;
            Ok(json!({"status":"ok","favorite":item}))
        }
        "library/delete" => {
            let id = id(&payload)?;
            let ordered = manual(&favorites(&conn)?);
            let Some(index) = ordered.iter().position(|item| item.id == id) else {
                bail!("收藏不存在");
            };
            let favorite = ordered[index].clone();
            conn.execute("DELETE FROM favorites WHERE id=?1", [id])?;
            Ok(json!({"status":"ok","favorite":favorite,"index":index}))
        }
        "feedback/delete" => {
            conn.execute("DELETE FROM feedback WHERE id=?1", [id(&payload)?])?;
            Ok(json!({"status":"ok"}))
        }
        "library/restore" => {
            let mut item: Favorite =
                serde_json::from_value(payload.get("favorite").cloned().context("缺少收藏内容")?)?;
            let index = payload.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            item.normalize()?;
            ensure!(!item.id.is_empty(), "收藏缺少 ID");
            let mut items = manual(&favorites(&conn)?);
            items.retain(|value| value.id != item.id);
            items.insert(index.min(items.len()), item);
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            for (position, value) in items.iter_mut().enumerate() {
                value.order = position as i64;
            }
            for value in &items {
                tx.execute(
                    "INSERT OR REPLACE INTO favorites VALUES (?1,?2)",
                    params![value.id, serde_json::to_string(value)?],
                )?;
            }
            tx.commit()?;
            Ok(json!({"status":"ok"}))
        }
        "library/reorder" => {
            let ids: Vec<String> = payload
                .get("ids")
                .and_then(Value::as_array)
                .context("缺少顺序")?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .filter(|text| !text.is_empty() && text.len() <= 80)
                        .map(str::to_string)
                        .context("收藏 ID 无效")
                })
                .collect::<anyhow::Result<_>>()?;
            ensure!(ids.len() <= 5000, "顺序内容过多");
            let mut seen = std::collections::HashSet::new();
            ensure!(ids.iter().all(|id| seen.insert(id.clone())), "收藏 ID 重复");
            let items = manual(&favorites(&conn)?);
            let known: std::collections::HashSet<&str> =
                items.iter().map(|item| item.id.as_str()).collect();
            ensure!(
                ids.iter().all(|id| known.contains(id.as_str())),
                "部分收藏不存在"
            );
            // 只重排传入的这几条，其他收藏（比如别的项目）保持原来的位置。
            let slots: Vec<usize> = items
                .iter()
                .enumerate()
                .filter(|(_, item)| ids.contains(&item.id))
                .map(|(index, _)| index)
                .collect();
            ensure!(slots.len() == ids.len(), "顺序内容不完整");
            let mut reordered = items.clone();
            for (slot, id) in slots.iter().zip(ids.iter()) {
                reordered[*slot] = items
                    .iter()
                    .find(|item| &item.id == id)
                    .expect("id 已校验")
                    .clone();
            }
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            for (position, item) in reordered.iter_mut().enumerate() {
                item.order = position as i64;
            }
            write_all(&tx, &reordered)?;
            tx.commit()?;
            Ok(json!({"status":"ok"}))
        }
        "library/add" => {
            let body = payload
                .get("body")
                .and_then(Value::as_str)
                .context("缺少正文")?
                .to_string();
            ensure!(
                !body.trim().is_empty() && body.chars().count() <= 20_000,
                "正文需要 1–20000 字"
            );
            let mut project: Option<Project> =
                serde_json::from_value(payload.get("project").cloned().unwrap_or(Value::Null))?;
            if let Some(project) = &mut project {
                project.normalize()?;
            }
            let time = now();
            let mut item = Favorite {
                id: uuid::Uuid::new_v4().to_string(),
                // 直接保存时第一行当标题。
                title: body
                    .trim()
                    .lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(80)
                    .collect(),
                body,
                tags: Vec::new(),
                project,
                pinned: false,
                order: first_order(&conn)?,
                created_at: time,
                updated_at: time,
                last_used_at: 0,
            };
            item.normalize()?;
            conn.execute(
                "INSERT INTO favorites VALUES (?1,?2)",
                params![item.id, serde_json::to_string(&item)?],
            )?;
            Ok(json!({"status":"ok","favorite":item}))
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
        "library/export" => Ok(json!({"status":"ok",
            "document":{"version":1,"favorites":manual(&favorites(&conn)?)}})),
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
            // 导入按文件里的数组顺序追加到现有列表末尾，不沿用文件里的 order。
            let mut next = favorites(&tx)?
                .iter()
                .map(|item| item.order)
                .max()
                .unwrap_or(-1)
                + 1;
            for mut item in document.favorites {
                let exists: bool = tx
                    .query_row(
                        "SELECT 1 FROM favorites WHERE id=?1",
                        [&item.id],
                        |_| Ok(()),
                    )
                    .optional()?
                    .is_some();
                if exists {
                    skipped += 1;
                    continue;
                }
                item.order = next;
                next += 1;
                tx.execute(
                    "INSERT OR IGNORE INTO favorites VALUES (?1,?2)",
                    params![item.id, serde_json::to_string(&item)?],
                )?;
                inserted += 1;
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

    #[test]
    fn summaries_page_without_bodies_and_detail_reads_one_favorite() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("library.db");
        for i in 0..65 {
            let item = execute(
                &path,
                "library/save",
                json!({"title":format!("item{i}"),"body":"长正文".repeat(2000)}),
            );
            assert_eq!(item["status"], "ok");
        }
        let first = execute(
            &path,
            "library/list",
            json!({"all":true,"offset":0,"limit":50,"summaryOnly":true}),
        );
        assert_eq!(first["total"], 65);
        assert_eq!(first["hasMore"], true);
        assert_eq!(first["favorites"].as_array().unwrap().len(), 50);
        assert!(first["favorites"][0].get("body").is_none());
        assert!(
            first["favorites"][0]["excerpt"]
                .as_str()
                .unwrap()
                .chars()
                .count()
                <= 180
        );
        let last = execute(
            &path,
            "library/list",
            json!({"all":true,"offset":50,"limit":50,"summaryOnly":true}),
        );
        assert_eq!(last["hasMore"], false);
        assert_eq!(last["favorites"].as_array().unwrap().len(), 15);
        let id = first["favorites"][0]["id"].as_str().unwrap();
        let detail = execute(&path, "library/get", json!({"id":id}));
        assert_eq!(
            detail["favorite"]["body"].as_str().unwrap().chars().count(),
            6000
        );
        assert!(
            execute(&path, "library/list", json!({"limit":1}))["favorites"][0]
                .get("body")
                .is_some()
        );
    }

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
        assert_eq!(updated["order"], local["order"], "编辑收藏不能改变手动顺序");
        assert_eq!(
            execute(&path, "library/list", json!({"all":true,"sort":"recent"}))["favorites"][0]["id"],
            local["id"],
            "旧排序方式仍然可用"
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
    fn manual_order_reorder_delete_restore_and_quick_add() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.db");
        let order = |value: Value| -> Vec<Value> {
            value["favorites"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["id"].clone())
                .collect()
        };
        let first = save(&path, "一", Value::Null);
        let second = save(&path, "二", Value::Null);
        let third = save(&path, "三", Value::Null);
        assert_eq!(
            order(execute(&path, "library/list", json!({}))),
            vec![
                third["id"].clone(),
                second["id"].clone(),
                first["id"].clone()
            ],
            "新收藏排在最前"
        );
        assert_eq!(
            execute(
                &path,
                "library/reorder",
                json!({"ids":[first["id"],third["id"]]})
            )["status"],
            "ok"
        );
        assert_eq!(
            order(execute(&path, "library/list", json!({}))),
            vec![
                first["id"].clone(),
                second["id"].clone(),
                third["id"].clone()
            ],
            "只重排传入的条目，未传入的保持原位置"
        );
        let deleted = execute(&path, "library/delete", json!({"id":second["id"]}));
        assert_eq!(deleted["index"], 1);
        execute(
            &path,
            "library/restore",
            json!({"favorite":deleted["favorite"],"index":deleted["index"]}),
        );
        assert_eq!(
            order(execute(&path, "library/list", json!({}))),
            vec![
                first["id"].clone(),
                second["id"].clone(),
                third["id"].clone()
            ]
        );
        let added = execute(&path, "library/add", json!({"body":"标题行\n正文"}));
        assert_eq!(added["favorite"]["title"], "标题行");
        assert_eq!(
            order(execute(&path, "library/list", json!({})))[0],
            added["favorite"]["id"]
        );
        assert_eq!(
            execute(&path, "library/reorder", json!({"ids":["missing"]}))["status"],
            "failed"
        );
        assert_eq!(
            execute(&path, "library/reorder", json!({"ids":["a","a"]}))["status"],
            "failed"
        );
    }

    #[test]
    fn legacy_pinned_order_migrates_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE favorites (id TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE feedback (id TEXT PRIMARY KEY, data TEXT NOT NULL);",
            )
            .unwrap();
            let legacy = |id: &str, pinned: bool, used: i64, updated: i64| {
                json!({"id":id,"title":id,"body":"正文","tags":[],"project":null,
                    "pinned":pinned,"createdAt":updated,"updatedAt":updated,"lastUsedAt":used})
            };
            for (id, pinned, used, updated) in [
                ("a", false, 10, 10),
                ("b", true, 5, 5),
                ("c", false, 30, 30),
            ] {
                conn.execute(
                    "INSERT INTO favorites VALUES (?1,?2)",
                    params![
                        id,
                        serde_json::to_string(&legacy(id, pinned, used, updated)).unwrap()
                    ],
                )
                .unwrap();
            }
            conn.pragma_update(None, "user_version", 1).unwrap();
        }
        let listed = execute(&path, "library/list", json!({}));
        let ids: Vec<Value> = listed["favorites"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].clone())
            .collect();
        assert_eq!(ids, vec![json!("b"), json!("c"), json!("a")]);
        assert_eq!(listed["favorites"][0]["order"], 0);
        let version: i64 = Connection::open(&path)
            .unwrap()
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap();
        assert_eq!(version, 2);
    }

    #[test]
    fn imports_append_in_array_order_and_exports_manual_order() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("store.db");
        let item = save(&path, "原有", Value::Null);
        let mut new = item.clone();
        new["id"] = json!("new");
        new["order"] = json!(-100);
        let document = json!({"version":1,"favorites":[new,item.clone()]});
        let preview = execute(&path, "library/import-preview", document.clone());
        assert_eq!(preview["inserted"], 1);
        execute(&path, "library/import", document);
        let exported = execute(&path, "library/export", json!({}));
        let favorites = exported["document"]["favorites"].as_array().unwrap();
        assert_eq!(favorites[0]["id"], item["id"], "现有收藏保持原位置");
        assert_eq!(favorites[1]["id"], "new", "导入按数组顺序追加到末尾");
    }
    #[test]
    fn retired_feedback_preserves_existing_records() {
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
        assert_eq!(
            execute(&path, "feedback/save", data.clone())["status"],
            "failed"
        );
        execute_inner(&path, "feedback/save", data).unwrap();
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
