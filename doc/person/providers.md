# 供应商与本地配置

## 业务行为

- 本地网关通过 `gateway.json` 独立保存供应商池、模型组、Agent 接入及凭据；直连供应商导入为副本，两边后续互不覆盖。Codex 接入和断开复用原配置切换、修订号与备份链路。完整网关契约见 [本地网关](../../docs/local-gateway.md)。
- Claude Code / Grok 的供应商配置随上游转到网关；已有直连档案保留在设置文件，可经网关导入。未接入的 Agent 继续使用自身配置。旧 Claude 独立供应商页面已撤下，Claude 会话管理继续独立维护。

- 首次将本机 `config.toml` / `auth.json` 导入为普通可选的“系统默认”供应商，不重复覆盖用户配置。
- 自定义供应商及配置导入入口在管理器供应商页。
- 普通供应商与聚合配置分别展示，新建入口可按账号、模型厂商、第三方平台和自定义配置搜索。纯 API 模式同时保存 `auth.json` API 登录态与 provider 的 `experimental_bearer_token`，供新版 Codex 显式鉴权；关闭接管后两处都有 Key 的配置仍按窄路径规则拒绝轻量切换，需使用整份供应商切换。
- 供应商列表依次为直连、模型聚合、协议转换和故障转移。`aggregate.modelAggregationEnabled` 与后端聚合镜像同名字段区分两类，默认关闭；新建时确定类型。模型聚合固定绑定成员，不使用轮转策略与通配符路由。分页只控制展示，保存与切换始终基于完整供应商列表；总开关关闭时点击“使用”显示开启提示。
- 聚合成员仅在供应商从完整配置中删除时移除，凭据或配置暂时不可用仍保留成员。`aggregate.defaultRelayId` 与聚合镜像的 `defaultRelayId` 保存默认成员，成员移除时同步清理默认指向。
- 聚合成员支持普通 API 与官方登录账号。`official_login.rs` 从 `authContents` 解析 OAuth 凭据，优先采用同账号 live 登录态，临期刷新并写回快照；401 强制刷新后仅重试一次。命名 Key 仍由原归一化入口处理，接入方式三选一与 Key 列表共用同一编辑区。
- 聚合配置与镜像的 `syncDefaultMemberLogin` 默认关闭。开启后切换聚合会合并默认官方成员的登录凭据，保留代理 Key；同账号采用 live 更新的 Token，live 已登录其他账号时保留该账号。默认成员没有官方凭据时清理残留登录段。`provider-types.ts` 与 `App.tsx` 的回填、归一化、镜像生成共用此字段；后端入口为 `relay_config.rs` 和 `official_login.rs`，回归见 `aggregate_default_login_sync.rs`。
- `providerSyncEnabled` 和 `relayProfilesEnabled` 默认关闭；首次导入不应自动启用代理或接管当前配置。
- 供应商切换从读取当前配置快照开始即锁定操作，完成或失败后释放，避免重复点击排队执行旧切换请求。
- 设置保存与供应商切换共用互斥检查，重复保存不会排队；保存失败保留草稿，保存/切换的旧响应不覆盖期间产生的新编辑。供应商详情在保存或切换期间禁用编辑、返回和再次操作，销毁后的保存结果不再触发旧页面回调。
- “恢复官方登录”复用官方供应商和已有切换入口，遵守供应商总开关及切换锁。管理器回填遇到损坏的 live TOML 返回 `degraded` 并保留原供应商快照；回填成功后才提交工作副本。核心切换仍独立验证 live 配置，失败时保留文件并报告原因。
- 切换会保留用户插件表；纯 API 供应商使用 OpenAI 会话身份时，合并 live OAuth 登录态，普通纯 API 供应商仍按自身鉴权配置应用。
- 普通 API 供应商支持多个命名 Key，`apiKeys` 保存条目，`activeApiKeyId` 指向当前项；旧 `apiKey` 配置自动迁移为“默认”条目。Key 内容继续按密钥字段规则加密落盘。管理器的供应商编辑页与 Codex++ 轻量页面都能编辑/切换：编辑页每行是「设为当前 + 名称 + 密钥 + 删除」，只剩一项时禁用删除；标准化（`relayProfileWithNormalizedApiKeys`）在保存前把 `apiKey` 同步成当前项的值，这三处必须一起写。保存是整表覆盖写，同 id 供应商原本有 Key、这次一条不剩时 `SettingsStore::save` 直接拒绝写入并保留原文件，避免某条重建路径漏带 `apiKeys` 时把用户的 Key 静默清空（把单个 Key 的值留空不算清空）。
- Codex++ 轻量页面只读取 Key 的 ID 和名称，不返回密钥正文；当前 Key 的查看与切换集中在 Codex++ 设置页。密钥页用下拉框列出当前供应商的命名 Key，选中项即配置中保存的 Key；只有切换请求进行中才禁用。`/relay-api-keys` 的 `activeKeyId` 以 live 配置中保存的 Key 为准（`live_codex_api_key_in_home` 读取 `auth.json` 的 `OPENAI_API_KEY` 或 config.toml 的 bearer token，再匹配命名 Key），匹配不上时回退到存档目标项并返回 `liveKeyMatched: false`，页面据此提示当前配置里的 Key 不在列表里；总开关关闭时存档的 `activeApiKeyId` 可能停在最后添加的那个 Key。后端读不到 live 时不返回该字段，页面不做匹配提示。切换当前 Key 通过 `/relay-api-keys/select` 更新供应商存档、live 配置和支持的运行时认证；切换完成后前端强制刷新模型目录。轻量页面每次打开都会重建 DOM，所以重画由「打开面板」驱动（`refreshRelayApiKeysOnPanelOpen`），而不是挂在心跳或状态事件上：缓存已是 `ok`/`failed` 时只重画不重复请求，后端已连接但上次读取失败时补拉一次，状态仍在 `loading` 时推一次请求并由 5 秒超时落到失败态。任一分支都不能把模板里的「正在读取当前供应商…」留在界面上——首拉曾挂在 `backendStatus === "ok"` 上，后端未就绪时一次请求都不发，就是反复复发的那条路径。读取异常或桥接超时会显示失败状态并停止自动重试，避免心跳重复请求。
- 换 Key 分两条路径，由 `relayProfilesEnabled` 决定：开关打开时沿用整份供应商配置应用（`switch_relay_profile_in_home`）；开关关闭时走只改 Key 的窄路径 `set_live_api_key_only_in_home`，只更新 Key 的落点，`config.toml` 与 `auth.json` 另一个文件一个字节都不动，写前同样留 `~/.codex/backups/codex-plus-live-*` 备份。
- `/relay-api-keys/select` 在保存后更新运行中的认证：`runtime_api_key_in_home` 仅接受无 OAuth 登录态、无环境变量覆盖、落点唯一的 `auth.json` API Key，并核对它与选中项一致。后端经 CDP 调用本机 RPC 的 `account/login/start`，收到 `type: "apiKey"` 才返回 `runtimeApplied: true`，已有会话的后续请求使用新 Key，无需重启 Codex。配置内 bearer token、OAuth 混合认证、客户端未连接或更新失败时返回 `runtimeApplied: false`，提示 Key 已保存但需完整退出并重开 Codex；页面刷新列表和重开面板仍保留此提示。正在生成的请求保持原认证。
- 窄路径先由 `live_api_key_target_in_home` 判定落点：`auth.json` 的 `OPENAI_API_KEY`，或 `config.toml` 里 Codex++ 写入的 `experimental_bearer_token`。落点不唯一（两处都有 Key）、Key 写在 `api_key`/`bearer_token` 等非标准字段、供应商用 `env_key` 声明 Key 来自环境变量、或通用环境变量（`OPENAI_API_KEY` 等，优先级高于 `auth.json`）已设置时，一律报错拒绝，不做“写了但 Codex 没读”的假成功。Key 在环境变量里的情况只能改环境变量本身，或改用整份切换。

## 代码入口与配置

密钥页沿用设置行布局：左侧显示标题和供应商摘要，右侧是 180px 宽的 Key 选择器，提示单独占一行，窄窗口自动换行。选择器保留无障碍名称、键盘焦点和切换中禁用状态，原生菜单随宿主深浅主题配色；通过 `change` 事件提交切换，鼠标和键盘共用同一入口。

- `crates/codex-plus-core/src/provider_import.rs`：`initialize_local_config_provider`，关注 `localConfigProviderImported`。
- `crates/codex-plus-core/src/settings.rs`：供应商持久化与工具配置分片。
- `crates/codex-plus-core/src/relay_config.rs` / `relay_switch.rs`：配置应用与切换。`relay_switch::select_active_relay_api_key_in_home` 按总开关分流；`relay_config::live_api_key_target_in_home` / `set_live_api_key_only_in_home` 是窄路径的落点判定与写入。`API_KEY_ENV_KEYS`、`PROVIDER_TOKEN_KEYS`、`PROVIDER_ENV_KEY_KEYS` 在这里定义，模型目录的 `provider_api_key` 复用同一份清单，不再各写一套。
- `crates/codex-plus-core/src/routes.rs`：`/relay-api-keys` 提供脱敏列表，`/relay-api-keys/select` 执行当前供应商 Key 切换。
- `crates/codex-plus-core/src/bridge.rs::reload_api_key_at` 与启动器的 `reload_api_key` 复用当前页面 CDP 连接；`40-backend-settings.js::reloadCodexApiKey` 只向 `hostId: "local"` 的 RPC 客户端提交认证更新，串行处理更新，失败仅返回布尔值。
- `assets/inject/renderer-inject/40-backend-settings.js` 的 `renderRelayApiKeys`、`selectRelayApiKey` 提供设置页的 Key 选择器。`80-session-share.js::removeLegacyRelayApiKeyBadges` 由 `99-startup.js` 在注入重载时清理旧徽章，防止旧节点留在会话或提问面板。
- `apps/codex-plus-manager/src/App.tsx`：供应商页状态、配置保存与切换编排。列表的 `onSwitch` 先调用 `syncLegacyRelayFields` 同步目标配置，再将结果和旧供应商 ID 交给 `switchRelayProfile`，保留切换前快照与锁定流程。
- `apps/codex-plus-manager/src/provider-types.ts`：`BackendSettings`、`ToolShard`、`RelayProfile` 及其关联类型；不从 `App.tsx` 反向导入。
- `apps/codex-plus-manager/src/provider-utils.ts`：供应商首字、模式/协议/倍率标签，以及聚合和系统默认判断的唯一实现。涉及配置解析、聚合归一化的摘要仍由 `App.tsx` 生成。
- `apps/codex-plus-manager/src/provider-config.ts`：导入与编辑共用的配置读取和鉴权 JSON 解析；保留既有 TOML 字段读取兼容规则，`parseProviderAuth` 给出文件/字段错误。后端保存前使用既有 `toml_edit` 检查完整 TOML 语法；仅检查新增或变更的文件，避免历史未修改配置阻断其他设置保存。
- `apps/codex-plus-manager/src/provider-api-keys.ts`：命名 Key 的迁移、归一化、当前项解析及新增 ID 生成；`relayProfileWithNormalizedApiKeys` 对 profile 泛型化，保证 App 侧多出的本地字段不被削掉。供应商编辑页的命名 Key 列表在 `App.tsx` 的 `RelayProfileEditor`（`relay-api-key-*` 类名，样式在 `styles.css`），三处（`apiKeys` / `activeApiKeyId` / `apiKey`）由 `updateApiKeys` 一起写。
- `apps/codex-plus-manager/src-tauri/src/commands/provider_import.rs`：cc-switch 读取/导入、待确认供应商读取/确认/取消五个命令；`commands.rs` 重导出原入口，Tauri 命令名称、参数和返回载荷保持兼容。配置校验也在此边界实施，失败信息不包含配置原文或密钥。
- 当前运行的供应商列表、环境提示与导入操作在 `App.tsx` 的 `RelayProfileList`、`EnvConflictNotice`、`RelayScreen`，供应商卡片沿用 memo 与稳定回调；`components/providers/` 保留可复用组件及其独立回归。上游布局改动迁入运行中的 App 入口。

## 同步风险与验证

供应商级 `webSearchHistoryCompat` 默认关闭，仅作用于非聚合 Responses 供应商；官方供应商须启用混入 API。开启后通过本地协议代理补齐压缩历史所需的搜索工具声明。原生压缩保留 checkpoint，认证失败、限流、服务端错误与截断流直接保留失败结果；Chat 转换无法执行原生搜索时明确拒绝。

通用配置合并在 `relay_config.rs::merge_common_config_into_config` 校验 MCP 条目的 `command/url`。残缺条目先用供应商原配置补缺，仍无传输定义则移除并记诊断；现有连接及新环境变量须保留。上游已撤下本地插件市场缓存释放与自动注册，配置应用保持用户自己配置的插件条目。相关用例见 `tests/relay_config.rs`。

上游渠道保护已移除：旧 `rateLimitCooldownEnabled`、`channelQueueEnabled`、`channelRequestsPerMinute`、`cooldownErrorStatuses` 不再参与排队、冷却或重试。协议代理保留个人版环回直连与请求体复用；官方 OAuth 测试端点也按实际 URL 判定直连，公网端点仍使用系统代理。

协议代理的请求避震由 `protocolProxyAutoRetry*` 控制，覆盖可重试的流内容量错误，以及用户选定的 HTTP 错误码；默认 HTTP 列表为空，已交付给客户端的输出不自动重放。`streaming`、`streaming-legacy` 与 `buffered` 沿用上游模式，`request_log.rs` 和 `84-proxy-request-status.js` 共用请求日志及状态入口。目录外模型映射默认关闭；供应商的 `autoReviewModel` 对 `codex-auto-review` 优先，官方纯 OAuth 和聚合不应用目录外映射。

供应商代理保存为状态目录的 `relay-proxies.json`，可用 `CODEX_PLUS_PROXY_<ID>` 和进程级 `CODEX_PLUS_PROXY` 覆盖。`http_client.rs::client_for_profile_url` 同时核对目标 URL、供应商代理及系统 PAC，所有环回目标显式直连；连接池按运行时、UA、代理与超时隔离，CA 配置沿用 `CODEX_CA_CERTIFICATE`。提示前缀稳定器由 `relay-features.json` 按供应商显式启用。上述两个旁路文件与日志不随自选设置文件路径迁移。

Claude Code 网关接入通过 `gateway/apply.rs` 和 `tools/claude.rs` 写入关键配置，退出或断开按接入前快照还原；检测到外部工具已接管时不覆盖新选择。会话删除不借用供应商切换入口。

切换、导入或升级迁移时同时检查扁平字段和 `tools.codex`，防止旧镜像覆盖新配置；不能仅凭界面显示“系统默认”就认定实际配置已应用。

验证：`crates/codex-plus-core/tests/local_config_provider.rs`、前端 `local-config-provider.test.ts`，以及供应商切换相关测试。

`crates/codex-plus-core/tests/relay_switch.rs` 覆盖换 Key 的两条路径：`key_only_switch_*` 用例验证只改落点、`config.toml` 逐字节不变、落点不唯一/环境变量介入时拒绝且设置文件不动。落点判定要读进程环境变量，该文件内的相关用例共用 `API_KEY_ENV_LOCK` 串行化。

`provider-components.test.ts` 执行真实组件的按钮、拖拽回调和 App 的列表切换接线，验证同步顺序、旧供应商 ID 和禁用条件。类型契约读取 `provider-types.ts` 的 AST；迁移后须更新测试入口，不能在注释中复制旧代码来满足断言。新增含翻译调用的模块须加入 `tools/i18n-verify.mjs` 的扫描清单。

`provider-save.test.ts` 覆盖连续保存、与切换互斥、保存期间新编辑、失败保留草稿及重试；`provider-config.test.ts` 覆盖官方鉴权、损坏 JSON、字段类型和多供应商 TOML 读取。Rust 导入模块测试验证完整语法检查与历史配置兼容。

## 供应商身份与回滚

自动回填使用 `RelayBackfillPolicy::PreserveIdentity`，未知端点漂移返回错误并保留配置副本；明确属于其他已保存供应商的 live 配置不写入旧供应商。显式采纳完整 live 身份使用 `AdoptLiveIdentity`，端点与凭据一起采用，命名 Key 更新为该身份的导入条目，不沿用旧供应商 Key 或自定义鉴权头。

官方配置统一调用 `relay_config.rs::apply_official_profile_to_home`，净化认证与代理字段后恢复官方非认证设置、公共配置和模型目录。切换失败通过 `SettingsStore::snapshot_raw_bytes` / `restore_raw_snapshot` 恢复精确字节，保留未知字段与密文并失效设置缓存；配置读取、输入序列化、落盘序列化均限制为 16 MiB。旧配置损坏或超限时拒绝覆盖。用例在 `relay_config_safety.rs`、`relay_switch.rs`、settings 单测。

cc-switch 数据库路径 `ccsDbPath` 由共用类型与默认设置提供，后端在 `commands/provider_import.rs::load_ccs_providers` 读取，并返回实际路径和回退原因。

本地 Responses 代理遇到明确拒绝 `custom exec` 的响应时，通过 `responses_exec.rs` 转为 function 工具并重试一次，JSON 与 SSE 响应分别还原为 custom 工具事件。`responses_exec_transport.rs` 管理协商缓存，`responses_exec_sse.rs` 处理流式事件；`protocol_proxy.rs` 与 `launcher.rs` 仍是请求及 HTTP 转发入口，沿用个人版的来源检查和 CORS。验证见 `responses_exec_compatibility.rs` 与 helper 转发测试。

网关供应商的 `gateway_proxy` 由 `relay_proxy::proxy_for_relay` 解析，不读取同 ID 的直连代理配置。`http_client::client_for_relay_url` 以实际目标 URL 判断环回，环回显式直连，其余保持供应商代理、PAC 与连接池；模型发现、协议转换和测试请求使用同一规则。

供应商级 `multiAgent`、`stripImageGenerationTool`、`localCompactionPromptAtEnd` 与聚合审批成员 `autoReviewRelayId` 由共用类型保存。xAI 的请求整理与工具还原沿用 `xai_responses.rs`；审批模型、起名模型、网关模型窗口和思考档位不改变个人版显式窗口覆盖规则。
