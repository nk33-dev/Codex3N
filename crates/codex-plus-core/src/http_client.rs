/// 规范化 User-Agent：空字符串回退到产品默认 UA，其余去掉首尾空白。
fn normalized_user_agent(user_agent: &str) -> String {
    if user_agent.trim().is_empty() {
        format!("CodexPlusPlus/{}", env!("CARGO_PKG_VERSION"))
    } else {
        user_agent.trim().to_string()
    }
}

/// 默认 client：沿用 reqwest 的系统代理行为（`system-proxy` 特性在 `build()`
/// 时无条件追加系统代理匹配器）。非环回目标保持这个语义。
pub fn proxied_client(user_agent: &str) -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(normalized_user_agent(user_agent))
        .build()?)
}

/// 显式绕开系统代理的 client。`no_proxy()` 会清空并禁用 reqwest 在 `build()`
/// 时自动追加的系统代理匹配器（`auto_sys_proxy = false`），这是唯一可靠的排除方式：
/// 单纯再 `proxy()` 一个 `no_proxy` 规则无法覆盖系统代理匹配器。
pub fn direct_client(user_agent: &str) -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(normalized_user_agent(user_agent))
        .no_proxy()
        .build()?)
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
    let builder = reqwest::Client::builder()
        .user_agent(format!("CodexPlusPlus-VLM/{}", env!("CARGO_PKG_VERSION")))
        .connect_timeout(connect)
        .timeout(total);
    let builder = if url_targets_loopback(url) {
        builder.no_proxy()
    } else {
        builder
    };
    Ok(builder.build()?)
}

#[cfg(test)]
mod tests {
    use super::url_targets_loopback;

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
