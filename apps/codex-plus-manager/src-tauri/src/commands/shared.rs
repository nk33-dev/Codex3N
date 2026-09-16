//! 命令层的公共管道：统一的返回包装、`ok`/`failed` 构造器与跨命令复用的进程内锁。
//!
//! 这里只放与具体业务无关、被 `commands` 下多个子模块共用的最小集合；带业务语义的
//! 负载类型留在各自的子模块里。

use std::sync::{Mutex, OnceLock};

use serde::Serialize;

/// 所有 Tauri 命令的统一返回包装：`status` 表示成功与否，`message` 给用户看，
/// `payload` 按业务结构展开到 JSON 顶层。
#[derive(Debug, Clone, Serialize)]
pub struct CommandResult<T>
where
    T: Serialize,
{
    pub status: String,
    pub message: String,
    #[serde(flatten)]
    pub payload: T,
}

pub(super) fn ok<T: Serialize>(message: &str, payload: T) -> CommandResult<T> {
    CommandResult {
        status: "ok".to_string(),
        message: message.to_string(),
        payload,
    }
}

pub(super) fn failed<T: Serialize>(message: &str, payload: T) -> CommandResult<T> {
    CommandResult {
        status: "failed".to_string(),
        message: message.to_string(),
        payload,
    }
}

/// 切换/应用中继配置的全局互斥锁：切换过程会写 `~/.codex` 下的真实文件，
/// 必须串行执行，避免两个命令交叉写入留下半套配置。
pub(super) fn relay_switch_mutex() -> &'static Mutex<()> {
    static RELAY_SWITCH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    RELAY_SWITCH_LOCK.get_or_init(|| Mutex::new(()))
}
