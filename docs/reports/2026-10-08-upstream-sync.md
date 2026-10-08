# 上游同步审查

- 原个人提交：`965bcc08ee26998382c18962de42216e9f5985f1`。
- 已验证上游基线：`0a5fa537d98cf51a5e6205742d8b18699bd7c5dd`（v1.5.4，个人提交 push CI 成功）。
- 目标上游：`0b8ba5fdc4e6b6629fa86a48eb9a3a48a2a1f806`，包含 v1.6.0 与后续修复。审查基线到目标全部 90 个文件，包括删除、锁文件、安装器及发布工作流。
- 独立同步分支：`codex/sync-1.6.0`，保留上游合并祖先；发布版本 `1.6.0-3n.1`。
- 本机 Windows，Codex Desktop `26.930.7945.0`，Codex CLI `0.160.0`。测试使用 Node `22.23.3` 与 Git for Windows Bash；首次前端基线使用 bundled Node `24.19.0`，最终验证使用 CI 同主版本 Node 22。

## 重叠入口

| 上游入口 | 当前运行位置与处理 | 回归 |
| --- | --- | --- |
| App 内设置类型与默认值 | 新 dictation、ccsDbPath、渠道字段迁入 provider-types.ts / lib/default-settings.ts；App 共用这些定义 | 类型检查、local-config-provider、provider-components |
| EnhanceScreen / settings 导航 | 保留 App 标签布局、共用保存互斥；增强深链经 enhancement-navigation.ts 与 manager-loading.ts，保留导航 revision | enhancement-settings、manager-navigation、provider-save |
| 供应商编辑 | App 的 RelayProfileEditor 保留命名 Key 三字段同步；RelayProfileDetail 保存与切换互斥，销毁后忽略旧回调 | provider-api-keys、provider-save、relay_switch |
| commands.rs 导入 / Dream Skin | 导入继续使用 commands/provider_import.rs，新增缓存扫描命令在 commands.rs；皮肤命令保留 commands/dream_skin.rs 唯一注册 | cc-switch、Dream Skin、agent_cache |
| SettingsStore | 上游 16 MiB 输入与文件预算、精确字节回滚接入个人加密、写锁及缓存失效；dictation.apiKey 加密且桥接脱敏 | settings、dictation、relay_config_safety |
| 供应商回填 / 官方恢复 | PreserveIdentity 保留端点身份，已知其他供应商跳过回填；AdoptLiveIdentity 同时采用 live URL 与命名 Key；官方统一 apply_official_profile_to_home | relay_config_safety、relay_config、relay_switch |
| renderer / RPC | 按上游 manifest 拼装 19 个分片；语音 UI 安装与插件关闭还原接入同一扫描；主机身份与共享模型快照恢复保留个人排序和原生模型开关 | dictation-runtime、renderer-model-runtime、model-rpc-compat、cdp_bridge |
| 删除请求 | SessionRef 与桥接、启动器同时核对 host_id，管理器本机删除仍使用 deletion 包装、备份及无效会话重扫 | bridge_routes、session-health、session-delete-flow、数据层测试 |
| 代理 / 桥接 | 会话头白名单、上游流终态处理、Debugger enable 重试与代际取消迁入个人入口；环回请求使用 client_for_url 直连 | protocol_proxy、launcher、bridge |
| 安装与发布 | 保留 Codex3N 包名、校验和、CI 门禁与 ad-hoc；接入 NSIS 重试校验及按平台补跑；macOS 原生更新测试加入产包前门禁 | release、installers、updater、macOS CI |

上游撤下的 Zed、Upstream 工作树、强制中文、原生菜单汉化、快速启动及本地插件市场注册入口同步停用；旧文件仅作为兼容或历史源码存在，不恢复运行注册。管理器广告与推荐入口按个人契约移除，不启动对应加载链路。个人业务文档同步当前入口。

## 数据与恢复

未改写活动用户配置、会话数据库或缓存。配置预算、损坏文件拒绝覆盖、密钥加密与精确回滚均使用临时副本验证；供应商、目录与删除测试使用临时 SQLite。旧版本可忽略 dictation 字段，但旧代码对超限配置、撤下功能与新更新事务的处理不保证兼容；恢复依靠原配置、secret.key、live 文件及既有一致性备份，代码回退不能代替数据恢复。

## 本地验证

基线前端 `npm ci`、`npm test`（503 通过、1 跳过）、类型检查、Vite 构建及 Rust fmt/check 通过；基线全量 Rust 有 Stepwise 空响应回退、Responses compact 两项失败。日志保存在本机临时目录 `codex3n-sync-1.6.0`。

最终 Rust `cargo fmt --check`、`cargo check --workspace`、`cargo test --workspace --no-fail-fast` 通过（1942 通过、8 跳过）。管理器 `npm ci`、`npm test`（530 通过、1 跳过）、`npm run check`、npm 高风险审计及 Vite 构建通过；新增供应商详情并发/销毁回归通过。relay Clippy、cargo audit（8 项允许警告）、renderer/native inspector 产物校验及 macOS Bash 语法检查通过。

合并回归发现语音 UI 初始化提前返回、插件关闭还原缺失、跨主机共享模型缓存恢复与旧测试依赖问题，均按当前运行行为处理。Responses compact 模拟服务现在读满 Content-Length 再关闭连接；Stepwise 本地测试请求时限提高到 10 秒，业务默认时限不变。

发布前校验最终 personal SHA 的全部 push CI；macOS 原生签名复制及真实 DMG 安装/回滚用例在 macOS job 的临时目录运行。Windows/macOS/Linux 桌面宿主安装、升级及真实录音交互未实机验证，CI 产包与模拟不能代替这些验证。
