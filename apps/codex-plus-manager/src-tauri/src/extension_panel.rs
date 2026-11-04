use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const SCHEME: &str = "codex3n-panel";
const MAX_PAGES: usize = 16;
const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;
const PANEL_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'; connect-src 'none'";

fn pages() -> &'static Mutex<HashMap<String, Vec<u8>>> {
    static PAGES: OnceLock<Mutex<HashMap<String, Vec<u8>>>> = OnceLock::new();
    PAGES.get_or_init(Default::default)
}

fn register(html: String) -> Result<String, String> {
    if html.len() > MAX_HTML_BYTES {
        return Err("拓展面板超过 8 MiB 限制".into());
    }
    let mut pages = pages().lock().unwrap_or_else(|error| error.into_inner());
    if pages.len() >= MAX_PAGES {
        return Err("打开的拓展面板过多，请关闭部分面板后重试".into());
    }
    let token = uuid::Uuid::new_v4().to_string();
    pages.insert(token.clone(), html.into_bytes());
    Ok(token)
}

#[tauri::command]
pub fn register_extension_panel<R: tauri::Runtime>(
    window: tauri::WebviewWindow<R>,
    html: String,
) -> Result<String, String> {
    if window.label() != crate::MAIN_WINDOW_LABEL {
        return Err("只有主窗口可创建拓展面板".into());
    }
    register(html)
}

#[tauri::command]
pub fn release_extension_panel<R: tauri::Runtime>(window: tauri::WebviewWindow<R>, token: String) {
    if window.label() == crate::MAIN_WINDOW_LABEL {
        pages()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&token);
    }
}

pub fn response(
    label: &str,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let token = request.uri().path().trim_start_matches('/');
    let body = if label == crate::MAIN_WINDOW_LABEL
        && request.method() == tauri::http::Method::GET
        && uuid::Uuid::parse_str(token).is_ok()
    {
        pages()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(token)
            .cloned()
    } else {
        None
    };
    tauri::http::Response::builder()
        .status(if body.is_some() { 200 } else { 404 })
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", PANEL_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .body(body.unwrap_or_default())
        .unwrap()
}

pub fn scheme() -> &'static str {
    SCHEME
}

pub fn clear() {
    pages()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_protocol_only_serves_registered_tokens_and_keeps_its_csp() {
        let token = register("<p>panel</p>".into()).unwrap();
        let request = |path: &str| {
            tauri::http::Request::builder()
                .uri(format!("codex3n-panel://localhost/{path}"))
                .body(Vec::new())
                .unwrap()
        };
        let result = response(crate::MAIN_WINDOW_LABEL, request(&token));
        assert_eq!(result.status(), 200);
        assert_eq!(result.body(), b"<p>panel</p>");
        assert_eq!(result.headers()["Content-Security-Policy"], PANEL_CSP);
        assert_eq!(
            response(crate::MAIN_WINDOW_LABEL, request("../settings.json")).status(),
            404
        );
        assert_eq!(response("tray-panel", request(&token)).status(), 404);
        pages().lock().unwrap().remove(&token);
        assert_eq!(
            response(crate::MAIN_WINDOW_LABEL, request(&token)).status(),
            404
        );
        assert!(register("x".repeat(MAX_HTML_BYTES + 1)).is_err());
    }
}
