use serde_json::{Value, json};
use url::Url;

use super::{CommandResult, failed, ok};

const ALLOWED_HOSTS: &[&str] = &[
    "github.com",
    "dreamskin.cc",
    "discord.gg",
    "t.me",
    "ilinkai.weixin.qq.com",
    "weixin.qq.com",
    "open.weixin.qq.com",
];

fn allowed_external_url(input: &str) -> Option<Url> {
    let url = Url::parse(input.trim()).ok()?;
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url
            .host_str()
            .is_some_and(|host| ALLOWED_HOSTS.contains(&host)))
    .then_some(url)
}

#[tauri::command]
pub fn open_external_url(url: String) -> CommandResult<Value> {
    let Some(allowed) = allowed_external_url(&url) else {
        return failed("仅允许打开已批准站点的 HTTPS 链接。", json!({}));
    };
    match open_url(allowed.as_str()) {
        Ok(()) => ok(
            "已在系统浏览器打开链接。",
            json!({ "url": allowed.as_str() }),
        ),
        Err(error) => failed(
            &format!("打开链接失败：{error}"),
            json!({ "url": allowed.as_str() }),
        ),
    }
}

fn open_url(url: &str) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        codex_plus_core::windows_open_url(url)
    }
    #[cfg(not(windows))]
    {
        let program = if cfg!(target_os = "macos") {
            "open"
        } else {
            "xdg-open"
        };
        std::process::Command::new(program)
            .arg(url)
            .spawn()
            .map(|_| ())
            .map_err(|error| anyhow::anyhow!("启动系统浏览器失败：{error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_links_require_allowed_https_hosts() {
        assert!(allowed_external_url("https://github.com/nk33-dev/Codex3N").is_some());
        for link in [
            "file:///C:/Windows/win.ini",
            "http://github.com",
            "https://github.com.evil.test",
            "https://user@github.com",
            "https://127.0.0.1",
        ] {
            assert!(allowed_external_url(link).is_none(), "{link}");
        }
    }
}
