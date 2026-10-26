use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{Value, json};

use crate::models::{DeleteResult, DeleteStatus, ExportResult, ExportStatus, SessionRef};
use crate::settings::{BackendSettings, SettingsStore};
use crate::status::StatusStore;
use crate::user_scripts::UserScriptManager;

pub type UserScriptEvaluator = Arc<dyn Fn(&str, &str) -> anyhow::Result<Value> + Send + Sync>;
pub type DevtoolsOpener = Arc<dyn Fn(&str) -> anyhow::Result<()> + Send + Sync>;

#[derive(Clone)]
pub struct BridgeContext {
    settings: Arc<dyn BridgeSettingsService>,
    runtime: Arc<dyn BridgeRuntimeService>,
    data: Arc<dyn BridgeDataService>,
}

impl BridgeContext {
    pub fn new(
        settings: Arc<dyn BridgeSettingsService>,
        runtime: Arc<dyn BridgeRuntimeService>,
        data: Arc<dyn BridgeDataService>,
    ) -> Self {
        Self {
            settings,
            runtime,
            data,
        }
    }

    pub fn core(runtime: Arc<dyn BridgeRuntimeService>) -> Self {
        Self::core_with_data(runtime, Arc::new(UnavailableDataService))
    }

    pub fn core_with_data(
        runtime: Arc<dyn BridgeRuntimeService>,
        data: Arc<dyn BridgeDataService>,
    ) -> Self {
        Self::new(Arc::new(CoreSettingsService::default()), runtime, data)
    }

    pub fn core_with_data_and_app_dir(
        runtime: Arc<dyn BridgeRuntimeService>,
        data: Arc<dyn BridgeDataService>,
        app_dir: PathBuf,
    ) -> Self {
        Self::new(
            Arc::new(CoreSettingsService::with_app_dir(app_dir)),
            runtime,
            data,
        )
    }
}

#[async_trait]
pub trait BridgeSettingsService: Send + Sync {
    async fn get_settings(&self) -> anyhow::Result<BackendSettings>;
    async fn set_settings(&self, payload: Value) -> anyhow::Result<BackendSettings>;

    async fn select_relay_api_key(&self, _key_id: String) -> anyhow::Result<BackendSettings> {
        anyhow::bail!("当前后端不支持切换 API Key")
    }

    /// live 配置里当前实际生效的 Key。只有知道 Codex home 的实现才会返回，
    /// 面板据此显示「当前 Key」，避免存档里的 activeApiKeyId 落后于实际配置。
    async fn live_codex_api_key(&self) -> Option<String> {
        None
    }

    async fn runtime_api_key(&self) -> Option<String> {
        None
    }

    async fn codex_app_version(&self) -> anyhow::Result<String> {
        Ok(String::new())
    }

    fn prompt_tools_path(&self) -> PathBuf {
        crate::prompt_enhance::store::default_path()
    }

    fn whale_ledger_path(&self) -> PathBuf {
        // 账本固定在状态目录：迁移设置文件路径后不能跟着换位置，否则余额历史看似清空。
        crate::paths::default_app_state_dir().join("whale-balance.sqlite3")
    }
}

#[async_trait]
pub trait BridgeRuntimeService: Send + Sync {
    async fn reload_api_key(&self, _api_key: &str) -> anyhow::Result<()> {
        anyhow::bail!("当前后端不支持更新运行中的认证")
    }

    async fn user_script_inventory(&self) -> anyhow::Result<Value>;
    async fn user_script_inventory_with_runtime_status(
        &self,
        _payload: Value,
    ) -> anyhow::Result<Value> {
        self.user_script_inventory().await
    }
    async fn set_user_scripts_enabled(&self, enabled: bool) -> anyhow::Result<Value>;
    async fn set_user_script_enabled(&self, key: String, enabled: bool) -> anyhow::Result<Value>;
    async fn delete_user_script(&self, key: String) -> anyhow::Result<Value>;
    async fn reload_user_scripts(&self) -> anyhow::Result<Value>;
    async fn load_user_scripts(&self) -> anyhow::Result<Value> {
        self.user_script_inventory().await
    }
    /// 列出拓展可注入的 Codex 页面。默认关闭，具体 runtime 再接 CDP。
    async fn cdp_targets(&self) -> anyhow::Result<Value> {
        anyhow::bail!("CDP targets are unavailable")
    }
    /// 在指定 Codex 页面执行表达式。默认关闭。
    async fn cdp_evaluate(&self, _payload: Value) -> anyhow::Result<Value> {
        anyhow::bail!("CDP evaluate is unavailable")
    }
    /// 拉市场清单，并合并本地已安装状态。
    async fn script_market_list(&self) -> anyhow::Result<Value> {
        anyhow::bail!("script market is unavailable")
    }
    /// 按 id 从市场安装脚本。
    async fn script_market_install(&self, _payload: Value) -> anyhow::Result<Value> {
        anyhow::bail!("script market is unavailable")
    }
    /// 独立插件市场只读取索引，安装时才获取目标插件。
    async fn plugin_market_list(&self, payload: Value) -> anyhow::Result<Value> {
        crate::plugin_market::list_plugins(
            &crate::codex_home::default_codex_home_dir(),
            payload
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("public"),
            payload
                .get("refresh")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        )
        .await
    }
    async fn plugin_market_install(&self, payload: Value) -> anyhow::Result<Value> {
        crate::plugin_market::install_plugin(
            &crate::codex_home::default_codex_home_dir(),
            payload
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("public"),
            payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
        .await
    }
    async fn plugin_market_install_status(&self, payload: Value) -> anyhow::Result<Value> {
        crate::plugin_market::install_status(
            &crate::codex_home::default_codex_home_dir(),
            payload
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("public"),
            payload
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        )
    }
    /// 注入层适配原生插件页面的列表、详情与安装协议。
    async fn plugin_market_native(&self, payload: Value) -> anyhow::Result<Value> {
        crate::plugin_market::native_request(
            &crate::codex_home::default_codex_home_dir(),
            payload
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            payload.get("params").cloned().unwrap_or_else(|| json!({})),
        )
        .await
    }
    async fn open_devtools(&self) -> anyhow::Result<Value>;
    async fn open_manager(&self, payload: Value) -> anyhow::Result<Value>;
    async fn open_transient_manager(&self, payload: Value) -> anyhow::Result<Value> {
        self.open_manager(payload).await
    }
    async fn backend_status(&self) -> anyhow::Result<Value>;
    async fn codex_model_catalog(&self) -> anyhow::Result<Value>;
}

#[async_trait]
pub trait BridgeDataService: Send + Sync {
    async fn scan_session_health(
        &self,
        _observed_ids: Vec<String>,
        _observed_only: bool,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("当前后端不支持检查失效会话，请重启新版 Codex3N")
    }
    async fn whale_history(&self, _payload: Value) -> anyhow::Result<Value> {
        Ok(json!({"status":"unavailable","message":"本机用量统计暂不可用"}))
    }
    async fn delete(&self, session: SessionRef) -> anyhow::Result<DeleteResult>;
    async fn undo(&self, undo_token: String) -> anyhow::Result<DeleteResult>;
    async fn export_markdown(&self, session: SessionRef) -> anyhow::Result<ExportResult>;
    async fn thread_usage_history(&self, session: SessionRef) -> anyhow::Result<Value>;
    /// Codex 输入框下方状态栏的轻量用量快照：只给最近的 token 事件，不返回全量历史。
    /// 内置状态栏专用，不进第三方拓展路由白名单。
    async fn thread_usage_live(&self, _session: SessionRef) -> anyhow::Result<Value> {
        Ok(json!({"status": "unavailable", "message": "本机用量快照暂不可用", "events": []}))
    }
    async fn whale_session(&self, _session: SessionRef) -> anyhow::Result<Value> {
        Ok(json!({"status": "unavailable", "message": "当前后端暂不支持会话用量摘要"}))
    }
    async fn find_archived_thread_by_title(
        &self,
        title: String,
    ) -> anyhow::Result<Option<SessionRef>>;
    async fn recover_remote_control_session(&self, _thread_id: String) -> anyhow::Result<Value> {
        anyhow::bail!("Remote Control session recovery is unavailable")
    }
}

/// 注入页按秒级轮询的路由：成功时不写逐请求日志，失败照常记录。
///
/// 心跳每 5 秒取设置、用量栏运行中每 1.2 秒取一次用量，原先每次调用要写 4 行，
/// 占诊断日志九成，还把有用的事件挤出压缩窗口。
pub(crate) fn is_high_frequency_bridge_path(path: &str) -> bool {
    matches!(
        path,
        "/backend/status" | "/diagnostics/log" | "/settings/get" | "/thread-usage-live"
    )
}

/// 拓展脚本在独立 Codex 页面（例如宠物 overlay）执行表达式。
/// 只走 Runtime.evaluate，且必须指定 kind 或 target_id，避免误打到管理页。
pub const EXTENSION_CDP_EXPRESSION_MAX_BYTES: usize = 256 * 1024;

fn nonempty_payload_str<'a>(payload: &'a Value, key: &str) -> Option<&'a str> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub async fn evaluate_extension_cdp(debug_port: u16, payload: &Value) -> anyhow::Result<Value> {
    let expression = nonempty_payload_str(payload, "expression")
        .ok_or_else(|| anyhow::anyhow!("expression 不能为空"))?;
    if expression.len() > EXTENSION_CDP_EXPRESSION_MAX_BYTES {
        anyhow::bail!(
            "expression 超过 {} 字节上限",
            EXTENSION_CDP_EXPRESSION_MAX_BYTES
        );
    }
    let target_id = nonempty_payload_str(payload, "target_id")
        .or_else(|| nonempty_payload_str(payload, "targetId"));
    let kind = nonempty_payload_str(payload, "kind");
    let targets = crate::cdp::list_targets(debug_port).await?;
    let selected = crate::cdp::select_extension_cdp_targets(&targets, target_id, kind)?;
    let mut results = Vec::new();
    for target in selected {
        let websocket = target
            .web_socket_debugger_url
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("CDP 页面没有 WebSocket URL"))?;
        let result = match crate::bridge::evaluate_script_return_by_value(websocket, expression)
            .await
        {
            Ok(response) => json!({
                "id": target.id,
                "ok": true,
                "value": response.pointer("/result/result/value").cloned().unwrap_or(Value::Null),
            }),
            Err(error) => json!({
                "id": target.id,
                "ok": false,
                "error": error.to_string(),
            }),
        };
        results.push(result);
    }
    Ok(json!({ "status": "ok", "results": results }))
}

pub async fn handle_bridge_request(
    ctx: BridgeContext,
    path: &str,
    payload: Value,
) -> serde_json::Value {
    let started = Instant::now();
    let trace_request = !is_high_frequency_bridge_path(path);
    if trace_request {
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "bridge.request",
            json!({
                "path": path,
                "payload_keys": payload
                    .as_object()
                    .map(|object| object.keys().cloned().collect::<Vec<_>>())
                    .unwrap_or_default()
            }),
        );
    }
    let result = match path {
        "/settings/get" => settings_value(&ctx, ctx.settings.get_settings().await).await,
        "/dictation/status" => ctx.settings.get_settings().await.map(|settings| {
            let effective = crate::dictation::effective_settings(&settings);
            let mut status = crate::dictation::public_status(&effective);
            if effective.enabled {
                status["helperToken"] = json!(crate::dictation::helper_token());
            }
            status
        }),
        "/dictation/transcribe" => match ctx.settings.get_settings().await {
            Ok(settings) => crate::dictation::transcribe_bridge(
                &crate::dictation::effective_settings(&settings),
                &payload,
            )
            .await
            .map_err(anyhow::Error::from),
            Err(_) => Err(anyhow::anyhow!("无法读取语音设置")),
        },
        "/dictation/cancel" => {
            crate::dictation::cancel_bridge(&payload).map_err(anyhow::Error::from)
        }
        path if path.starts_with("/prompt-enhance/library/")
            || path.starts_with("/prompt-enhance/feedback/") =>
        {
            let database = ctx.settings.prompt_tools_path();
            let action = path.trim_start_matches("/prompt-enhance/").to_string();
            let data = payload.clone();
            tokio::task::spawn_blocking(move || {
                crate::prompt_enhance::store::execute(&database, &action, data)
            })
            .await
            .map_err(|_| anyhow::anyhow!("收藏操作失败"))
        }
        "/prompt-enhance/cancel" => Ok(crate::prompt_enhance::cancel(&payload)),
        "/prompt-enhance/generate" => match ctx.settings.get_settings().await {
            Ok(settings) => match serde_json::from_value(payload.clone()) {
                Ok(request) => Ok(crate::prompt_enhance::generate(request, &settings).await),
                Err(_) => Ok(json!({"status":"failed","message":"提示词增强请求格式不正确"})),
            },
            Err(_) => Err(anyhow::anyhow!("无法读取提示词增强设置")),
        },
        "/settings/set" => {
            settings_value(&ctx, ctx.settings.set_settings(payload.clone()).await).await
        }
        "/relay-api-keys" => {
            let settings = ctx.settings.get_settings().await;
            let live_api_key = ctx.settings.live_codex_api_key().await;
            relay_api_keys_value(settings, live_api_key)
        }
        "/relay-api-keys/select" => {
            let key_id = payload
                .get("keyId")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            select_relay_api_key_value(&ctx, key_id).await
        }
        "/user-scripts/list" => {
            ctx.runtime
                .user_script_inventory_with_runtime_status(payload.clone())
                .await
        }
        "/user-scripts/set-enabled" => {
            let enabled = payload
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            ctx.runtime.set_user_scripts_enabled(enabled).await
        }
        "/user-scripts/set-script-enabled" => {
            let key = payload
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let enabled = payload
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            ctx.runtime.set_user_script_enabled(key, enabled).await
        }
        "/user-scripts/delete" => {
            let key = payload
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            ctx.runtime.delete_user_script(key).await
        }
        "/user-scripts/load" => ctx.runtime.load_user_scripts().await,
        "/user-scripts/reload" => ctx.runtime.reload_user_scripts().await,
        "/cdp/targets" => ctx.runtime.cdp_targets().await,
        "/cdp/evaluate" => ctx.runtime.cdp_evaluate(payload.clone()).await,
        "/devtools/open" => ctx.runtime.open_devtools().await,
        "/manager/open" => ctx.runtime.open_manager(payload.clone()).await,
        "/manager/open-transient" => ctx.runtime.open_transient_manager(payload.clone()).await,
        "/backend/status" => backend_status_value(
            ctx.runtime.backend_status().await,
            ctx.settings.get_settings().await,
        ),
        "/codex-model-catalog" | "/codex-config-model" => ctx.runtime.codex_model_catalog().await,
        "/codex-model-test" => {
            crate::model_catalog::test_codex_model(
                payload
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                payload
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
            .await
        }
        "/diagnostics/log" => diagnostic_log_value(payload.clone()),
        "/llm-proxy" => llm_proxy_value(payload.clone()).await,
        "/script-market/list" => ctx.runtime.script_market_list().await,
        "/script-market/install" => ctx.runtime.script_market_install(payload.clone()).await,
        "/plugin-market/list" => ctx.runtime.plugin_market_list(payload.clone()).await,
        "/plugin-market/install" => ctx.runtime.plugin_market_install(payload.clone()).await,
        "/plugin-market/install-status" => {
            ctx.runtime
                .plugin_market_install_status(payload.clone())
                .await
        }
        "/plugin-market/native" => ctx.runtime.plugin_market_native(payload.clone()).await,
        "/stepwise/settings" => stepwise_settings_value(ctx.settings.get_settings().await),
        "/stepwise/generate" => {
            stepwise_generate_value(ctx.settings.get_settings().await, payload.clone()).await
        }
        "/stepwise/test" => {
            stepwise_test_value(ctx.settings.get_settings().await, payload.clone()).await
        }
        "/session/health" => {
            let ids = payload
                .get("threadIds")
                .and_then(Value::as_array)
                .map(|ids| {
                    ids.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let observed_only = payload
                .get("observedOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            ctx.data.scan_session_health(ids, observed_only).await
        }
        "/delete" => {
            let session = session_from_payload(&payload);
            match session.require_local_delete() {
                Ok(()) => result_value(ctx.data.delete(session).await),
                Err(error) => Err(error),
            }
        }
        "/undo" => {
            let undo_token = payload
                .get("undo_token")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            result_value(ctx.data.undo(undo_token).await)
        }
        "/export-markdown" => result_value(
            ctx.data
                .export_markdown(session_from_payload(&payload))
                .await,
        ),
        "/thread-usage-history" => {
            ctx.data
                .thread_usage_history(session_from_payload(&payload))
                .await
        }
        "/thread-usage-live" => {
            ctx.data
                .thread_usage_live(session_from_payload(&payload))
                .await
        }
        // 仅内置挂件使用，不加入第三方拓展路由白名单。
        "/whale/history" => match ctx.settings.get_settings().await {
            Ok(settings)
                if crate::whale::enabled(&settings)
                    && crate::whale_full::history_enabled(&ctx.settings.whale_ledger_path()) =>
            {
                ctx.data.whale_history(payload.clone()).await
            }
            Ok(_) => Ok(json!({"status":"disabled"})),
            Err(_) => Ok(json!({"status":"unavailable","message":"无法读取挂件设置"})),
        },
        "/whale/full" => match ctx.settings.get_settings().await {
            Ok(settings) => {
                let path = ctx.settings.whale_ledger_path();
                let requested_path = payload
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let history = if crate::whale::enabled(&settings)
                    && crate::whale_full::history_enabled(&path)
                    && matches!(
                        requested_path,
                        "/dsh-whale/usage-records.json" | "/dsh-whale/api-models.json"
                    ) {
                    ctx.data
                        .whale_history(crate::whale_full::history_query(&path))
                        .await
                        .unwrap_or_else(|_| json!({"status":"unavailable"}))
                } else {
                    Value::Null
                };
                Ok(crate::whale_full::handle(&settings, path, payload.clone(), history).await)
            }
            Err(_) => Ok(json!({"status":503,"body":{"ok":false,"error":"无法读取挂件设置"}})),
        },
        "/whale/balance" => match ctx.settings.get_settings().await {
            Ok(settings) => {
                Ok(crate::whale::balance(&settings, ctx.settings.whale_ledger_path()).await)
            }
            Err(_) => Ok(crate::whale::unavailable("无法读取挂件设置")),
        },
        "/whale/session" => match ctx.settings.get_settings().await {
            Ok(settings)
                if crate::whale::enabled(&settings)
                    && crate::whale_full::history_enabled(&ctx.settings.whale_ledger_path()) =>
            {
                ctx.data.whale_session(session_from_payload(&payload)).await
            }
            Ok(_) => Ok(json!({"status": "disabled"})),
            Err(_) => Ok(json!({"status": "unavailable", "message": "无法读取挂件设置"})),
        },
        "/archived-thread" => {
            let title = payload
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            archived_thread_value(ctx.data.find_archived_thread_by_title(title).await)
        }
        "/remote-control-session/recover" => {
            let thread_id = payload
                .get("thread_id")
                .or_else(|| payload.get("threadId"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            ctx.data.recover_remote_control_session(thread_id).await
        }
        "/side-chat/source" | "/side-chat/save" => {
            let request = payload.clone();
            let operation = if path == "/side-chat/source" {
                crate::side_chat::source_snapshot
            } else {
                crate::side_chat::save
            };
            tokio::task::spawn_blocking(move || {
                operation(&crate::codex_home::default_codex_home_dir(), &request)
            })
            .await
            .unwrap_or_else(|error| Err(anyhow::anyhow!(error.to_string())))
        }
        "/proxy-status" => {
            async {
                // 代理进程的实时请求状态只存在管理器内存里；桥接进程通过本地 helper
                // 的只读路由取一份快照，供 Codex 页面里的状态条轮询。
                let client = crate::http_client::direct_client("Codex3N/ProxyStatus")?;
                let port = crate::protocol_proxy::protocol_proxy_port();
                match client
                    .post(format!("http://127.0.0.1:{port}/proxy-status"))
                    .json(&serde_json::json!({}))
                    .timeout(std::time::Duration::from_secs(2))
                    .send()
                    .await
                {
                    Ok(response) => response
                        .json::<Value>()
                        .await
                        .map_err(|error| anyhow::anyhow!(error.to_string())),
                    Err(error) => Ok(serde_json::json!({
                        "status": "failed",
                        "message": error.to_string()
                    })),
                }
            }
            .await
        }
        _ => {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "bridge.unknown_path",
                json!({
                    "path": path
                }),
            );
            return json!({
                "status": "failed",
                "session_id": "",
                "message": "Unknown bridge path"
            });
        }
    };

    let response = result.unwrap_or_else(|error| {
        if path.starts_with("/prompt-enhance/")
            || matches!(
                path,
                "/dictation/transcribe" | "/dictation/cancel" | "/prompt-enhance/generate"
            )
        {
            failed_from_error(&Value::Null, error)
        } else {
            failed_from_error(&payload, error)
        }
    });
    if trace_request || response.get("status").and_then(Value::as_str) != Some("ok") {
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "bridge.response",
            json!({
                "path": path,
                "elapsed_ms": started.elapsed().as_millis() as u64,
                "status": response.get("status").and_then(Value::as_str).unwrap_or("")
            }),
        );
    }
    response
}

#[derive(Default)]
pub struct CoreSettingsService {
    store: SettingsStore,
    app_dir: Option<PathBuf>,
}

impl CoreSettingsService {
    fn with_app_dir(app_dir: PathBuf) -> Self {
        Self {
            store: SettingsStore::default(),
            app_dir: Some(app_dir),
        }
    }
}

#[async_trait]
impl BridgeSettingsService for CoreSettingsService {
    async fn get_settings(&self) -> anyhow::Result<BackendSettings> {
        // 注入页心跳每 5 秒取一次设置；文件没变就复用上次解析解密的结果。
        Ok(self.store.try_load_cached()?.as_ref().clone())
    }

    async fn set_settings(&self, payload: Value) -> anyhow::Result<BackendSettings> {
        self.store.update(payload)
    }

    async fn select_relay_api_key(&self, key_id: String) -> anyhow::Result<BackendSettings> {
        let result = crate::relay_switch::select_active_relay_api_key_in_home(
            &self.store,
            &crate::relay_config::default_codex_home_dir(),
            &key_id,
        )?;
        Ok(result.settings)
    }

    async fn live_codex_api_key(&self) -> Option<String> {
        crate::relay_config::live_codex_api_key_in_home(
            &crate::relay_config::default_codex_home_dir(),
        )
    }

    async fn runtime_api_key(&self) -> Option<String> {
        crate::relay_config::runtime_api_key_in_home(&crate::relay_config::default_codex_home_dir())
    }

    async fn codex_app_version(&self) -> anyhow::Result<String> {
        if let Some(app_dir) = self.app_dir.as_deref() {
            return Ok(crate::app_paths::codex_app_version(app_dir).unwrap_or_default());
        }
        let settings = self.store.load_cached();
        let app_dir = crate::app_paths::resolve_codex_app_dir_with_saved(
            None,
            Some(settings.codex_app_path.as_str()),
        );
        Ok(app_dir
            .as_deref()
            .and_then(crate::app_paths::codex_app_version)
            .unwrap_or_default())
    }
}

#[derive(Clone)]
pub struct CoreRuntimeService {
    debug_port: u16,
    status_store: StatusStore,
    user_scripts: Option<UserScriptManager>,
    websocket_url: Option<String>,
    user_script_evaluator: Option<UserScriptEvaluator>,
    devtools_opener: Option<DevtoolsOpener>,
    devtools_target_id: Option<String>,
}

impl CoreRuntimeService {
    pub fn new(debug_port: u16, status_store: StatusStore) -> Self {
        Self {
            debug_port,
            status_store,
            user_scripts: None,
            websocket_url: None,
            user_script_evaluator: None,
            devtools_opener: None,
            devtools_target_id: None,
        }
    }

    pub fn with_user_scripts(mut self, user_scripts: UserScriptManager) -> Self {
        self.user_scripts = Some(user_scripts);
        self
    }

    pub fn with_websocket_url(mut self, websocket_url: impl Into<String>) -> Self {
        self.websocket_url = Some(websocket_url.into());
        self
    }

    pub fn with_user_script_evaluator(mut self, evaluator: UserScriptEvaluator) -> Self {
        self.user_script_evaluator = Some(evaluator);
        self
    }

    pub fn with_devtools_opener(mut self, opener: DevtoolsOpener) -> Self {
        self.devtools_opener = Some(opener);
        self
    }

    pub fn with_devtools_target_id(mut self, target_id: impl Into<String>) -> Self {
        self.devtools_target_id = Some(target_id.into());
        self
    }
}

#[async_trait]
impl BridgeRuntimeService for CoreRuntimeService {
    async fn reload_api_key(&self, api_key: &str) -> anyhow::Result<()> {
        let websocket_url = self
            .websocket_url
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("Codex 页面尚未连接"))?;
        crate::bridge::reload_api_key_at(websocket_url, api_key).await
    }

    async fn user_script_inventory(&self) -> anyhow::Result<Value> {
        match &self.user_scripts {
            Some(user_scripts) => user_scripts.inventory(),
            None => Ok(empty_user_script_inventory()),
        }
    }

    async fn set_user_scripts_enabled(&self, enabled: bool) -> anyhow::Result<Value> {
        match &self.user_scripts {
            Some(user_scripts) => {
                user_scripts.set_global_enabled(enabled)?;
                user_scripts.inventory()
            }
            None => {
                let mut inventory = empty_user_script_inventory();
                inventory["enabled"] = json!(enabled);
                Ok(inventory)
            }
        }
    }

    async fn set_user_script_enabled(&self, key: String, enabled: bool) -> anyhow::Result<Value> {
        match &self.user_scripts {
            Some(user_scripts) => {
                user_scripts.set_script_enabled(&key, enabled)?;
                user_scripts.inventory()
            }
            None => Ok(empty_user_script_inventory()),
        }
    }

    async fn delete_user_script(&self, key: String) -> anyhow::Result<Value> {
        match &self.user_scripts {
            Some(user_scripts) => {
                user_scripts.delete_user_script(&key)?;
                user_scripts.inventory()
            }
            None => Ok(empty_user_script_inventory()),
        }
    }

    async fn load_user_scripts(&self) -> anyhow::Result<Value> {
        if let (Some(user_scripts), Some(websocket_url), Some(evaluator)) = (
            &self.user_scripts,
            self.websocket_url.as_deref(),
            &self.user_script_evaluator,
        ) {
            evaluator(websocket_url, &user_scripts.build_initial_bundle()?)?;
        } else {
            anyhow::bail!("Codex 页面尚未连接");
        }
        self.user_script_inventory().await
    }

    async fn script_market_list(&self) -> anyhow::Result<Value> {
        let Some(user_scripts) = &self.user_scripts else {
            anyhow::bail!("用户脚本目录不可用");
        };
        crate::script_market::list_market_scripts(user_scripts).await
    }

    async fn script_market_install(&self, payload: Value) -> anyhow::Result<Value> {
        let Some(user_scripts) = &self.user_scripts else {
            anyhow::bail!("用户脚本目录不可用");
        };
        let id = payload
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if id.is_empty() {
            anyhow::bail!("脚本 id 不能为空");
        }
        crate::script_market::install_market_script_by_id(user_scripts, id).await
    }

    async fn reload_user_scripts(&self) -> anyhow::Result<Value> {
        if let (Some(user_scripts), Some(websocket_url), Some(evaluator)) = (
            &self.user_scripts,
            self.websocket_url.as_deref(),
            &self.user_script_evaluator,
        ) {
            let bundle = user_scripts.build_reload_bundle()?;
            evaluator(websocket_url, &bundle)?;
        } else {
            anyhow::bail!("Codex 页面尚未连接");
        }
        self.user_script_inventory().await
    }

    async fn cdp_targets(&self) -> anyhow::Result<Value> {
        crate::cdp::list_extension_cdp_targets(self.debug_port).await
    }

    async fn cdp_evaluate(&self, payload: Value) -> anyhow::Result<Value> {
        evaluate_extension_cdp(self.debug_port, &payload).await
    }

    async fn open_devtools(&self) -> anyhow::Result<Value> {
        let target_id = self
            .devtools_target_id
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("No DevTools target configured"))?;
        let url = devtools_url(self.debug_port, target_id);
        if let Some(opener) = &self.devtools_opener {
            opener(&url)?;
        }
        Ok(json!({
            "status": "ok",
            "target_id": target_id,
            "url": url
        }))
    }

    async fn open_manager(&self, payload: Value) -> anyhow::Result<Value> {
        let navigation =
            crate::manager_navigation::save_pending_manager_navigation_from_payload(&payload)?;
        let target = crate::install::open_or_activate_manager().map_err(|error| {
            crate::manager_navigation::rollback_pending_manager_navigation_after_launch_failure(
                navigation.as_ref(),
                error,
            )
        })?;
        Ok(json!({
            "status": "ok",
            "path": target,
            "navigation": navigation
        }))
    }

    async fn open_transient_manager(&self, payload: Value) -> anyhow::Result<Value> {
        let navigation =
            crate::manager_navigation::save_pending_manager_navigation_from_payload(&payload)?;
        let target = crate::install::spawn_companion(
            crate::install::MANAGER_BINARY,
            ["--transient"],
        )
        .map_err(|error| {
            crate::manager_navigation::rollback_pending_manager_navigation_after_launch_failure(
                navigation.as_ref(),
                error,
            )
        })?;
        Ok(json!({
            "status": "ok",
            "path": target,
            "navigation": navigation
        }))
    }

    async fn backend_status(&self) -> anyhow::Result<Value> {
        let _ = self.status_store.load_latest();
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "bridge.backend_status_ok",
            json!({
                "debug_port": self.debug_port,
                "version": crate::version::VERSION
            }),
        );
        Ok(json!({"status": "ok", "message": "后端已连接", "version": crate::version::VERSION}))
    }

    async fn codex_model_catalog(&self) -> anyhow::Result<Value> {
        Ok(crate::model_catalog::read_codex_model_catalog().await)
    }
}

struct UnavailableDataService;

#[async_trait]
impl BridgeDataService for UnavailableDataService {
    async fn delete(&self, session: SessionRef) -> anyhow::Result<DeleteResult> {
        Ok(DeleteResult {
            status: DeleteStatus::Failed,
            session_id: session.session_id,
            message: "Delete service is not wired in core launcher hooks".to_string(),
            undo_token: None,
            backup_path: None,
        })
    }

    async fn undo(&self, undo_token: String) -> anyhow::Result<DeleteResult> {
        Ok(DeleteResult {
            status: DeleteStatus::Failed,
            session_id: String::new(),
            message: "Undo service is not wired in core launcher hooks".to_string(),
            undo_token: Some(undo_token),
            backup_path: None,
        })
    }

    async fn export_markdown(&self, session: SessionRef) -> anyhow::Result<ExportResult> {
        Ok(ExportResult {
            status: ExportStatus::Failed,
            session_id: session.session_id,
            message: "Markdown export service is not wired in core launcher hooks".to_string(),
            filename: None,
            markdown: None,
        })
    }

    async fn thread_usage_history(&self, session: SessionRef) -> anyhow::Result<Value> {
        Ok(json!({
            "status": "failed",
            "session_id": session.session_id,
            "message": "Thread usage history service is not wired in core launcher hooks",
            "history": []
        }))
    }

    async fn find_archived_thread_by_title(
        &self,
        _title: String,
    ) -> anyhow::Result<Option<SessionRef>> {
        Ok(None)
    }
}

fn settings_payload_value(
    mut settings: BackendSettings,
    codex_app_version: String,
) -> anyhow::Result<Value> {
    let managed_session_connection = managed_session_connection(&settings);
    let active_relay_session_provider = settings.active_relay_session_provider();
    let active_relay_codex_provider = crate::model_catalog::codex_model_provider_for_relay_profile(
        &crate::relay_config::default_codex_home_dir(),
        &settings.active_relay_profile(),
    );
    settings.dictation = crate::dictation::effective_settings(&settings);
    let native_fast = crate::native_fast::runtime_settings(&settings);
    let profiles: Vec<_> = settings
        .relay_profiles
        .iter()
        .map(|profile| {
            let provider = profile
                .config_contents
                .parse::<toml::Value>()
                .ok()
                .and_then(|doc| {
                    doc.get("model_provider")
                        .and_then(toml::Value::as_str)
                        .map(str::to_owned)
                });
            // 渲染端只需要供应商标识，不接收完整 TOML、认证快照或自定义请求头。
            let config = provider
                .map(|provider| format!("model_provider = {}\n", json!(provider)))
                .unwrap_or_default();
            json!({"id":profile.id,"name":profile.name,"relayMode":profile.relay_mode,
            "officialMixApiKey":profile.official_mix_api_key,"protocol":profile.protocol,
            "modelList":profile.model_list,"configContents":config})
        })
        .collect();
    let mut value = serde_json::to_value(&settings)?;
    let object = value.as_object_mut().expect("设置序列化为对象");
    object.retain(|key, _| RENDERER_SETTING_FIELDS.contains(&key.as_str()));
    object.insert("relayProfiles".into(), json!(profiles));
    object.insert(
        "dictation".into(),
        json!({
            "enabled":settings.dictation.enabled,"provider":settings.dictation.provider,
            "apiKeyConfigured":!settings.dictation.api_key.trim().is_empty()
        }),
    );
    object.insert(
        "promptEnhance".into(),
        json!({
            "enabled":settings.prompt_enhance.enabled,
            "rewriteEnabled":settings.prompt_enhance.rewrite_enabled,
            "grillEnabled":settings.prompt_enhance.grill_enabled,
            "favoritesEnabled":settings.prompt_enhance.favorites_enabled,
            "defaultMode":settings.prompt_enhance.default_mode,
            "detail":settings.prompt_enhance.detail,"audience":settings.prompt_enhance.audience,
            "context":settings.prompt_enhance.context,
            "apiKeyConfigured":!settings.prompt_enhance.api_key.trim().is_empty()
        }),
    );
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "managedSessionConnection".to_string(),
            managed_session_connection,
        );
        object.insert(
            "activeRelaySessionProvider".to_string(),
            Value::String(active_relay_session_provider.as_str().to_string()),
        );
        object.insert(
            "activeRelayCodexProvider".to_string(),
            Value::String(active_relay_codex_provider),
        );
        object.insert(
            "codexAppVersion".to_string(),
            Value::String(codex_app_version),
        );
        object.insert(
            "nativeFastLocalApiConfigured".to_string(),
            Value::Bool(native_fast.native_fast_local_api_configured),
        );
    }
    Ok(value)
}

// 新设置默认不下发；增加字段时同时确认渲染端用途及是否含有凭据。
const RENDERER_SETTING_FIELDS: &[&str] = &[
    "enhancementsEnabled",
    "providerSyncEnabled",
    "relayProfilesEnabled",
    "activeRelayId",
    "codexAppStandaloneQuotaUnlock",
    "codexAppPluginMarketplaceUnlock",
    "codexAppModelWhitelistUnlock",
    "codexAppIncludeNativeModels",
    "codexAppSessionDelete",
    "codexAppSideChatSave",
    "codexAppTurnRewind",
    "codexAppMarkdownExport",
    "codexAppSessionShare",
    "codexAppUsageStatusLine",
    "codexAppPasteFix",
    "codexAppTypingEffect",
    "codexAppThreadIdBadge",
    "codexAppLowPower",
    "codexAppConversationView",
    "codexAppNativeMenuPlacement",
    "codexAppNativeFastUnlock",
    "codexAppPetRealMouseLook",
    "codexAppActivityOverlayRight",
    "codexAppCapacityAutoRetry",
    "codexAppCapacityAutoRetryMaxAttempts",
    "codexAppCapacityAutoRetryIntervalSeconds",
    "codexAppWhaleWidgetEnabled",
    "codexAppWhaleBalanceProtocol",
    "codexAppWhaleBalancePath",
    "codexAppWhaleBalanceField",
    "codexAppWhaleBalanceCurrency",
    "codexAppWhaleBalanceScale",
    "codexAppStepwiseEnabled",
    "codexAppStepwiseGenerationMode",
    "codexAppStepwiseDirectSend",
    "codexAppStepwiseMaxItems",
    "codexAppAnswerOutlineEnabled",
    "codexAppDreamSkinEnabled",
    "codexAppDreamSkinPaused",
    "codexAppDreamSkinThemeConfig",
    "codexAppDreamSkinImagePath",
];

fn managed_session_connection(settings: &BackendSettings) -> Value {
    // 固定所有自定义会话聚合的本地传输，模型聚合与故障转移共用这一入口。
    // 不要把成员的真实认证信息下发给 renderer。
    let Some(aggregate) = settings.active_aggregate_relay_profile() else {
        return Value::Null;
    };
    if !settings.relay_profiles_enabled
        || aggregate.session_provider != crate::settings::RelaySessionProvider::Custom
        || aggregate.sync_default_member_login
    {
        return Value::Null;
    }
    json!({
        "profileId": settings.active_relay_id,
        "provider": "codex_plus_managed",
        "baseUrl": crate::protocol_proxy::local_responses_proxy_base_url(
            crate::protocol_proxy::protocol_proxy_port()
        ),
    })
}

#[cfg(test)]
mod dictation_privacy_tests {
    use super::*;

    #[test]
    fn managed_session_connection_uses_settings_and_local_proxy_only() {
        use crate::settings::{
            AggregateRelayProfile, RelayMode, RelayProfile, RelaySessionProvider,
        };
        let mut settings = BackendSettings {
            relay_profiles_enabled: true,
            active_relay_id: "aggregate".to_string(),
            relay_profiles: vec![RelayProfile {
                id: "aggregate".to_string(),
                relay_mode: RelayMode::Aggregate,
                ..RelayProfile::default()
            }],
            aggregate_relay_profiles: vec![AggregateRelayProfile {
                id: "aggregate".to_string(),
                name: String::new(),
                session_provider: RelaySessionProvider::Custom,
                model_aggregation_enabled: true,
                strategy: Default::default(),
                members: Vec::new(),
                routes: Vec::new(),
                default_relay_id: String::new(),
                sync_default_member_login: false,
            }],
            ..BackendSettings::default()
        };
        let connection = managed_session_connection(&settings);
        assert_eq!(connection["profileId"], "aggregate");
        assert_eq!(connection["provider"], "codex_plus_managed");
        assert_eq!(
            connection["baseUrl"],
            crate::protocol_proxy::local_responses_proxy_base_url(
                crate::protocol_proxy::protocol_proxy_port()
            )
        );
        assert_eq!(connection.as_object().unwrap().len(), 3);
        // 模型聚合开关、故障转移策略及默认选择不改变本地会话连接地址。
        settings.aggregate_relay_profiles[0].model_aggregation_enabled = false;
        settings.aggregate_relay_profiles[0].strategy =
            crate::settings::AggregateRelayStrategy::Failover;
        settings.aggregate_relay_profiles[0].default_relay_id = "new-default".to_string();
        settings.relay_profiles[0].model = "new-model".to_string();
        assert_eq!(managed_session_connection(&settings), connection);
        settings.aggregate_relay_profiles[0].sync_default_member_login = true;
        assert!(managed_session_connection(&settings).is_null());
        settings.aggregate_relay_profiles[0].sync_default_member_login = false;
        settings.aggregate_relay_profiles[0].session_provider = RelaySessionProvider::Openai;
        assert!(managed_session_connection(&settings).is_null());
        settings.aggregate_relay_profiles[0].session_provider = RelaySessionProvider::Custom;
        settings.relay_profiles_enabled = false;
        assert!(managed_session_connection(&settings).is_null());
    }

    #[test]
    fn settings_bridge_preserves_session_share_choice_for_renderer_master_gating() {
        for enabled in [false, true] {
            let settings = BackendSettings {
                codex_app_session_share: enabled,
                enhancements_enabled: false,
                ..BackendSettings::default()
            };
            let result = settings_payload_value(settings, String::new()).unwrap();
            assert_eq!(result["codexAppSessionShare"], enabled);
            assert_eq!(result["enhancementsEnabled"], false);
        }
    }

    #[test]
    fn dictation_settings_bridge_removes_asr_key() {
        let mut settings = BackendSettings::default();
        settings.dictation.api_key = "fake-asr-private-key".to_string();
        let result = settings_payload_value(settings, String::new()).unwrap();
        assert!(result["dictation"].get("apiKey").is_none());
        assert_eq!(result["dictation"]["apiKeyConfigured"], true);
        assert!(!result.to_string().contains("fake-asr-private-key"));
    }

    #[test]
    fn settings_bridge_never_returns_named_key_lists() {
        let mut settings = BackendSettings::default();
        settings.relay_profiles[0].api_keys = vec![crate::settings::RelayApiKey {
            id: "backup".into(),
            name: "备用".into(),
            api_key: "fake-backup-secret".into(),
        }];
        let result = settings_payload_value(settings, String::new()).unwrap();
        assert!(result["relayProfiles"][0].get("apiKeys").is_none());
        assert!(!result.to_string().contains("fake-backup-secret"));
    }

    #[test]
    fn renderer_settings_allow_only_public_fields_and_provider_identity() {
        let mut settings = BackendSettings::default();
        settings.weixin_connect_token = "synthetic-weixin-secret".into();
        settings.relay_context_config_contents = "synthetic-context-secret".into();
        settings.relay_profiles[0].auth_contents = r#"{"tokens":{"access_token":"synthetic-access-secret","refresh_token":"synthetic-refresh-secret"}}"#.into();
        settings.relay_profiles[0].config_contents = "model_provider = 'local_vendor'\n[model_providers.local_vendor]\nexperimental_bearer_token = 'synthetic-config-secret'".into();
        settings.relay_profiles[0].custom_headers = vec![crate::settings::RelayHeaderKeyValue {
            key: "Authorization".into(),
            value: "Bearer synthetic-header-secret".into(),
        }];
        settings.prompt_enhance.api_key = "synthetic-prompt-secret".into();
        let mut tool = crate::tools::ToolConfig::default();
        tool.relay_profiles[0].auth_contents = "synthetic-tool-secret".into();
        settings.tools.insert(crate::tools::ToolId::Grok, tool);
        let value = settings_payload_value(settings, String::new()).unwrap();
        let text = value.to_string();
        assert!(!text.contains("synthetic-"), "{text}");
        assert!(value.get("tools").is_none());
        assert!(value.get("weixinConnectToken").is_none());
        let profile = &value["relayProfiles"][0];
        assert!(profile.get("authContents").is_none());
        assert_eq!(
            profile["configContents"],
            "model_provider = \"local_vendor\"\n"
        );
        assert_eq!(value["promptEnhance"]["apiKeyConfigured"], true);
    }
    #[test]
    fn dictation_settings_bridge_applies_enhancement_switch_without_mutating_settings() {
        let mut settings = BackendSettings::default();
        settings.enhancements_enabled = false;
        settings.dictation.enabled = true;
        settings.dictation.api_key = "fake-asr-private-key".to_string();
        let result = settings_payload_value(settings.clone(), String::new()).unwrap();
        assert_eq!(result["dictation"]["enabled"], false);
        assert_eq!(result["dictation"]["apiKeyConfigured"], true);
        assert!(settings.dictation.enabled);
        assert_eq!(settings.dictation.api_key, "fake-asr-private-key");
    }

    #[test]
    fn prompt_enhance_settings_bridge_removes_key() {
        let mut settings = BackendSettings::default();
        settings.prompt_enhance.enabled = true;
        settings.prompt_enhance.api_key = "fake-enhance-private-key".to_string();
        let result = settings_payload_value(settings, String::new()).unwrap();
        assert_eq!(result["promptEnhance"]["enabled"], true);
        assert_eq!(result["promptEnhance"]["apiKeyConfigured"], true);
        assert!(!result.to_string().contains("fake-enhance-private-key"));
    }
}

async fn settings_value(
    ctx: &BridgeContext,
    result: anyhow::Result<BackendSettings>,
) -> anyhow::Result<Value> {
    let settings = result?;
    let codex_app_version = ctx.settings.codex_app_version().await.unwrap_or_default();
    settings_payload_value(settings, codex_app_version)
}

fn relay_api_keys_value(
    result: anyhow::Result<BackendSettings>,
    live_api_key: Option<String>,
) -> anyhow::Result<Value> {
    let settings = result?;
    let profile = settings.active_relay_profile();
    let mut keys = profile
        .api_keys
        .iter()
        .map(|entry| json!({ "id": entry.id, "name": entry.name }))
        .collect::<Vec<_>>();
    let active_key_id =
        if keys.is_empty() && !crate::relay_config::relay_profile_api_key(&profile).is_empty() {
            keys.push(json!({ "id": "default", "name": "默认" }));
            "default".to_string()
        } else {
            profile.active_api_key_id.clone()
        };
    // 总开关关闭时 live 才是事实来源：存档里的 activeApiKeyId 可能停在"最后添加的 Key"，
    // 而 Codex 实际还在用另一个。能匹配上就显示匹配到的那个。
    // live 读不到时（后端实现不提供）不算"未匹配"，不要骗前端去报警。
    let live_match = live_api_key.as_deref().map(|live| {
        let matched = live_matched_api_key_id(&profile, live, &active_key_id);
        let id = matched.clone().unwrap_or_else(|| active_key_id.clone());
        (id, matched.is_some())
    });
    let active_key_id = live_match
        .as_ref()
        .map(|(id, _)| id.clone())
        .unwrap_or(active_key_id);
    let mut value = json!({
        "status": "ok",
        "enabled": settings.relay_profiles_enabled,
        "providerId": profile.id,
        "providerName": profile.name,
        "activeKeyId": active_key_id,
        "keys": keys
    });
    if let Some((_, matched)) = live_match
        && let Some(object) = value.as_object_mut()
    {
        object.insert("liveKeyMatched".to_string(), json!(matched));
    }
    Ok(value)
}

/// live 里的 Key 对应哪一个命名 Key；匹配不上返回 None（由调用方回退到存档的目标项）。
fn live_matched_api_key_id(
    profile: &crate::settings::RelayProfile,
    live_api_key: &str,
    active_key_id: &str,
) -> Option<String> {
    let live = live_api_key.trim();
    if live.is_empty() {
        return None;
    }
    if let Some(entry) = profile
        .api_keys
        .iter()
        .find(|entry| entry.api_key.trim() == live)
    {
        return Some(entry.id.clone());
    }
    // 没有命名 Key 的旧配置：live 与供应商 Key 一致时，目标项就是它。
    let single = crate::relay_config::relay_profile_api_key(profile);
    (profile.api_keys.is_empty() && single.trim() == live).then(|| active_key_id.to_string())
}

async fn select_relay_api_key_value(ctx: &BridgeContext, key_id: String) -> anyhow::Result<Value> {
    static SWITCH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = SWITCH_LOCK
        .try_lock()
        .map_err(|_| anyhow::anyhow!("Key 正在切换，请稍后重试"))?;
    let settings = ctx.settings.select_relay_api_key(key_id).await?;
    let expected_key = crate::relay_config::relay_profile_api_key(&settings.active_relay_profile());
    let runtime_applied = match ctx
        .settings
        .runtime_api_key()
        .await
        .filter(|key| key == &expected_key)
    {
        Some(api_key) => ctx.runtime.reload_api_key(&api_key).await.is_ok(),
        None => false,
    };
    let mut value = relay_api_key_selection_value(Ok(settings))?;
    value["runtimeApplied"] = json!(runtime_applied);
    value["message"] = json!(if runtime_applied {
        "Key 已切换，后续请求使用新 Key"
    } else {
        "Key 已保存，运行中的认证未更新，请完整退出并重新打开 Codex"
    });
    Ok(value)
}

fn relay_api_key_selection_value(result: anyhow::Result<BackendSettings>) -> anyhow::Result<Value> {
    let settings = result?;
    let profile = settings.active_relay_profile();
    Ok(json!({
        "status": "ok",
        "providerId": profile.id,
        "providerName": profile.name,
        "activeKeyId": profile.active_api_key_id
    }))
}

fn backend_status_value(
    status: anyhow::Result<Value>,
    settings: anyhow::Result<BackendSettings>,
) -> anyhow::Result<Value> {
    let mut status = status?;
    if let Some(object) = status.as_object_mut() {
        let hide = settings
            .map(|settings| crate::assets::hide_official_usage_alert_config(&settings))
            .unwrap_or(false);
        object.insert("hideOfficialUsageAlert".to_string(), Value::Bool(hide));
    }
    Ok(status)
}

fn result_value<T>(result: anyhow::Result<T>) -> anyhow::Result<Value>
where
    T: serde::Serialize,
{
    Ok(serde_json::to_value(result?)?)
}

fn stepwise_settings_value(result: anyhow::Result<BackendSettings>) -> anyhow::Result<Value> {
    let settings = result?;
    Ok(json!({
        "status": "ok",
        "settings": crate::stepwise::public_settings(&settings),
    }))
}

async fn stepwise_generate_value(
    result: anyhow::Result<BackendSettings>,
    payload: Value,
) -> anyhow::Result<Value> {
    let settings = result?;
    let request = payload.get("request").cloned().unwrap_or(payload);
    let request =
        serde_json::from_value::<crate::stepwise::StepwiseRequest>(request).unwrap_or_default();
    crate::stepwise::generate(request, &settings).await
}

async fn stepwise_test_value(
    result: anyhow::Result<BackendSettings>,
    payload: Value,
) -> anyhow::Result<Value> {
    let settings = crate::stepwise::settings_with_payload(result?, &payload);
    crate::stepwise::test_connection(&settings).await
}

async fn llm_proxy_value(payload: Value) -> anyhow::Result<Value> {
    let url = validate_llm_proxy_url(
        payload
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )?;
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("POST");
    if !method.eq_ignore_ascii_case("POST") {
        anyhow::bail!("LLM Bridge 仅支持 POST 请求");
    }

    let timeout_ms = payload
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(60_000)
        .clamp(1_000, 60_000);
    let body = payload
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if body.len() > 1_048_576 {
        anyhow::bail!("LLM Bridge 请求体过大");
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let response = client
        .post(url)
        .headers(llm_proxy_headers(&payload)?)
        .body(body)
        .send()
        .await?;
    let http_status = response.status().as_u16();
    let ok = response.status().is_success();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    if let Some(length) = response.content_length() {
        if length > 4 * 1024 * 1024 {
            anyhow::bail!("LLM Bridge 响应体过大");
        }
    }
    let bytes = response.bytes().await?;
    if bytes.len() > 4 * 1024 * 1024 {
        anyhow::bail!("LLM Bridge 响应体过大");
    }
    let body_text = String::from_utf8_lossy(&bytes).to_string();
    let body_json = if content_type
        .split(';')
        .next()
        .map(str::trim)
        .is_some_and(|value| value.eq_ignore_ascii_case("application/json"))
    {
        serde_json::from_slice::<Value>(&bytes).ok()
    } else {
        None
    };

    Ok(json!({
        "status": "ok",
        "http_status": http_status,
        "ok": ok,
        "body_text": body_text,
        "body_json": body_json,
    }))
}

fn validate_llm_proxy_url(raw: &str) -> anyhow::Result<reqwest::Url> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| anyhow::anyhow!("Base URL 格式无效"))?;
    if url.scheme() != "https" {
        anyhow::bail!("Base URL 必须使用 HTTPS");
    }
    if !url.username().is_empty() || url.password().is_some() {
        anyhow::bail!("Base URL 不得包含用户名或密码");
    }
    let host = url
        .host_str()
        .ok_or_else(|| anyhow::anyhow!("Base URL 缺少主机名"))?;
    if is_blocked_llm_proxy_host(host) {
        anyhow::bail!("Base URL 不得指向本机或私有网络");
    }
    Ok(url)
}

fn is_blocked_llm_proxy_host(host: &str) -> bool {
    let host = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
    {
        return true;
    }
    if let Ok(ip) = std::net::IpAddr::from_str(&host) {
        return match ip {
            std::net::IpAddr::V4(ip) => {
                ip.is_loopback()
                    || ip.is_private()
                    || ip.is_link_local()
                    || ip.is_multicast()
                    || ip.is_broadcast()
                    || ip.is_documentation()
                    || ip.octets()[0] == 0
                    || ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1])
            }
            std::net::IpAddr::V6(ip) => {
                ip.is_loopback()
                    || ip.is_unspecified()
                    || ip.is_multicast()
                    || (ip.segments()[0] & 0xfe00) == 0xfc00
                    || (ip.segments()[0] & 0xffc0) == 0xfe80
            }
        };
    }
    false
}

fn llm_proxy_headers(payload: &Value) -> anyhow::Result<HeaderMap> {
    let mut headers = HeaderMap::new();
    let Some(raw_headers) = payload.get("headers").and_then(Value::as_object) else {
        return Ok(headers);
    };
    for (name, value) in raw_headers {
        if !is_allowed_llm_proxy_header(name) {
            continue;
        }
        let Some(value) = value.as_str() else {
            continue;
        };
        let header_name = HeaderName::from_bytes(name.as_bytes())?;
        let header_value = HeaderValue::from_str(value)?;
        headers.insert(header_name, header_value);
    }
    Ok(headers)
}

fn is_allowed_llm_proxy_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept"
            | "api-key"
            | "anthropic-beta"
            | "anthropic-version"
            | "authorization"
            | "content-type"
            | "openai-organization"
            | "openai-project"
            | "x-api-key"
    )
}

fn diagnostic_log_value(payload: Value) -> anyhow::Result<Value> {
    let event = payload
        .get("event")
        .and_then(Value::as_str)
        .map(sanitize_diagnostic_event)
        .unwrap_or_else(|| "event".to_string());
    crate::diagnostic_log::append_diagnostic_log(&format!("renderer.{event}"), payload)?;
    Ok(json!({
        "status": "ok",
        "message": "日志已记录"
    }))
}

fn sanitize_diagnostic_event(event: &str) -> String {
    let sanitized = event
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "event".to_string()
    } else {
        sanitized
    }
}

fn archived_thread_value(result: anyhow::Result<Option<SessionRef>>) -> anyhow::Result<Value> {
    Ok(match result? {
        Some(session) => json!({"session_id": session.session_id, "title": session.title}),
        None => json!({"session_id": "", "title": ""}),
    })
}

fn failed_from_error(payload: &Value, error: anyhow::Error) -> Value {
    json!({
        "status": "failed",
        "session_id": payload
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "message": error.to_string()
    })
}

fn session_from_payload(payload: &Value) -> SessionRef {
    let parse_host = |value: &Value| {
        value
            .as_str()
            .map(str::trim)
            .filter(|host| !host.is_empty())
            .map(ToString::to_string)
    };
    // 双名称不一致同样属于未知来源，不能通过优先读取某个字段放宽归属。
    let host_id = match (payload.get("host_id"), payload.get("hostId")) {
        (Some(left), Some(right)) => {
            let left = parse_host(left);
            let right = parse_host(right);
            if left == right { left } else { None }
        }
        (Some(value), None) | (None, Some(value)) => parse_host(value),
        _ => None,
    };
    SessionRef {
        session_id: payload
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        title: payload
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        host_id,
    }
}

pub fn devtools_url(debug_port: u16, target_id: &str) -> String {
    format!(
        "http://127.0.0.1:{debug_port}/devtools/inspector.html?ws=127.0.0.1:{debug_port}/devtools/page/{target_id}"
    )
}

fn empty_user_script_inventory() -> Value {
    json!({
        "enabled": true,
        "scripts": []
    })
}

#[cfg(test)]
mod dictation_bridge_route_tests {
    use super::*;

    struct IsolatedSettings(BackendSettings);

    #[async_trait]
    impl BridgeSettingsService for IsolatedSettings {
        async fn get_settings(&self) -> anyhow::Result<BackendSettings> {
            Ok(self.0.clone())
        }
        async fn set_settings(&self, _payload: Value) -> anyhow::Result<BackendSettings> {
            anyhow::bail!("test settings are read-only")
        }
    }

    fn context() -> BridgeContext {
        BridgeContext::new(
            Arc::new(IsolatedSettings(BackendSettings::default())),
            Arc::new(CoreRuntimeService::new(
                0,
                StatusStore::new(PathBuf::from("unused-test-status.json")),
            )),
            Arc::new(UnavailableDataService),
        )
    }

    #[tokio::test]
    async fn dictation_bridge_routes_return_sanitized_failure_without_payload_echo() {
        for route in ["/dictation/transcribe", "/dictation/cancel"] {
            let result = handle_bridge_request(
                context(),
                route,
                json!({
                    "helperToken": "fake-secret-token",
                    "audioBase64": "fake-secret-audio",
                    "session_id": "fake-secret-session"
                }),
            )
            .await;
            assert_eq!(result["status"], "failed");
            assert_eq!(result["session_id"], "");
            assert!(!result.to_string().contains("fake-secret"));
            assert!(result["message"].as_str().unwrap().contains("未授权"));
        }
    }
}

#[cfg(test)]
mod prompt_tools_route_tests {
    use super::*;

    struct IsolatedSettings(PathBuf);
    #[async_trait]
    impl BridgeSettingsService for IsolatedSettings {
        async fn get_settings(&self) -> anyhow::Result<BackendSettings> {
            Ok(BackendSettings::default())
        }
        async fn set_settings(&self, _: Value) -> anyhow::Result<BackendSettings> {
            anyhow::bail!("只读")
        }
        fn prompt_tools_path(&self) -> PathBuf {
            self.0.clone()
        }
    }

    #[tokio::test]
    async fn prompt_tools_routes_share_storage_and_never_echo_invalid_content() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("tools.sqlite3");
        let ctx = BridgeContext::new(
            Arc::new(IsolatedSettings(database.clone())),
            Arc::new(CoreRuntimeService::new(
                0,
                StatusStore::new(dir.path().join("status.json")),
            )),
            Arc::new(UnavailableDataService),
        );
        let saved = handle_bridge_request(
            ctx.clone(),
            "/prompt-enhance/library/save",
            json!({"title":"标题","body":"正文"}),
        )
        .await;
        assert_eq!(saved["status"], "ok");
        let list = crate::prompt_enhance::store::execute(&database, "library/list", json!({}));
        assert_eq!(list["favorites"][0]["id"], saved["favorite"]["id"]);
        let response = handle_bridge_request(
            ctx,
            "/prompt-enhance/feedback/save",
            json!({"original":"private-draft","apiKey":"private-key"}),
        )
        .await;
        assert_eq!(response["status"], "failed");
        assert!(!response.to_string().contains("private-"));
        let extension = include_str!("../../../assets/inject/renderer-inject/91-extension-api.js");
        let allowed = extension
            .split("const codexPlusExtensionRoutes = new Set([")
            .nth(1)
            .unwrap()
            .split("]);")
            .next()
            .unwrap();
        assert!(!allowed.contains("prompt-enhance"));
    }
}

#[cfg(test)]
mod dictation_disabled_route_tests {
    use super::*;
    struct DisabledSettings;
    #[async_trait]
    impl BridgeSettingsService for DisabledSettings {
        async fn get_settings(&self) -> anyhow::Result<BackendSettings> {
            Ok(BackendSettings {
                enhancements_enabled: false,
                dictation: crate::settings::DictationSettings {
                    enabled: true,
                    api_key: "fake-asr-key".into(),
                    ..Default::default()
                },
                ..Default::default()
            })
        }
        async fn set_settings(&self, _payload: Value) -> anyhow::Result<BackendSettings> {
            anyhow::bail!("read-only test")
        }
    }
    #[tokio::test]
    async fn dictation_bridge_disables_status_and_transcribe_when_enhancements_are_off() {
        let ctx = BridgeContext::new(
            Arc::new(DisabledSettings),
            Arc::new(CoreRuntimeService::new(
                0,
                StatusStore::new(PathBuf::from("unused-test-status.json")),
            )),
            Arc::new(UnavailableDataService),
        );
        let status = handle_bridge_request(ctx.clone(), "/dictation/status", json!({})).await;
        assert_eq!(status["enabled"], false);
        assert!(status.get("helperToken").is_none());
        let response = handle_bridge_request(ctx, "/dictation/transcribe", json!({
            "requestId": uuid::Uuid::new_v4().to_string(), "helperToken": crate::dictation::helper_token(), "audioBase64": "AA==", "mimeType": "audio/wav"
        })).await;
        assert_eq!(response["status"], "failed");
        assert!(response["message"].as_str().unwrap().contains("未启用"));
    }
}
