use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// 规范化 User-Agent：空字符串回退到产品默认 UA，其余去掉首尾空白。
fn normalized_user_agent(user_agent: &str) -> String {
    if user_agent.trim().is_empty() {
        format!("CodexPlusPlus/{}", env!("CARGO_PKG_VERSION"))
    } else {
        user_agent.trim().to_string()
    }
}

/// client 池的容量上限。UA 可以在供应商里随意编辑，不设上限会一直堆积。
const CLIENT_POOL_CAPACITY: usize = 16;

/// 池内 client 的身份：通用 client 按 UA 区分，VLM client 按超时参数区分。
#[derive(Clone, PartialEq, Eq, Hash)]
enum ClientKey {
    UserAgent {
        loopback: bool,
        user_agent: String,
    },
    Vlm {
        loopback: bool,
        connect: std::time::Duration,
        total: std::time::Duration,
    },
}

type ClientPool = Mutex<HashMap<ClientKey, reqwest::Client>>;

fn default_client_pool() -> &'static ClientPool {
    static POOL: OnceLock<ClientPool> = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 池化通用 client：命中直接复用，未命中才构建。
fn pooled_client(loopback: bool, user_agent: &str) -> anyhow::Result<reqwest::Client> {
    let key = ClientKey::UserAgent {
        loopback,
        user_agent: normalized_user_agent(user_agent),
    };
    pooled_with(key, |user_agent| {
        let builder = reqwest::Client::builder();
        match user_agent {
            Some(user_agent) => builder.user_agent(user_agent),
            None => builder,
        }
    })
}

/// 池化 VLM client：UA 固定，按 (是否环回, 超时) 复用。
fn pooled_vlm_client(
    loopback: bool,
    connect: std::time::Duration,
    total: std::time::Duration,
) -> anyhow::Result<reqwest::Client> {
    let key = ClientKey::Vlm {
        loopback,
        connect,
        total,
    };
    pooled_with(key, |_| {
        reqwest::Client::builder()
            .user_agent(format!("CodexPlusPlus-VLM/{}", env!("CARGO_PKG_VERSION")))
            .connect_timeout(connect)
            .timeout(total)
    })
}

/// 池化的公共部分：查表、构建、落表。
///
/// 每次请求新建 `reqwest::Client` 会连带丢掉连接池：每个上游请求都要重新做一遍
/// TCP + TLS 握手（百毫秒量级），`build()` 本身还要装一遍证书链。复用之后
/// keep-alive 才真正生效。
///
/// 代价：系统代理是 `build()` 时解析的，缓存后代理变更不再逐请求生效。所以配套
/// [`reset_client_pool`]——请求失败时清空池子，下一次请求会重建 client 并重新读
/// 系统代理，端口变了最多失败一次，不需要重启进程。
fn pooled_with(
    key: ClientKey,
    configure: impl FnOnce(Option<&str>) -> reqwest::ClientBuilder,
) -> anyhow::Result<reqwest::Client> {
    let pool = default_client_pool();
    if let Ok(entries) = pool.lock()
        && let Some(client) = entries.get(&key)
    {
        return Ok(client.clone());
    }
    let loopback = match &key {
        ClientKey::UserAgent { loopback, .. } | ClientKey::Vlm { loopback, .. } => *loopback,
    };
    let user_agent = match &key {
        ClientKey::UserAgent { user_agent, .. } => Some(user_agent.as_str()),
        ClientKey::Vlm { .. } => None,
    };
    let builder = configure(user_agent);
    // `no_proxy()` 会清空并禁用 reqwest 在 `build()` 时自动追加的系统代理匹配器
    // （`auto_sys_proxy = false`），这是唯一可靠的排除方式：单纯再 `proxy()` 一个
    // `no_proxy` 规则无法覆盖系统代理匹配器。
    let builder = if loopback {
        builder.no_proxy()
    } else {
        builder
    };
    let client = builder.build()?;
    if let Ok(mut entries) = pool.lock() {
        if entries.len() >= CLIENT_POOL_CAPACITY {
            entries.clear();
        }
        entries.insert(key, client.clone());
    }
    Ok(client)
}

/// 清空 client 池，让下一次请求重新构建 client。
///
/// 上游请求失败时调用：系统代理（如 Clash 的混合端口）改了以后，缓存的 client
/// 仍指向旧代理，清空即可自愈，不必重启进程。
pub fn reset_client_pool() {
    if let Ok(mut entries) = default_client_pool().lock() {
        entries.clear();
    }
}

/// 默认 client：沿用 reqwest 的系统代理行为（`system-proxy` 特性在 `build()`
/// 时无条件追加系统代理匹配器）。非环回目标保持这个语义。
pub fn proxied_client(user_agent: &str) -> anyhow::Result<reqwest::Client> {
    pooled_client(false, user_agent)
}

/// 显式绕开系统代理的 client。
pub fn direct_client(user_agent: &str) -> anyhow::Result<reqwest::Client> {
    pooled_client(true, user_agent)
}

/// 判断 URL 的目标主机是否属于环回地址。
///
/// 识别 `localhost`（大小写不敏感、容忍结尾点）、`127.0.0.0/8` 全部地址、
/// `::1`（含 `[::1]` 写法）。只认真正解析出来的 host，因此
/// `https://127.0.0.1.evil.example/`、`https://example.com/127.0.0.1` 均为
/// `false`；URL 解析失败同样返回 `false`（保守起见交给默认代理行为）。
pub fn url_targets_loopback(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let host = host.trim().trim_end_matches('.');
    // `Url::host_str()` 对 IPv6 会**保留方括号**（`[::1]`），必须先剥掉再解析。
    let host = host
        .strip_prefix('[')
        .and_then(|inner| inner.strip_suffix(']'))
        .unwrap_or(host);
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    // `IpAddr::is_loopback()` 恰好覆盖 127.0.0.0/8 与 ::1。
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

/// 按目标 URL 选择 client：环回目标绕开系统代理，其余保持默认代理行为。
///
/// 为什么必须绕开：Windows 的 `ProxyOverride` 常见配置含 `127.*`，但上游
/// hyper-util 把 `*.` 直接 `.replace("*.", "")` 得到无效条目 `127.`，且对 IP
/// 字面量只查 IP 表而不做前缀匹配，于是发往 127.0.0.1 的请求仍被本机系统代理
/// （如 Clash）接管。代理把请求转交远端节点后，远端连的是它自己的
/// 127.0.0.1:<端口>，连接被拒时本机代理回 502——本地 relay、协议代理自环、
/// 本地 VLM/模型目录探测都会因此失败。这属于有意绕开系统代理，不是忽略用户
/// 的代理设置：非环回目标依旧走系统代理。
pub fn client_for_url(user_agent: &str, url: &str) -> anyhow::Result<reqwest::Client> {
    if url_targets_loopback(url) {
        direct_client(user_agent)
    } else {
        proxied_client(user_agent)
    }
}

/// VLM 专用 HTTP client（带超时）。
/// 不复用通用 proxied_client，避免 VLM 服务无响应时永久阻塞整个代理。
/// 注意：这里拿不到目标 URL，只能沿用系统代理；需要按 URL 判断时用
/// [`vlm_http_client_for_url`]。
pub fn vlm_http_client() -> anyhow::Result<reqwest::Client> {
    vlm_http_client_for_url(
        "",
        std::time::Duration::from_secs(5),
        std::time::Duration::from_secs(30),
    )
}

/// 带超时的 VLM client，并按目标 URL 决定是否绕开系统代理（语义同
/// [`client_for_url`]）。connect/total 超时语义与原 `vlm_http_client` 完全一致。
pub(crate) fn vlm_http_client_for_url(
    url: &str,
    connect: std::time::Duration,
    total: std::time::Duration,
) -> anyhow::Result<reqwest::Client> {
    pooled_vlm_client(url_targets_loopback(url), connect, total)
}

#[cfg(test)]
mod tests {
    use super::{direct_client, reset_client_pool, url_targets_loopback};

    /// client 池的实际效果就是连接复用。用真实 TCP 服务端数连接次数来看：
    /// 池子命中时多个请求共用一个 keep-alive 连接，池子被清掉后才重新建连。
    #[tokio::test]
    async fn client_pool_keeps_upstream_connections_alive() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        reset_client_pool();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let accepts = Arc::new(AtomicUsize::new(0));
        let server_accepts = Arc::clone(&accepts);
        let server = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                server_accepts.fetch_add(1, Ordering::SeqCst);
                tokio::spawn(async move {
                    let mut buffer = [0_u8; 1024];
                    while let Ok(read) = socket.read(&mut buffer).await {
                        if read == 0 {
                            return;
                        }
                        if socket
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                            .await
                            .is_err()
                        {
                            return;
                        }
                    }
                });
            }
        });

        let mut request = |pool_reset: bool| {
            let accepts = Arc::clone(&accepts);
            let url = format!("http://{addr}/probe");
            async move {
                if pool_reset {
                    reset_client_pool();
                }
                // 每次都重新取 client：池化生效时才不会新建连接。
                let response = direct_client("").unwrap().get(url).send().await.unwrap();
                assert_eq!(response.status(), 200);
                accepts.load(Ordering::SeqCst)
            }
        };

        assert_eq!(request(false).await, 1);
        assert_eq!(request(false).await, 1, "第二次请求应复用同一个连接");
        assert_eq!(request(true).await, 2, "清空池子后应重新建连");

        server.abort();
    }

    #[test]
    fn url_targets_loopback_detects_loopback_hosts() {
        for url in [
            "http://127.0.0.1:1234/v1",
            "http://127.9.9.9/x",
            "https://localhost:443",
            "http://LOCALHOST/x",
            "http://[::1]:8080",
            "https://[::1]/x",
            "http://[0:0:0:0:0:0:0:1]:9/x",
            "http://localhost./x",
        ] {
            assert!(url_targets_loopback(url), "{url} 应判定为环回");
        }
    }

    #[test]
    fn url_targets_loopback_rejects_non_loopback_and_invalid() {
        for url in [
            "https://api.example.com/v1",
            "https://127.0.0.1.evil.example/",
            "https://example.com/127.0.0.1",
            "http://[::2]:8080",
            "",
            "not a url",
        ] {
            assert!(!url_targets_loopback(url), "{url} 不应判定为环回");
        }
    }
}
