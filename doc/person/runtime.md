# Codex3N 运行实现

记录管理器生命周期、配置安装和注入拼装的当前入口。上游同步与发布步骤见[维护流程](maintenance.md)。

管理器路由副标题从 `App.tsx` 经 `route-subtitle.ts` 提供；外链命令从 `commands.rs` 经 `commands/external_url.rs` 注册。两处沿用原入口，不增加独立监听或重复命令。

## 管理器加载和后台刷新

- `apps/codex-plus-manager/src/manager-loading.ts` 是启动和页面加载任务的唯一编排入口。公共初始化并行发起；设置首次加载可能导入本机供应商，所以工具摘要等设置完成后再读。会话、供应商扫描、环境检查和远端插件状态进入对应页面才加载。
- 页面内独立请求并行；会话供应商默认选择等待设置完成，脚本市场保留“设置 → 市场 → 库存”顺序，皮肤本地状态不等待远端市场。快速切页后不再发起旧页面的后续批次，启动和页面读取的旧设置响应不能覆盖已编辑的草稿。
- `use-manager-lifecycle.ts` 负责窗口可见性和事件接线，`manager-lifecycle.ts` 负责请求合并与定时调度。`App.tsx` 保留页面、业务状态和操作回调，不另放一套启动 effect、导航任务分支或 1.2 秒待处理轮询。
- 后端 `apps/codex-plus-manager/src-tauri/src/lib.rs` 在显示、聚焦、最小化和隐藏时发送窗口事件：`manager-visibility-changed` 的布尔载荷表示实际可见状态；`manager-navigation-requested` 通知检查待处理导航、供应商导入、会话分享和皮肤链接。失焦不等于隐藏，导航通知也不等于显示成功。
- 待处理文件有跨进程写入，因此可见时保留 30 秒兜底，窗口恢复后立即补读。隐藏时暂停待处理检查和微信页面状态；微信后台连接服务、用户已发起的扫码登录继续运行，避免丢失后端已保存凭据并消费二维码的确认结果。已发出的调用不能强制取消，旧微信状态响应不会覆盖恢复后的状态。
- 启动器在已启用且保存微信连接凭据时，以 `--background` 启动管理器；管理器 `lib.rs` 隐藏后台窗口，并经 `start_weixin_connect_from_saved_settings` 恢复连接。用户主动打开管理器时沿用单实例聚焦入口，不重复创建窗口。CLI 选择在非 Windows 优先验证包内 CLI，失败再尝试独立安装的 CLI。
- `weixin-qr-polling.ts` 是扫码轮询的唯一调度入口，复用 `createVisibleRefresh`，但不绑定窗口可见性。等待和已扫码每次响应完成后隔 1 秒补查；确认、过期、业务失败或请求异常均停止，异常只提示一次，不自动重试。新二维码或取消会销毁旧任务，未返回结果与错误都不再提交。
- 扫码确认后先补读设置和连接状态，再提交二维码终态，避免 effect 清理使补读失效。每次异步返回均检查当前任务；补读期间编辑过的设置草稿不被覆盖。验证见 `weixin-qr-polling.test.ts` 的慢请求、销毁、重新登录和终态测试。
- 浏览器验证使用真实 React 页面配合 Tauri 官方 IPC mock，覆盖供应商切换、复制、删除、拖拽排序，以及扫码确认、重新扫码和过期提示；mock 数据不代表真实微信登录或原生文件写入已实测。后端命令由 Rust 集成测试验证。日常界面验证优先使用浏览器，不通过 Windows 桌面自动化占用用户输入。
- 页面结构和视觉样式未因本次性能拆分调整。按需加载意味着第一次进入某页面才开始对应检查；如果跨进程唤起没有产生窗口事件，待处理链接会等到下一次兜底或窗口恢复时出现。

验证：前端 `manager-loading.test.ts`、`manager-lifecycle.test.ts`、`manager-window-lifecycle.test.ts`、`manager-navigation.test.ts`；后端窗口契约见 `apps/codex-plus-manager/src-tauri/tests/windows_subsystem.rs`。重点检查慢请求、连续事件、隐藏恢复、监听销毁和启动导航竞态。

## 管理器代码分层

`App.tsx` 只保留 `App()`、业务状态与操作回调，以及仍与其强耦合的页面；可独立成页的部分按需外移，避免单文件继续膨胀：

- 页面组件放 `apps/codex-plus-manager/src/screens/`（现为 `SessionsScreen`、`GrokScreen`）。
- 跨页面复用的展示原语放 `src/components/ui/manager-primitives.tsx`；默认设置放 `src/lib/default-settings.ts`。
- 外移模块只能 `import type ... from "../App"`，**不得在运行时从 `App.tsx` 取值**，否则形成循环依赖。需要新类型的可见性时给 `App.tsx` 的类型加 `export`。
- 后端 Tauri 命令按业务拆到 `apps/codex-plus-manager/src-tauri/src/commands/`（现为 `shared.rs`、`dream_skin.rs`、`provider_import.rs`）：`commands.rs` 用 `mod X; pub use X::*;` 汇总，`lib.rs` 的 `generate_handler!` 仍写 `commands::<命令名>`，不需要改。子模块内用 `use super::{...}` 取父模块项，需被父模块测试引用的私有项放宽为 `pub(super)`。
- 拆分时必须同步更新**按源码文本/AST 切片**的测试路径（如 `dream-skin.test.ts`、`renderer-inject.test.ts`、`commands.rs` 内的切片测试）以及 `tools/i18n-verify.mjs` 的 `SRC_FILES` 清单，断言语义保持不变。

## 配置和安装维护

- 设置写入采用跨进程锁和唯一临时文件；损坏内容会报错并保留原件，禁止静默回退默认值或覆盖用户配置，保存时保护已有供应商列表。入口：`crates/codex-plus-core/src/settings.rs`；验证设置单元测试和迁移测试。
- **settings.json 里的 API Key 落盘加密**（`crates/codex-plus-core/src/secret_store.rs`）：文件名精确等于 `apiKey` 或以 `ApiKey` 结尾的字符串值（`relayApiKey`、`vlmApiKey`、`codexAppStepwiseApiKey`、`relayProfiles[].apiKey`、`tools.<tool>.relayProfiles[].apiKey`，未来新增的 `*ApiKey` 字段自动生效）以 `enc:v1:<base64url(nonce||ciphertext||tag)>` 的 AES-256-GCM 密文存储；`codexAppStepwiseApiKeyEnv` 这类**环境变量名**字段（以 `Env` 结尾）不是密钥，保持明文。加解密只在 `SettingsStore::load`/`save`/`update` 的落盘边界发生，内存中与调用方看到的仍是明文，老版本的明文配置照常读取、下次保存自动升级，没有额外的迁移命令。
- 32 字节主密钥交给系统凭据库：Windows 用 DPAPI 用户作用域加密后写设置目录旁的 `secret.key`（`CryptProtectData` + `CRYPTPROTECT_UI_FORBIDDEN`，只读属性尽力而为）；macOS 用 Keychain 通用密码项（service `dev.nk33.Codex3N`，account `settings-master-key`）。进程内只取一次，失败也缓存，避免中途换密钥导致「刚加密的马上解不开」。
- 凭据库不可用（其他平台、DPAPI 失败、Keychain 拒绝等）时**不阻断保存**：该值按明文写入并记一条 `settings.secret_encryption_unavailable` 诊断日志（每进程只记一次）；`CODEX_PLUS_SETTINGS_NO_ENCRYPT` 为非空且不等于 `0`/`false` 时主动退回明文存储（与 `CODEX_PLUS_UPDATE_*` 逃生开关同风格）。读取时解不开的 `enc:v1:` 值按空串处理（不当成有效 key 用），记 `settings.secret_decrypt_failed`（只带字段路径，不带密文），并且**绝不改写或删除磁盘上的文件**（代码回退不等于数据回退）：修好凭据库或恢复 `secret.key` 后原文仍能读回；`update` 的读-改-写路径刻意保留解不开的密文，避免把用户已存的密钥写没了。
- **边界**：`authContents` / `configContents` 里内嵌的 key（例如 `{"OPENAI_API_KEY":"..."}`、`experimental_bearer_token`）本次**不在加密范围**，它们同时会被写成 Codex 自己的 `~/.codex/auth.json` / `config.toml`，那部分保持原样。
- 个人版更新源由 `crates/codex-plus-core/src/update.rs` 指向 Codex3N；同步上游不能把更新源改回官方。
- 自更新链默认两道保护且**失败关闭**：安装包必须通过 sha256 校验（优先用发布元数据里的 `sha256`/`digest`，缺失时回落到 release 里的 `SHA256SUMS.txt`，两者都拿不到就拒绝安装），目标版本必须高于当前版本（`-3n.N` 的 N 参与比较）。校验失败会删除已下载文件且绝不启动安装包。判定入口 `download_and_verify_update`；验证 `crates/codex-plus-core/tests/updater.rs`。
- 两个逃生开关默认关闭，放行时写诊断日志：`CODEX_PLUS_UPDATE_ALLOW_UNVERIFIED=1` 允许安装发布方未提供 sha256 的产物；`CODEX_PLUS_UPDATE_ALLOW_DOWNGRADE=1` 允许安装不高于当前版本的包。诊断关键字：`update.downgrade.rejected`、`update.verify.failed`、`update.verify.missing_checksum_rejected`。
- 校验和由 `.github/workflows/release-assets.yml` 的 `latest-json` job 产出：在安装包 job 全部结束后下载该 release 的全部产物、算 sha256，写 BSD 风格 `SHA256SUMS.txt` 并把每个产物的 sha256 填进 `latest.json` 的 asset 条目，最后同一次 `gh release upload --clobber` 上传两个文件；两文件必须成对更新，否则客户端失败关闭会拒绝更新。
- 安装失败须如实报告，Watcher 按安装实例处理进程，避免误杀其他安装。入口：`crates/codex-plus-core/src/install/` / `watcher.rs`；验证 `updater.rs`、`installers.rs`、`watcher.rs`。
- **发往环回目标的请求显式禁用系统代理**：`reqwest` 的 `system-proxy` 特性在 `ClientBuilder::build()` 时**无条件**追加系统代理匹配器，再 `proxy()` 一个 `no_proxy` 规则也排除不掉。而 Windows 的 `ProxyOverride` 常见配置含 `127.*`，上游 hyper-util 把 `*.` 直接 `.replace("*.", "")` 得到无效条目 `127.`，且对 IP 字面量只查 IP 表而不做前缀匹配，于是发往 `127.0.0.1` 的请求仍被本机代理（如 Clash）接管：代理把请求转交远端节点后，远端去连它自己的 `127.0.0.1:<端口>`，连接被拒时本机代理回 **502**。本地 relay、把 `http://127.0.0.1:57321` 协议代理当供应商、本地 VLM / 模型目录探测都会因此失败。唯一可靠做法是按目标 URL 选 client，环回走 `reqwest::ClientBuilder::no_proxy()`（清空并禁用系统代理匹配器）。入口：`crates/codex-plus-core/src/http_client.rs` 的 `client_for_url` / `url_targets_loopback` / `direct_client`（VLM 侧为 `vlm_http_client_for_url`，connect/total 超时语义不变）。这是**有意绕开**系统代理，不是忽略用户的代理设置。
- **非环回目标仍然走系统代理**：只有 `url_targets_loopback` 判定为真的目标（`localhost`、`127.0.0.0/8`、`::1`）才切到直连 client，其余目标继续用 `proxied_client`（即原 `proxied_client` 语义与签名零变化）。调用点按实际请求 URL 选择：`protocol_proxy.rs` 用 `endpoint`、`models_url(...)`、`chat_completions_url(...)` 派生出的那个值，`model_catalog.rs`、`sub2api.rs`、`relay_config::test_relay_profile`、`stepwise.rs` 同理。例外：`plugin_marketplace.rs`、`skills.rs` 的目标是固定公网 GitHub 地址，无需改动。
- 会话快照、删除与撤销的数据保护见 [sessions.md](sessions.md)。

## 本地 helper 的请求边界

`crates/codex-plus-core/src/launcher.rs` 的 helper 是**无入站鉴权**的本地 HTTP 服务，并会用服务端保存的 API Key 代发上游请求。因此每个连接在路由分发之前都要过两道闸门（`handle_helper_connection`）：

- **对端必须是回环地址**，否则 403；绑定地址由 `helper_bind_host()` 决定，只有回环形式（`127.*`、`::1`、`localhost`）被接受。
- **来源必须落在注入目标的白名单内**：只放行本地主界面 `app://-` 与 ChatGPT 桌面页 `https://chatgpt.com` / `https://chat.openai.com`（`cdp.rs` 认定的可注入目标），并精确匹配以防前缀伪装；`Access-Control-Allow-Origin` 回显该来源，不再下发通配符。非浏览器调用（无 `Origin`）不受影响。
- **`null` 必须拒绝**：沙箱化 iframe、`file://`、`data:` 页面都序列化成 `null`，`<iframe sandbox srcdoc=…>` 即可伪造，所以它不能当成「本地页面」放行。代价是 `data:text/html` 类注入目标（预热的 quick-chat / 头像浮层）也拿不到服务——这些页面不渲染会话列表，正常不会调用 helper。

两个逃生开关都默认关闭，只在注入脚本无法通过校验时临时使用，放行会写诊断日志：`CODEX_PLUS_HELPER_BIND` 配 `CODEX_PLUS_HELPER_ALLOW_REMOTE=1` 放开非回环绑定与对端；`CODEX_PLUS_HELPER_ALLOW_WEB_ORIGIN=1` 放行任意网页来源。同步上游时不得把闸门删回无条件 `Access-Control-Allow-Origin: *`。真机排查：在诊断日志里搜 `helper.rejected_web_origin`，其中 `origin` 字段就是被拒的真实来源；若出现预期外的值，先临时放行恢复功能，再改成共享令牌方案。验证：`launcher.rs` 的 `helper_*` 单测，以及 `tests/launcher.rs` 的 `default_helper_rejects_web_origin_requests` / `default_helper_omits_wildcard_cors_for_requests_without_origin`。

## 注入脚本分片

上游 Taskboard 是 `apps/codex-taskboard` 的独立应用，使用自己的注入脚本和构建流程；它不属于个人版 `assets.rs` 的管理器注入拼装入口，不要把其运行时代码复制到渲染分片。

- 注入脚本按子系统拆成 `assets/inject/renderer/**` 分片，唯一拼装入口是 `crates/codex-plus-core/src/assets.rs` 的 `RENDERER_SCRIPT`；悬浮球的 `assets/inject/floating-panel/**` 是上游既有分片，规则相同。分片不是模块：不带 `import` / `export`、不带自己的 IIFE 外壳，运行入口只有 `assets.rs` 一处。
- 分片顺序**有意义**：整份脚本共享一个 IIFE 作用域，`const` / `let` 存在 TDZ。新增分片只能插到正确位置，不能调整已有顺序。粘贴修复块在 IIFE 之外（`"})();\n"` 之后），放进 IIFE 会随早返回守卫一起被跳过。
- `.gitattributes` 已把 `assets/inject/**/*.js` 固定为 LF；分片被 `include_str!` 内联，换行变化会改变注入内容。
- 前端按标记切片注入源码的回归测试统一走 `apps/codex-plus-manager/src/inject-fragments.ts` 拼回原文；`inject-fragments.test.ts` 校验分片清单与 `assets.rs` 的 `concat!` 顺序一致，Rust 侧 `assets.rs` 的单元测试校验每个分片都真的拼进了结果。
- 同步上游时，上游把新行为继续写在单文件注入脚本或别处时，迁入对应分片，不能同时保留旧内联实现；合并后跑 `cargo test --workspace`（`crates/codex-plus-core/tests/cdp_bridge.rs` 等按内容断言拼装结果）与前端 `npm test`。
- 插件市场解锁的补丁分散在四处宿主对象上：`Array.prototype.filter`、`window.dispatchEvent`、`electronBridge.sendMessageFromView`、RPC 客户端 `sendRequest`。每处都必须同时记录原始值并在 `clearPluginPatchArtifacts()` 里还原（`scanDeferred()` 在 relay 模式下每轮都会调它）。原始方法本身与绑定副本分开保存：还原回原始方法，绑定副本只给包装器调用。验证：`apps/codex-plus-manager/src/marketplace-patch-teardown.test.ts`。
