use super::{ClaudeSession, path_key};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;

const SUMMARY_WINDOW: u64 = 128 * 1024;
const MAX_LINE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_BLOCK_CHARS: usize = 32 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageBlock {
    pub kind: String,
    pub text: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    pub id: String,
    pub role: String,
    pub timestamp_ms: Option<i64>,
    pub blocks: Vec<MessageBlock>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessagePage {
    pub messages: Vec<SessionMessage>,
    pub offset: usize,
    pub limit: usize,
    pub total_count: usize,
    pub has_more: bool,
    pub warnings: Vec<String>,
}

fn timestamp(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| {
        chrono::DateTime::parse_from_rfc3339(value.as_str()?)
            .ok()
            .map(|time| time.timestamp_millis())
    })
}

fn limited(text: &str, max: usize) -> String {
    let mut chars = text.chars();
    let mut result: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        result.push_str("\n[内容已截断]");
    }
    result
}

fn first_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(limited(text.trim(), 160));
    }
    value.as_array()?.iter().find_map(|block| {
        let text = block.get("text")?.as_str()?.trim();
        (!text.is_empty()).then(|| limited(text, 160))
    })
}

pub(super) fn summary(path: &Path) -> Result<ClaudeSession> {
    let metadata = fs::metadata(path)?;
    let id = path
        .file_stem()
        .context("会话文件名无效")?
        .to_string_lossy()
        .into_owned();
    let modified = metadata.modified()?.duration_since(UNIX_EPOCH)?.as_millis() as i64;
    let mut session = ClaudeSession {
        key: format!("{:x}", Sha256::digest(path_key(path).as_bytes())),
        id: id.clone(),
        transcript_path: path.to_path_buf(),
        updated_at_ms: modified,
        file_size: metadata.len(),
        ..Default::default()
    };
    let mut file = File::open(path)?;
    let mut windows = vec![(0, SUMMARY_WINDOW.min(metadata.len()))];
    if metadata.len() > SUMMARY_WINDOW {
        windows.push((
            metadata.len().saturating_sub(SUMMARY_WINDOW),
            SUMMARY_WINDOW,
        ));
    }
    let mut fallback = None;
    let mut custom_title = None;
    let mut generated_title = None;
    let mut main_message = false;
    let mut sidechain_message = false;
    let mut malformed = false;
    for (start, length) in windows {
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(length)
            .read_to_end(&mut bytes)?;
        let start_offset = if start > 0 {
            bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|index| index + 1)
                .unwrap_or(bytes.len())
        } else {
            0
        };
        let end_offset = if start + length < metadata.len() {
            bytes
                .iter()
                .rposition(|byte| *byte == b'\n')
                .unwrap_or(start_offset)
        } else {
            bytes.len()
        };
        for line in bytes[start_offset..end_offset.max(start_offset)].split(|byte| *byte == b'\n') {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let value: Value = match serde_json::from_slice(line) {
                Ok(value) => value,
                Err(_) => {
                    malformed = true;
                    continue;
                }
            };
            let kind = value["type"].as_str().unwrap_or("");
            if let Some(cwd) = value["cwd"].as_str()
                && session.cwd.is_empty()
            {
                session.cwd = cwd.to_string();
            }
            if let Some(time) = timestamp(&value["timestamp"]) {
                session.created_at_ms =
                    Some(session.created_at_ms.map_or(time, |old| old.min(time)));
            }
            if let Some(record_id) = value["sessionId"].as_str()
                && record_id != id
            {
                session.protected_reason = Some("文件名与记录中的会话 ID 不一致".into());
            }
            if matches!(kind, "user" | "assistant") {
                if value["isSidechain"].as_bool() == Some(true) {
                    sidechain_message = true;
                } else {
                    main_message = true;
                }
            }
            if kind == "user" && value["isMeta"].as_bool() != Some(true) && fallback.is_none() {
                fallback = first_text(&value["message"]["content"]);
            }
            match kind {
                "custom-title" => custom_title = value["customTitle"].as_str().map(str::to_string),
                "ai-title" => generated_title = value["title"].as_str().map(str::to_string),
                "summary" if generated_title.is_none() => {
                    generated_title = value["summary"].as_str().map(str::to_string);
                }
                _ => {}
            }
        }
    }
    session.title = custom_title.or(generated_title).or(fallback).unwrap_or(id);
    let cwd = session.cwd.replace('\\', "/").to_lowercase();
    if cwd.starts_with("//wsl$/")
        || cwd.starts_with("//wsl.localhost/")
        || cwd.starts_with("/sessions/")
    {
        session.protected_reason = Some("远程或 WSL 会话".into());
    } else if !Path::new(&session.cwd).is_absolute() {
        session.protected_reason = Some("会话未记录本机绝对项目路径".into());
    }
    if sidechain_message && !main_message {
        session.protected_reason = Some("子代理记录".into());
    }
    if malformed {
        session
            .warnings
            .push("部分记录无法解析，详情可能不完整".into());
    }
    Ok(session)
}

struct Node {
    parent: Option<String>,
    message: Option<SessionMessage>,
    api_id: Option<String>,
}

pub(super) fn messages(path: &Path, offset: usize, limit: usize) -> Result<MessagePage> {
    let before = super::FileStamp::read(path)?;
    let mut reader = BufReader::new(File::open(path)?);
    let mut nodes: HashMap<String, Node> = HashMap::new();
    let mut leaf = None;
    let mut legacy = Vec::new();
    let mut warnings = Vec::new();
    let mut line_number = 0;
    let mut malformed = 0;
    let mut consumed = 0u64;
    loop {
        let mut bytes = Vec::new();
        // 限制单行内存；大块工具结果和图片不应让管理器无限分配。
        let read = Read::by_ref(&mut reader)
            .take(MAX_LINE_BYTES + 1)
            .read_until(b'\n', &mut bytes)?;
        if read == 0 {
            break;
        }
        consumed += read as u64;
        ensure!(
            consumed <= 512 * 1024 * 1024 && nodes.len() < 100_000,
            "会话过大，请使用 Claude Code 导出后查看"
        );
        line_number += 1;
        if bytes.len() as u64 > MAX_LINE_BYTES {
            if !bytes.ends_with(b"\n") {
                loop {
                    let buffer = reader.fill_buf()?;
                    if buffer.is_empty() {
                        break;
                    }
                    let end = buffer.iter().position(|byte| *byte == b'\n');
                    let count = end.map_or(buffer.len(), |index| index + 1);
                    reader.consume(count);
                    consumed += count as u64;
                    ensure!(
                        consumed <= 512 * 1024 * 1024,
                        "会话过大，请使用 Claude Code 导出后查看"
                    );
                    if end.is_some() {
                        break;
                    }
                }
            }
            warnings.push(format!("第 {line_number} 行过长，已跳过"));
            continue;
        }
        if bytes.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let value: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => {
                malformed += 1;
                continue;
            }
        };
        if value["isSidechain"].as_bool() == Some(true) {
            continue;
        }
        let id = value["uuid"].as_str().map(str::to_string);
        let role = value["type"].as_str().unwrap_or("");
        let message =
            if matches!(role, "user" | "assistant") && value["isMeta"].as_bool() != Some(true) {
                Some(SessionMessage {
                    id: id.clone().unwrap_or_else(|| format!("line-{line_number}")),
                    role: role.into(),
                    timestamp_ms: timestamp(&value["timestamp"]),
                    blocks: content_blocks(&value["message"]["content"]),
                })
            } else if role == "attachment" {
                Some(SessionMessage {
                    id: id.clone().unwrap_or_else(|| format!("line-{line_number}")),
                    role: "attachment".into(),
                    timestamp_ms: timestamp(&value["timestamp"]),
                    blocks: vec![attachment(&value["attachment"])],
                })
            } else {
                None
            };
        if let Some(id) = id {
            if message.is_some() {
                leaf = Some(id.clone());
            }
            nodes.insert(
                id,
                Node {
                    parent: value["parentUuid"].as_str().map(str::to_string),
                    api_id: value["message"]["id"].as_str().map(str::to_string),
                    message,
                },
            );
        } else if let Some(message) = message {
            legacy.push((message, None));
        }
    }
    let mut chain = Vec::new();
    let mut visited = HashSet::new();
    let had_graph = leaf.is_some();
    while let Some(id) = leaf.take() {
        if !visited.insert(id.clone()) {
            warnings.push("消息关联存在循环，已停止读取".into());
            break;
        }
        let Some(node) = nodes.remove(&id) else {
            warnings.push("部分前序消息缺失".into());
            break;
        };
        leaf = node.parent;
        if let Some(message) = node.message {
            chain.push((message, node.api_id));
        }
    }
    chain.reverse();
    if !had_graph {
        chain = legacy;
    }
    let mut conversation: Vec<(SessionMessage, Option<String>)> = Vec::new();
    for (message, api_id) in chain {
        if let Some((previous, previous_api_id)) = conversation.last_mut()
            && message.role == "assistant"
            && previous.role == "assistant"
            && api_id.is_some()
            && *previous_api_id == api_id
        {
            for block in message.blocks {
                if let Some(old) = previous.blocks.iter_mut().find(|old| {
                    old.kind == block.kind
                        && old.name == block.name
                        && (old.text == block.text
                            || (matches!(block.kind.as_str(), "text" | "thinking")
                                && (old.text.starts_with(&block.text)
                                    || block.text.starts_with(&old.text))))
                }) {
                    if block.text.len() > old.text.len() {
                        old.text = block.text;
                    }
                } else {
                    previous.blocks.push(block);
                }
            }
        } else {
            conversation.push((message, api_id));
        }
    }
    if malformed > 0 {
        warnings.push(format!("{malformed} 行记录无法解析"));
    }
    ensure!(
        before == super::FileStamp::read(path)?,
        "会话正在写入，请稍后重新打开"
    );
    let total_count = conversation.len();
    Ok(MessagePage {
        messages: conversation
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|(message, _)| message)
            .collect(),
        offset,
        limit,
        total_count,
        has_more: offset.saturating_add(limit) < total_count,
        warnings,
    })
}

fn content_blocks(content: &Value) -> Vec<MessageBlock> {
    if let Some(text) = content.as_str() {
        return vec![MessageBlock {
            kind: "text".into(),
            text: limited(text, MAX_BLOCK_CHARS),
            name: String::new(),
        }];
    }
    let mut blocks: Vec<_> = content
        .as_array()
        .into_iter()
        .flatten()
        .take(200)
        .map(|block| {
            let kind = block["type"].as_str().unwrap_or("attachment");
            let (name, text) = match kind {
                "text" => ("".into(), block["text"].as_str().unwrap_or("").to_string()),
                "thinking" => (
                    "".into(),
                    block["thinking"].as_str().unwrap_or("").to_string(),
                ),
                "tool_use" => (
                    block["name"].as_str().unwrap_or("tool").to_string(),
                    serde_json::to_string_pretty(&block["input"]).unwrap_or_default(),
                ),
                "tool_result" => (
                    block["tool_use_id"].as_str().unwrap_or("tool").to_string(),
                    match &block["content"] {
                        Value::String(text) => text.clone(),
                        Value::Array(parts) => parts
                            .iter()
                            .filter_map(|part| part["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n"),
                        _ => String::new(),
                    },
                ),
                _ => return attachment(block),
            };
            MessageBlock {
                kind: kind.into(),
                name,
                text: limited(&text, MAX_BLOCK_CHARS),
            }
        })
        .collect();
    if content.as_array().is_some_and(|parts| parts.len() > 200) {
        blocks.push(MessageBlock {
            kind: "text".into(),
            text: "[该消息内容较多，仅显示前 200 个内容块]".into(),
            name: String::new(),
        });
    }
    blocks
}

fn attachment(value: &Value) -> MessageBlock {
    let kind = value["type"].as_str().unwrap_or("attachment");
    let name = ["filename", "fileName", "name", "filePath", "path"]
        .into_iter()
        .find_map(|key| value[key].as_str())
        .unwrap_or("");
    MessageBlock {
        kind: kind.into(),
        name: limited(name, 500),
        text: String::new(),
    }
}
