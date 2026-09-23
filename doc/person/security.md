# 安全边界与门禁

## Mobile relay

`apps/codex-plus-mobile-relay/src/main.rs` 是独立的 WebSocket 服务。启动前设置 `CODEX_PLUS_MOBILE_RELAY_SECRET` 为 32 个随机字节的十六进制编码（64 字符）；不要把主密钥输入浏览器或放进链接。同一环境执行 `codex-plus-mobile-relay --issue-token <room>`，将输出的 room、token、expiresAt 分发给两端。默认只监听 `127.0.0.1:57323`；对外部署必须通过 TLS 反向代理提供 `wss://`，并控制 `/status` 等诊断路径的访问。显式设置 `CODEX_PLUS_MOBILE_RELAY_BIND` 才可更改监听地址。

客户端连接 `/ws` 后，10 秒内以首帧 JSON 注册：`{"type":"register","role":"host|client","room":"...","token":"签发的 64 位十六进制值","expiresAt":<Unix 秒>,"nonce":"每次连接新生成的 32 位十六进制随机值"}`。房间两端共享签发的 token 与 expiresAt；服务端用主密钥验证房间和期限的 HMAC，令牌有效期至多 10 分钟，不能自行修改 expiresAt 续期。服务端拒绝 URL query 凭据、过期注册、重复 nonce 和不同房间凭据，比较令牌时采用常量时间比较。消息/帧上限 64 KiB，连接每秒最多 30 条消息，发送队列最多 64 条。到期后重新签发凭据，不复用旧链接。`/mobile` 的加密 Key 与 relay token 是两个不同的值，不应通过页面 URL 传递。

## 管理器 WebView

`apps/codex-plus-manager/src-tauri/tauri.conf.json` 明确限制脚本、连接、图片、字体、对象和嵌入来源；开发模式只为本地 Vite 增加连接源。`assetProtocol.scope` 只允许 `$HOME/.codex-session-delete/dream-skin/**`，图片预览通过 `convertFileSrc` 使用它；扩大该路径前需要重新审查。`capabilities/default.json` 将文件对话框限于打开与保存；外链只由 `commands/external_url.rs` 在 Rust 侧校验 HTTPS 与站点白名单后交给系统浏览器。微信二维码 SVG 由本地 QR 编码器生成，前端只作为图片加载，不作为 HTML 注入。

## CI 与发布

PR、Release 和 `scripts/release.ps1` 均运行 relay 的 `cargo clippy -p codex-plus-mobile-relay --all-targets -- -D warnings`、`cargo audit` 与前端 `npm audit --audit-level=high`。Clippy 先只阻断 relay，核心库的既有告警按模块逐步清理；Rust 审计只把漏洞设为阻断，未维护等警告仍报告。安全检查失败不创建 Release。
