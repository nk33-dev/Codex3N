use super::*;

impl DefaultLaunchHooks {
    // 固有方法保留 Send future，供宿主恢复通道和 ?Send 的 LaunchHooks 共用。
    pub(super) async fn start_helper_runtime(&self, helper_port: u16) -> anyhow::Result<()> {
        if crate::resident_helper::resident_helper_port() == Some(helper_port) {
            return Ok(());
        }
        let bind_host = helper_bind_host();
        let listener = tokio::net::TcpListener::bind((bind_host.as_str(), helper_port))
            .await
            .with_context(|| {
                format!("failed to bind helper runtime on {bind_host}:{helper_port}")
            })?;
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "helper.listening",
            serde_json::json!({
                "helper_port": helper_port,
                "bind_host": bind_host,
                "address": format!("http://{bind_host}:{helper_port}")
            }),
        );
        // 端口绑定成功后立刻落凭据：Claude 汉化注入的 hook 靠它调用听写路由。
        write_dictation_helper_receipt(helper_port);
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        if let Ok((stream, addr)) = accepted {
                            tokio::spawn(async move {
                                let _ = handle_helper_connection(stream, Some(addr)).await;
                            });
                        }
                    }
                }
            }
        });
        *self.helper.lock().await = Some(HelperRuntime {
            shutdown: shutdown_tx,
            task,
        });
        Ok(())
    }

    pub(super) async fn start_bridge_watchdog_runtime(
        &self,
        debug_port: u16,
        helper_port: u16,
    ) -> anyhow::Result<()> {
        let bridge_reinjector = self.bridge_reinjector.lock().await.clone();
        let (shutdown, mut shutdown_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            #[cfg(any(windows, target_os = "macos"))]
            let pet_cursor_task = tokio::spawn(run_pet_real_mouse_cursor_driver(debug_port));
            let mut observed_browser_id: Option<String> = None;
            let mut bridge_health_failures = 0u8;
            let mut bridge_reinject_backoff = BridgeReinjectBackoff::default();
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    _ = interval.tick() => {
                        let current_browser_id = match crate::cdp::browser_identity(debug_port).await {
                            Ok(identity) => identity.browser_id().ok(),
                            Err(_) => None,
                        };
                        let identity_changed = current_browser_id
                            .as_deref()
                            .is_some_and(|current| {
                                browser_identity_changed(observed_browser_id.as_deref(), current)
                            });
                        if let Some(current) = current_browser_id {
                            observed_browser_id = Some(current);
                        }
                        let (pet_result, _) = tokio::join!(
                            sync_pet_real_mouse_overlay(debug_port, helper_port),
                            check_and_reinject_bridge_inner(
                                debug_port,
                                helper_port,
                                identity_changed,
                                bridge_reinjector.clone(),
                                &mut bridge_health_failures,
                                &mut bridge_reinject_backoff,
                            ),
                        );
                        record_pet_overlay_sync_result(debug_port, helper_port, pet_result);
                    }
                }
            }
            #[cfg(any(windows, target_os = "macos"))]
            {
                pet_cursor_task.abort();
                let _ = pet_cursor_task.await;
            }
        });
        if let Some(runtime) = self
            .bridge_watchdog
            .lock()
            .await
            .replace(BridgeWatchdogRuntime { shutdown, task })
        {
            let _ = runtime.shutdown.send(());
            let _ = runtime.task.await;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopped_helper_is_restored_without_duplicating_services() {
        const CHILD: &str = "CODEX_PLUS_RECOVERY_SERVICE_TEST";
        if std::env::var_os(CHILD).is_none() {
            let temp = tempfile::tempdir().unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "launcher::backend_services::tests::stopped_helper_is_restored_without_duplicating_services", "--nocapture"])
                .env(CHILD, "1")
                .env(crate::paths::STATE_DIR_ENV, temp.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let hooks = DefaultLaunchHooks::default();
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            hooks.ensure_backend_services(0, port).await.unwrap();
            let first_helper = hooks.helper.lock().await.as_ref().unwrap().task.id();
            let first_watchdog = hooks
                .bridge_watchdog
                .lock()
                .await
                .as_ref()
                .unwrap()
                .task
                .id();
            hooks.ensure_backend_services(0, port).await.unwrap();
            assert_eq!(
                hooks.helper.lock().await.as_ref().unwrap().task.id(),
                first_helper
            );
            let stopped = hooks.helper.lock().await.take().unwrap();
            stopped.task.abort();
            let _ = stopped.task.await;
            hooks.ensure_backend_services(0, port).await.unwrap();
            assert_ne!(
                hooks.helper.lock().await.as_ref().unwrap().task.id(),
                first_helper
            );
            assert_eq!(
                hooks
                    .bridge_watchdog
                    .lock()
                    .await
                    .as_ref()
                    .unwrap()
                    .task
                    .id(),
                first_watchdog
            );
            let payload = reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .post(format!("http://127.0.0.1:{port}/backend/status"))
                .json(&serde_json::json!({}))
                .send()
                .await
                .unwrap()
                .json::<Value>()
                .await
                .unwrap();
            assert_eq!(payload["status"], "ok");
            hooks.shutdown_helper(port).await;
        });
    }
}
