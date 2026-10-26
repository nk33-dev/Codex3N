use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use codex_plus_core::launcher::{BridgeReinjector, LaunchOptions, reinject_backoff_delay};
use serde_json::{Value, json};

#[derive(Clone)]
pub(super) struct Target {
    pub instance: String,
    pub browser_id: String,
    pub options: LaunchOptions,
    handle: tokio::runtime::Handle,
    repair: BridgeReinjector,
}

#[derive(Default)]
struct Progress {
    attempts: u32,
    next_allowed: Option<Instant>,
    result: Option<Value>,
    last_attempt: Option<Instant>,
    instance: String,
    healthy_since: Option<Instant>,
}

pub(super) struct Controller {
    config: Value,
    target: Mutex<Option<Target>>,
    progress: tokio::sync::Mutex<Progress>,
    commands: tokio::sync::mpsc::UnboundedSender<super::RuntimeCommand>,
}

impl Controller {
    pub async fn supervise(self: Arc<Self>) {
        let mut installed: Option<(String, tokio::task::JoinHandle<()>)> = None;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let target = self
                .target
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let Some(target) = target else {
                if let Some((_, task)) = installed.take() {
                    task.abort();
                }
                continue;
            };
            if installed
                .as_ref()
                .is_some_and(|(instance, task)| instance == &target.instance && !task.is_finished())
            {
                continue;
            }
            if validate_target(&target).await.is_err() {
                continue;
            }
            let Ok(targets) = codex_plus_core::cdp::list_targets(target.options.debug_port).await
            else {
                continue;
            };
            let Ok(page) = codex_plus_core::cdp::pick_injectable_codex_page_target(&targets) else {
                continue;
            };
            let Some(url) = page.web_socket_debugger_url.as_deref() else {
                continue;
            };
            let controller = self.clone();
            let token = self.config["token"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let handler = Arc::new(move |path: String, payload: Value| {
                let controller = controller.clone();
                let token = token.clone();
                Box::pin(async move {
                    if payload.to_string().len() > 1024
                        || payload["token"].as_str() != Some(token.as_str())
                        || !matches!(path.as_str(), "/status" | "/reconnect")
                    {
                        return Ok(json!({"status":"failed","message":"恢复请求不可用"}));
                    }
                    controller.request(&path, payload).await
                })
                    as std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send>>
            });
            if let Ok(task) = codex_plus_core::bridge::install_recovery_bridge(url, handler).await {
                if let Some((_, previous)) = installed.replace((target.instance, task)) {
                    previous.abort();
                }
            }
        }
    }

    pub fn new(
        config: Value,
        commands: tokio::sync::mpsc::UnboundedSender<super::RuntimeCommand>,
    ) -> Self {
        Self {
            config,
            target: Mutex::new(None),
            progress: tokio::sync::Mutex::new(Progress::default()),
            commands,
        }
    }

    pub fn bind(
        &self,
        options: LaunchOptions,
        browser_id: String,
        repair: BridgeReinjector,
    ) -> Value {
        let mut target = self.target.lock().unwrap_or_else(|e| e.into_inner());
        let instance = target
            .as_ref()
            .filter(|target| target.browser_id == browser_id)
            .map(|target| target.instance.clone())
            .unwrap_or_else(|| codex_plus_core::recovery::new_instance_id());
        *target = Some(Target {
            instance: instance.clone(),
            browser_id,
            options,
            handle: tokio::runtime::Handle::current(),
            repair,
        });
        let mut config = self.config.clone();
        config["instance"] = json!(instance);
        config
    }

    pub fn clear(&self) {
        *self.target.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    pub fn current(&self, instance: &str) -> Option<Target> {
        self.target
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .filter(|target| target.instance == instance)
            .cloned()
    }

    pub async fn request(&self, path: &str, payload: Value) -> Result<Value> {
        let instance = payload["instance"].as_str().unwrap_or_default();
        let Some(target) = self.current(instance) else {
            return Ok(
                json!({"status":"failed","message":"受管实例已结束，请从 Codex3N 重新连接"}),
            );
        };
        let Ok(mut progress) = self.progress.try_lock() else {
            return Ok(json!({"status":"recovering","message":"正在重连"}));
        };
        if progress.instance != instance {
            *progress = Progress {
                instance: instance.to_string(),
                ..Default::default()
            };
        }
        if path == "/status" {
            if payload["connected"] == true {
                let since = *progress.healthy_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= Duration::from_secs(60) {
                    progress.attempts = 0;
                    progress.next_allowed = None;
                }
            } else {
                progress.healthy_since = None;
            }
            return Ok(progress
                .result
                .clone()
                .unwrap_or_else(|| json!({"status":"idle"})));
        }
        let manual = payload["manual"].as_bool().unwrap_or(false);
        let now = Instant::now();
        if !manual && progress.next_allowed.is_some_and(|deadline| now < deadline) {
            return Ok(json!({
                "status":"cooldown",
                "message":"等待自动重试",
                "retryAfterMs": progress.next_allowed.unwrap().saturating_duration_since(now).as_millis() as u64
            }));
        }
        // 一轮恢复结束后也保留短暂合并窗口，避免重注入前的连续点击重复修复。
        if manual
            && progress.result.is_some()
            && progress
                .last_attempt
                .is_some_and(|at| now.saturating_duration_since(at) < Duration::from_secs(1))
        {
            return Ok(progress.result.clone().unwrap());
        }
        progress.next_allowed = Some(now + reinject_backoff_delay(progress.attempts));
        progress.last_attempt = Some(now);
        progress.healthy_since = None;
        progress.attempts = progress.attempts.saturating_add(1);
        let result = self.repair(target.clone()).await;
        if self.current(instance).is_none() {
            return Ok(json!({"status":"failed","message":"受管实例已变化，请重试"}));
        }
        let result = match result {
            Ok(()) => json!({"status":"ok","message":"正在确认连接"}),
            Err(error) => {
                let _ = codex_plus_core::diagnostic_log::append_diagnostic_log(
                    "recovery.failed",
                    json!({"message":error.to_string()}),
                );
                json!({"status":"failed","message":"无法恢复连接，请确认官方 App 仍在运行后重试"})
            }
        };
        progress.result = Some(result.clone());
        Ok(result)
    }

    async fn repair(&self, target: Target) -> Result<()> {
        validate_target(&target).await?;
        match target.handle.spawn((target.repair)()).await {
            Ok(result) => result,
            Err(error) if error.is_cancelled() => {
                // session 线程已结束，宿主线程仍在；只附加同一个浏览器实例。
                let (reply, result) = std::sync::mpsc::channel();
                self.commands
                    .send(super::RuntimeCommand::Recover(target, reply))?;
                tokio::task::spawn_blocking(move || result.recv())
                    .await?
                    .context("恢复后台服务未返回结果")?
            }
            Err(error) => Err(error.into()),
        }
    }
}

pub(super) async fn validate_browser(debug_port: u16, expected: &str) -> Result<()> {
    let identity = codex_plus_core::cdp::browser_identity(debug_port).await?;
    anyhow::ensure!(identity.browser_id()? == expected, "Codex 实例身份已变化");
    let targets = codex_plus_core::cdp::list_targets(debug_port).await?;
    codex_plus_core::cdp::pick_injectable_codex_page_target(&targets)?;
    Ok(())
}

pub(super) async fn validate_target(target: &Target) -> Result<()> {
    validate_browser(target.options.debug_port, &target.browser_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn cdp_fixture() -> (u16, Arc<Mutex<String>>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let identity = Arc::new(Mutex::new("original-browser".to_string()));
        let current = identity.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let current = current.clone();
                tokio::spawn(async move {
                    let mut bytes = [0; 4096];
                    let size = socket.read(&mut bytes).await.unwrap();
                    let request = String::from_utf8_lossy(&bytes[..size]);
                    let body = if request.starts_with("GET /json/version") {
                        json!({"Browser":"Chrome/130","webSocketDebuggerUrl":format!("ws://127.0.0.1:{port}/devtools/browser/{}", current.lock().unwrap())})
                    } else {
                        json!([{"id":"page","type":"page","url":"app://-/index.html","title":"ChatGPT","webSocketDebuggerUrl":format!("ws://127.0.0.1:{port}/devtools/page/page")}])
                    }.to_string();
                    socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                });
            }
        });
        (port, identity, task)
    }

    fn controller() -> (
        Arc<Controller>,
        tokio::sync::mpsc::UnboundedReceiver<super::super::RuntimeCommand>,
    ) {
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel();
        (Arc::new(Controller::new(json!({}), sender)), receiver)
    }

    #[tokio::test]
    async fn simultaneous_recovery_requests_share_one_attempt_and_manual_bypasses_backoff() {
        let (port, _, server) = cdp_fixture().await;
        let (controller, _) = controller();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let release = Arc::new(tokio::sync::Notify::new());
        let wait = release.clone();
        let config = controller.bind(
            LaunchOptions {
                debug_port: port,
                ..Default::default()
            },
            "original-browser".into(),
            Arc::new(move || {
                let count = count.clone();
                let wait = wait.clone();
                Box::pin(async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    wait.notified().await;
                    Ok(())
                })
            }),
        );
        let payload = json!({"instance":config["instance"]});
        let first = {
            let controller = controller.clone();
            let payload = payload.clone();
            tokio::spawn(async move { controller.request("/reconnect", payload).await.unwrap() })
        };
        while calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            controller
                .request(
                    "/reconnect",
                    json!({"instance":config["instance"],"manual":true})
                )
                .await
                .unwrap()["status"],
            "recovering"
        );
        release.notify_one();
        assert_eq!(first.await.unwrap()["status"], "ok");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            controller
                .request("/reconnect", payload.clone())
                .await
                .unwrap()["status"],
            "cooldown"
        );
        {
            let mut progress = controller.progress.lock().await;
            progress.last_attempt = Some(Instant::now() - Duration::from_secs(2));
        }
        release.notify_one();
        assert_eq!(
            controller
                .request(
                    "/reconnect",
                    json!({"instance":config["instance"],"manual":true})
                )
                .await
                .unwrap()["status"],
            "ok"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        controller.clear();
        assert_eq!(
            controller.request("/reconnect", payload).await.unwrap()["status"],
            "failed"
        );
        server.abort();
    }

    #[tokio::test]
    async fn browser_replacement_is_rejected_before_any_repair() {
        let (port, identity, server) = cdp_fixture().await;
        let (controller, _) = controller();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let config = controller.bind(
            LaunchOptions {
                debug_port: port,
                ..Default::default()
            },
            "original-browser".into(),
            Arc::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(()) })
            }),
        );
        *identity.lock().unwrap() = "replacement-browser".into();
        let result = controller
            .request("/reconnect", json!({"instance":config["instance"]}))
            .await
            .unwrap();
        assert_eq!(result["status"], "failed");
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        server.abort();
    }

    #[tokio::test]
    async fn ended_session_dispatches_attach_only_recovery_with_original_ports() {
        let (port, _, server) = cdp_fixture().await;
        let (controller, mut commands) = controller();
        let config = controller.bind(
            LaunchOptions {
                debug_port: port,
                helper_port: 54321,
                ..Default::default()
            },
            "original-browser".into(),
            Arc::new(|| Box::pin(async { Ok(()) })),
        );
        let stopped_handle = std::thread::spawn(|| {
            let runtime = tokio::runtime::Runtime::new().unwrap();
            runtime.handle().clone()
        })
        .join()
        .unwrap();
        controller.target.lock().unwrap().as_mut().unwrap().handle = stopped_handle;
        let request = {
            let controller = controller.clone();
            tokio::spawn(async move {
                controller
                    .request("/reconnect", json!({"instance":config["instance"]}))
                    .await
                    .unwrap()
            })
        };
        let Some(super::super::RuntimeCommand::Recover(target, reply)) = commands.recv().await
        else {
            panic!("expected attach-only recovery");
        };
        assert_eq!(target.options.debug_port, port);
        assert_eq!(target.options.helper_port, 54321);
        reply.send(Ok(())).unwrap();
        assert_eq!(request.await.unwrap()["status"], "ok");
        server.abort();
    }
}
