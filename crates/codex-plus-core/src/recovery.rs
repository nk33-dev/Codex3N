use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub type RecoveryHandler = crate::bridge::BridgeHandler;

pub fn new_instance_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

pub(crate) fn bridge_script() -> &'static str {
    r#"(() => {
  if (window.top !== window || !/^app:\/\/-\//i.test(window.location.href)) return;
  const previous = window.__codexPlusRecoveryCallbacks;
  previous?.forEach(callback => { clearTimeout(callback.timer); callback.resolve({status:"recovering"}); });
  const callbacks = window.__codexPlusRecoveryCallbacks = new Map();
  const finish = (id, result) => {
    const callback = callbacks.get(id);
    if (!callback) return;
    callbacks.delete(id); clearTimeout(callback.timer); callback.resolve(result);
  };
  window.__codexPlusRecoveryResolve = finish;
  window.__codexPlusRecoveryReject = id => finish(id, {status:"failed",message:"恢复通道不可用，请重试"});
  window.__codexPlusRecoveryBridge = (path, payload) => new Promise(resolve => {
    if (!["/status","/reconnect"].includes(path) || callbacks.size >= 8) {
      resolve({status:"failed",message:"恢复请求不可用"}); return;
    }
    const id = String(window.__codexPlusRecoverySeq = (Number(window.__codexPlusRecoverySeq) || 0) + 1);
    const timer = setTimeout(() => finish(id, {status:"failed",message:"请打开 Codex3N 后重试"}), 45000);
    callbacks.set(id, {resolve,timer});
    try { window.codexPlusRecoveryV1(JSON.stringify({id,path,payload})); }
    catch { finish(id, {status:"failed",message:"请打开 Codex3N 后重试"}); }
  });
})()"#
}

/// 只在宿主进程内存中保存恢复凭据，不写入用户配置或诊断日志。
pub struct RecoveryEndpoint {
    listener: std::net::TcpListener,
    token: String,
}

impl RecoveryEndpoint {
    pub fn bind() -> Result<Self> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        Ok(Self {
            listener,
            token: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
        })
    }

    pub fn config(&self, instance: &str) -> Value {
        json!({
            "baseUrl": format!("http://127.0.0.1:{}", self.listener.local_addr().unwrap().port()),
            "token": self.token,
            "instance": instance,
        })
    }

    pub async fn serve(self, handler: RecoveryHandler) -> Result<()> {
        let listener = tokio::net::TcpListener::from_std(self.listener)?;
        let permits = Arc::new(tokio::sync::Semaphore::new(8));
        loop {
            let (stream, peer) = listener.accept().await?;
            let Ok(permit) = permits.clone().try_acquire_owned() else {
                continue;
            };
            let handler = handler.clone();
            let token = self.token.clone();
            tokio::spawn(async move {
                let _permit = permit;
                let _ = handle_connection(stream, peer, &token, handler).await;
            });
        }
    }
}

fn unique_header<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
    let mut values = headers.lines().skip(1).filter_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.eq_ignore_ascii_case(name).then_some(value.trim())
    });
    let value = values.next()?;
    values.next().is_none().then_some(value)
}

fn authorized(peer: std::net::SocketAddr, headers: &str, port: u16, token: &str) -> bool {
    let host = format!("127.0.0.1:{port}");
    let bearer = format!("Bearer {token}");
    peer.ip().is_loopback()
        && unique_header(headers, "Host") == Some(host.as_str())
        && unique_header(headers, "Authorization") == Some(bearer.as_str())
        && origin_allowed(headers)
}

fn origin_allowed(headers: &str) -> bool {
    let has_origin = headers.lines().skip(1).any(|line| {
        line.split_once(':')
            .is_some_and(|(key, _)| key.eq_ignore_ascii_case("Origin"))
    });
    !has_origin || unique_header(headers, "Origin") == Some("app://-")
}

async fn reply(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    body: Value,
    cors: bool,
) -> Result<()> {
    let body = if status == "204 No Content" {
        Vec::new()
    } else {
        serde_json::to_vec(&body)?
    };
    let cors = if cors {
        "Access-Control-Allow-Origin: app://-\r\nAccess-Control-Allow-Methods: POST, OPTIONS\r\nAccess-Control-Allow-Headers: Authorization, Content-Type\r\n"
    } else {
        ""
    };
    stream
        .write_all(format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\n{cors}Content-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        ).as_bytes())
        .await?;
    stream.write_all(&body).await?;
    stream.shutdown().await?;
    Ok(())
}

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    peer: std::net::SocketAddr,
    token: &str,
    handler: RecoveryHandler,
) -> Result<()> {
    let port = stream.local_addr()?.port();
    // 复用 helper 的帧解析，恢复请求另限为 8 KiB 和 2 秒。
    let request = tokio::time::timeout(Duration::from_secs(2), async {
        crate::launcher::read_http_request(&mut (&mut stream).take(8192)).await
    })
    .await;
    let Ok(Ok(request)) = request else {
        return reply(
            &mut stream,
            "400 Bad Request",
            json!({"status":"failed"}),
            false,
        )
        .await;
    };
    let headers = String::from_utf8_lossy(&request.headers);
    let mut parts = headers
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace();
    let method = parts.next().unwrap_or_default();
    let path = parts.next().unwrap_or_default();
    let route_allowed = matches!(path, "/status" | "/reconnect");
    if method == "OPTIONS" && peer.ip().is_loopback() && origin_allowed(&headers) && route_allowed {
        return reply(&mut stream, "204 No Content", Value::Null, true).await;
    }
    if !authorized(peer, &headers, port, token) {
        return reply(
            &mut stream,
            "403 Forbidden",
            json!({"status":"failed"}),
            false,
        )
        .await;
    }
    if method != "POST" || !route_allowed || request.body.len() > 1024 {
        return reply(
            &mut stream,
            "404 Not Found",
            json!({"status":"failed"}),
            true,
        )
        .await;
    }
    let Ok(payload) = serde_json::from_slice::<Value>(&request.body) else {
        return reply(
            &mut stream,
            "400 Bad Request",
            json!({"status":"failed"}),
            true,
        )
        .await;
    };
    let result = handler(path.to_string(), payload)
        .await
        .unwrap_or_else(|_| json!({"status":"failed","message":"恢复失败，请重试"}));
    reply(&mut stream, "200 OK", result, true).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn recovery_binding_has_independent_callbacks_timeouts_and_route_limits() {
        let script = serde_json::to_string(bridge_script()).unwrap();
        let code = format!(
            r#"
const vm = require("node:vm"), assert = require("node:assert/strict");
const timers = new Map(), sent = []; let seq = 0;
const nativeBridge = () => "business";
const window = {{__codexSessionDeleteBridge:nativeBridge,codexPlusRecoveryV1:text=>sent.push(JSON.parse(text))}};
window.top=window;window.electronBridge={{}};window.location={{href:"app://-/index.html"}};
const context = {{window,Map,Promise,Number,clearTimeout:id=>timers.delete(id),setTimeout:fn=>{{timers.set(++seq,fn);return seq}}}};
vm.runInNewContext({script},context);
(async()=>{{
const first=window.__codexPlusRecoveryBridge("/reconnect",{{token:"synthetic"}});
const id=sent[0].id;
window.__codexPlusRecoveryResolve(id,{{status:"ok"}});
assert.equal((await first).status,"ok");assert.equal(timers.size,0);
assert.equal(window.__codexSessionDeleteBridge,nativeBridge);
assert.equal((await window.__codexPlusRecoveryBridge("/settings/get",{{}})).status,"failed");
const pending=window.__codexPlusRecoveryBridge("/status",{{}});
timers.values().next().value();
assert.match((await pending).message,/Codex3N/);assert.equal(window.__codexPlusRecoveryCallbacks.size,0);
const old=window.__codexPlusRecoveryBridge("/status",{{}});
vm.runInNewContext({script},context);
assert.equal((await old).status,"recovering");assert.equal(timers.size,0);
delete window.electronBridge;
vm.runInNewContext({script},context);
assert.equal(typeof window.__codexPlusRecoveryBridge,"function");
window.__codexPlusRecoveryBridge=undefined;window.location.href="https://example.com";
vm.runInNewContext({script},context);
assert.equal(window.__codexPlusRecoveryBridge,undefined);
window.location.href="app://-/index.html";window.top={{}};
vm.runInNewContext({script},context);
assert.equal(window.__codexPlusRecoveryBridge,undefined);
}})().catch(error=>{{console.error(error);process.exitCode=1}});
"#
        );
        let output = std::process::Command::new("node")
            .args(["-e", &code])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn recovery_authorization_requires_loopback_host_token_and_native_origin() {
        let local: SocketAddr = "127.0.0.1:1234".parse().unwrap();
        let headers = "POST /status HTTP/1.1\r\nHost: 127.0.0.1:3456\r\nAuthorization: Bearer secret\r\nOrigin: app://-";
        assert!(authorized(local, headers, 3456, "secret"));
        assert!(!authorized(
            "192.0.2.1:1234".parse().unwrap(),
            headers,
            3456,
            "secret"
        ));
        assert!(!authorized(local, headers, 3456, "wrong"));
        assert!(!authorized(
            local,
            &headers.replace("app://-", "https://example.com"),
            3456,
            "secret"
        ));
        assert!(!authorized(
            local,
            &headers.replace("127.0.0.1:3456", "evil.example"),
            3456,
            "secret"
        ));
        assert!(!authorized(
            local,
            &format!("{headers}\r\nOrigin: app://-"),
            3456,
            "secret"
        ));
        assert!(!authorized(
            local,
            &format!("{headers}\r\nAuthorization: Bearer secret"),
            3456,
            "secret"
        ));
    }

    #[tokio::test]
    async fn recovery_http_only_dispatches_authenticated_fixed_routes() {
        let endpoint = RecoveryEndpoint::bind().unwrap();
        let config = endpoint.config("instance");
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let server = tokio::spawn(endpoint.serve(Arc::new(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(json!({"status":"ok"})) })
        })));
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = config["baseUrl"].as_str().unwrap();
        let bearer = config["token"].as_str().unwrap();
        assert_eq!(
            client
                .post(format!("{url}/reconnect"))
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
        for path in ["/status", "/reconnect"] {
            assert_eq!(
                client
                    .post(format!("{url}{path}"))
                    .bearer_auth(bearer)
                    .json(&json!({"instance":"instance"}))
                    .send()
                    .await
                    .unwrap()
                    .json::<Value>()
                    .await
                    .unwrap()["status"],
                "ok"
            );
        }
        assert_eq!(
            client
                .post(format!("{url}/settings/get"))
                .bearer_auth(bearer)
                .json(&json!({}))
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        server.abort();
        let _ = server.await;
    }
}
