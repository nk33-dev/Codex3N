//! 从标准输入读取连接与草稿，调用正式生成入口；不加载或保存个人设置。
use std::io::{Read, Write};
use std::time::Instant;

use anyhow::{Context, ensure};
use codex_plus_core::prompt_enhance::{PromptEnhanceRequest, generate};
use codex_plus_core::settings::BackendSettings;
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Input {
    base_url: String,
    api_key: String,
    model: String,
    detail: String,
    audience: String,
    timeout_seconds: u64,
    request: PromptEnhanceRequest,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut input = String::new();
    std::io::stdin().take(256_001).read_to_string(&mut input)?;
    ensure!(input.len() <= 256_000, "输入过长");
    let input: Input = serde_json::from_str(&input).context("输入格式不正确")?;
    let mut settings = BackendSettings {
        enhancements_enabled: true,
        ..BackendSettings::default()
    };
    let config = &mut settings.prompt_enhance;
    config.enabled = true;
    config.use_stepwise_connection = false;
    config.base_url = input.base_url;
    config.api_key = input.api_key;
    config.model = input.model;
    config.protocol = "chat_completions".into();
    config.detail = input.detail;
    config.audience = input.audience;
    config.timeout_seconds = input.timeout_seconds;
    // 使用编译进当前代码的规则，测试输入不能覆盖规则或注入项目材料。
    ensure!(
        !config.context.enabled
            && config.system_prompt.is_empty()
            && config.grill_system_prompt.is_empty(),
        "联调必须使用内置规则且关闭项目上下文"
    );
    let started = Instant::now();
    let result = generate(input.request, &settings).await;
    serde_json::to_writer(
        std::io::stdout().lock(),
        &json!({"ms":started.elapsed().as_millis(),"result":result}),
    )?;
    std::io::stdout().flush()?;
    Ok(())
}
