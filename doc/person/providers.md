# 供应商与本地配置

## 业务行为

- 首次将本机 `config.toml` / `auth.json` 导入为普通可选的“系统默认”供应商，不重复覆盖用户配置。
- 自定义供应商及配置导入入口在管理器供应商页。
- `providerSyncEnabled` 和 `relayProfilesEnabled` 默认关闭；首次导入不应自动启用代理或接管当前配置。
- 供应商切换从读取当前配置快照开始即锁定操作，完成或失败后释放，避免重复点击排队执行旧切换请求。
- 设置保存与供应商切换共用互斥检查，重复保存不会排队；保存失败保留草稿，保存/切换的旧响应不覆盖期间产生的新编辑。供应商详情在保存或切换期间禁用编辑、返回和再次操作，销毁后的保存结果不再触发旧页面回调。
- “恢复官方登录”复用官方供应商和已有切换入口，遵守供应商总开关及切换锁。管理器回填遇到损坏的 live TOML 返回 `degraded` 并保留原供应商快照；回填成功后才提交工作副本。核心切换仍独立验证 live 配置，失败时保留文件并报告原因。
- 切换会保留用户插件表；纯 API 供应商使用 OpenAI 会话身份时，合并 live OAuth 登录态，普通纯 API 供应商仍按自身鉴权配置应用。
- 普通 API 供应商支持多个命名 Key，`apiKeys` 保存条目，`activeApiKeyId` 指向当前项；旧 `apiKey` 配置自动迁移为“默认”条目。Key 内容继续按密钥字段规则加密落盘。
- Codex++ 轻量页面只读取 Key 的 ID 和名称，不返回密钥正文；配置多个 Key 后，模型选择器旁显示当前 Key 名称作为快捷入口。密钥页用下拉框列出当前供应商的命名 Key，选中项即当前 Key；只有切换请求进行中才禁用。`/relay-api-keys` 的 `activeKeyId` 以 live 配置里实际的 Key 为准（`live_codex_api_key_in_home` 读取 `auth.json` 的 `OPENAI_API_KEY` 或 config.toml 的 bearer token，再匹配命名 Key），匹配不上时回退到存档目标项并返回 `liveKeyMatched: false`，页面据此提示“实际在用的 Key 不在列表里”——总开关关闭时存档的 `activeApiKeyId` 可能停在最后添加的那个 Key。后端读不到 live 时不返回该字段，页面不做匹配提示。切换当前 Key 通过 `/relay-api-keys/select` 更新供应商存档和 live 配置，无需退出或重启 Codex；切换完成后前端强制刷新模型目录。轻量页面每次打开都会重建 DOM，`loadRelayApiKeys` 命中缓存分支时也要重画一次，否则页面会一直停在模板里的“正在读取当前供应商…”；读取异常或桥接超时会显示失败状态并停止自动重试，避免心跳重复请求。
- 换 Key 分两条路径，由 `relayProfilesEnabled` 决定：开关打开时沿用整份供应商配置应用（`switch_relay_profile_in_home`）；开关关闭时走只改 Key 的窄路径 `set_live_api_key_only_in_home`，只更新 Key 的落点，`config.toml` 与 `auth.json` 另一个文件一个字节都不动，写前同样留 `~/.codex/backups/codex-plus-live-*` 备份。
- 窄路径先由 `live_api_key_target_in_home` 判定落点：`auth.json` 的 `OPENAI_API_KEY`，或 `config.toml` 里 Codex++ 写入的 `experimental_bearer_token`。落点不唯一（两处都有 Key）、Key 写在 `api_key`/`bearer_token` 等非标准字段、供应商用 `env_key` 声明 Key 来自环境变量、或通用环境变量（`OPENAI_API_KEY` 等，优先级高于 `auth.json`）已设置时，一律报错拒绝，不做“写了但 Codex 没读”的假成功。Key 在环境变量里的情况只能改环境变量本身，或改用整份切换。

## 代码入口与配置

- `crates/codex-plus-core/src/provider_import.rs`：`initialize_local_config_provider`，关注 `localConfigProviderImported`。
- `crates/codex-plus-core/src/settings.rs`：供应商持久化与工具配置分片。
- `crates/codex-plus-core/src/relay_config.rs` / `relay_switch.rs`：配置应用与切换。`relay_switch::select_active_relay_api_key_in_home` 按总开关分流；`relay_config::live_api_key_target_in_home` / `set_live_api_key_only_in_home` 是窄路径的落点判定与写入。`API_KEY_ENV_KEYS`、`PROVIDER_TOKEN_KEYS`、`PROVIDER_ENV_KEY_KEYS` 在这里定义，模型目录的 `provider_api_key` 复用同一份清单，不再各写一套。
- `crates/codex-plus-core/src/routes.rs`：`/relay-api-keys` 提供脱敏列表，`/relay-api-keys/select` 执行当前供应商 Key 切换。
- `assets/inject/renderer-inject/80-session-share.js` 的 `installCodexRelayApiKeyBadge`、`refreshCodexRelayApiKeyBadges` 在主 IIFE 提供 Key 快捷入口；类名/版本在 `00-prelude.js`，样式在 `10-style.js`，读取和切换在 `40-backend-settings.js`。安装会复用已有按钮；少于两个 Key 时移除，点击打开 `apiKeys` 页面。按钮及其子节点在 `98-scan-schedule.js` 的 `isExtensionUiNode` 排除，文字刷新不会触发宿主扫描。
- `apps/codex-plus-manager/src/App.tsx`：供应商页状态、配置保存与切换编排。列表的 `onSwitch` 先调用 `syncLegacyRelayFields` 同步目标配置，再将结果和旧供应商 ID 交给 `switchRelayProfile`，保留切换前快照与锁定流程。
- `apps/codex-plus-manager/src/provider-types.ts`：`BackendSettings`、`ToolShard`、`RelayProfile` 及其关联类型；不从 `App.tsx` 反向导入。
- `apps/codex-plus-manager/src/provider-utils.ts`：供应商首字、模式/协议/倍率标签，以及聚合和系统默认判断的唯一实现。涉及配置解析、聚合归一化的摘要仍由 `App.tsx` 生成。
- `apps/codex-plus-manager/src/provider-config.ts`：导入与编辑共用的配置读取和鉴权 JSON 解析；保留既有 TOML 字段读取兼容规则，`parseProviderAuth` 给出文件/字段错误。后端保存前使用既有 `toml_edit` 检查完整 TOML 语法；仅检查新增或变更的文件，避免历史未修改配置阻断其他设置保存。
- `apps/codex-plus-manager/src/provider-api-keys.ts`：命名 Key 的迁移、归一化、当前项解析及新增 ID 生成。
- `apps/codex-plus-manager/src-tauri/src/commands/provider_import.rs`：cc-switch 读取/导入、待确认供应商读取/确认/取消五个命令；`commands.rs` 重导出原入口，Tauri 命令名称、参数和返回载荷保持兼容。配置校验也在此边界实施，失败信息不包含配置原文或密钥。
- `apps/codex-plus-manager/src/components/providers/`：`ProviderImportActions`、`EnvConflictNotice`、`RelayProfileList` 分别负责导入操作栏、环境冲突提示和可拖拽列表。组件通过明确的操作回调连接业务；列表不直接操作 Tauri 或同步配置，也不接收整个 `Actions` 对象。

## 同步风险与验证

切换、导入或升级迁移时同时检查扁平字段和 `tools.codex`，防止旧镜像覆盖新配置；不能仅凭界面显示“系统默认”就认定实际配置已应用。

验证：`crates/codex-plus-core/tests/local_config_provider.rs`、前端 `local-config-provider.test.ts`，以及供应商切换相关测试。

`crates/codex-plus-core/tests/relay_switch.rs` 覆盖换 Key 的两条路径：`key_only_switch_*` 用例验证只改落点、`config.toml` 逐字节不变、落点不唯一/环境变量介入时拒绝且设置文件不动。落点判定要读进程环境变量，该文件内的相关用例共用 `API_KEY_ENV_LOCK` 串行化。

`provider-components.test.ts` 执行真实组件的按钮、拖拽回调和 App 的列表切换接线，验证同步顺序、旧供应商 ID 和禁用条件。类型契约读取 `provider-types.ts` 的 AST；迁移后须更新测试入口，不能在注释中复制旧代码来满足断言。新增含翻译调用的模块须加入 `tools/i18n-verify.mjs` 的扫描清单。

`provider-save.test.ts` 覆盖连续保存、与切换互斥、保存期间新编辑、失败保留草稿及重试；`provider-config.test.ts` 覆盖官方鉴权、损坏 JSON、字段类型和多供应商 TOML 读取。Rust 导入模块测试验证完整语法检查与历史配置兼容。
