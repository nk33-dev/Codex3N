# Codex3N 个人业务与代码导航

本目录说明个人版相对上游的业务差异，不是上游功能大全。先读业务约束，再沿代码入口查实现；不要只凭历史提交认定功能还在。

## 如何维护

- 新增、调整、移除个人功能时，在同一提交更新这里的行为、入口和验证方式。删除过时描述，不堆积历史清单。
- 合并上游前记录关键入口、配置字段和测试基线；合并后核对运行时契约，不能只看 Git 无冲突或编译成功。
- 以下路径均相对于仓库根目录；历史 `git log main..personal` 只用于解释缘由，当前代码和测试才是事实依据。

## 业务索引

| 个人业务 | 用户行为与约束 | 主要代码入口 | 验证入口 |
| --- | --- | --- | --- |
| 无广告个人版 | 不展示管理器推荐/赞助内容，不启动原广告获取链路；不是浏览器通用广告拦截器 | `apps/codex-plus-manager/src/App.tsx`、`apps/codex-plus-launcher/src/main.rs`、`crates/codex-plus-core/src/routes.rs` | 同步上游时检查广告模块、推荐接口和推广 UI 是否被重新引入 |
| 系统默认供应商 | 首次将本机 config.toml / auth.json 导入为普通可选供应商，尊重总开关，不重复覆盖配置 | `crates/codex-plus-core/src/provider_import.rs` 的 `initialize_local_config_provider`、`settings.rs` | `crates/codex-plus-core/tests/local_config_provider.rs`、前端同名测试 |
| 模型菜单兼容与排序 | 保留模型选择，去掉额外管理/未测试提示；原生与供应商目录按设置合并，代码模型按版本降序、图像放最后 | `assets/inject/renderer-inject.js` 的 `patchModelArray`、`sortModelChoices`、RPC 适配；`model_catalog.rs` / `model_suffix.rs` | 前端 `model-order.test.ts`、`model-rpc-compat.test.ts`、`renderer-model-runtime.test.ts`；Rust `model_catalog` / `cdp_bridge` 测试 |
| 失效会话隐藏 | Codex 内检查并隐藏 / 恢复显示；不删除数据，只隐藏明确失效的本机条目 | 注入脚本 `checkAndHideInvalidSessions`、`/session/health`、`crates/codex-plus-data/src/session_health.rs` | 前端 `session-health.test.ts` 和数据层 `session_health.rs` 测试 |
| 管理器会话删除 | 单删/批删共用备份删除链路；按命令结果统计，失败显示原因 | `App.tsx` 的 `deleteLocalSessions`、Tauri `delete_local_session`、数据层 `storage.rs` | `session-delete-flow.test.ts`、Tauri 删除响应序列化测试、`storage_adapter.rs` |
| 删除无效会话 | 全量扫描本地数据库，不局限当前页；确认后再次核验、备份并清理，要求相关应用保持退出 | Tauri `preview_invalid_local_sessions` / `delete_invalid_local_sessions` | Tauri `invalid_session_preview_protects_running_archived_and_recovered_sessions` 及数据层健康检查测试 |
| 增强页保存与悬浮球 | 开关统一改草稿，保存栏持续显示至保存；错误态为平静短眼形，保留微笑、拖拽、展开、大纲/建议 | `App.tsx` 的 `EnhanceScreen`、`assets/inject/floating-panel/core/appearance.js` | `session-delete-flow.test.ts`、`crates/codex-plus-core/tests/floating_panel_outline.rs` |
| 配置和数据保护 | 设置写入加锁、唯一临时文件、损坏内容隔离；快照限长，删除/撤销不吞错误，目录版本号兼容 | `crates/codex-plus-core/src/settings.rs`、`crates/codex-plus-data/src/backup.rs` / `storage.rs` / `provider_sync.rs` | 设置单元测试、`storage_adapter.rs`、`provider_sync.rs` |
| 个人更新与安装维护 | 更新源固定为 Codex3N；安装失败如实报告，Watcher 按安装实例处理进程 | `crates/codex-plus-core/src/update.rs` / `install/` / `watcher.rs` | `updater.rs`、`installers.rs`、`watcher.rs` |

## 关键业务边界

### 供应商接管必须由用户开启

`providerSyncEnabled` 和 `relayProfilesEnabled` 默认关闭，首次导入本地配置不应自动启用代理或改写当前配置。自定义供应商及配置导入入口在管理器的供应商页，持久化由 `provider_import.rs`、`settings.rs`、`relay_config.rs` / `relay_switch.rs` 负责；供应商切换/导入时同步检查配置分片，不能把旧 `tools.codex` 镜像覆盖回新配置。


### 模型目录不是默认模型配置

排序发生在注入层合并原生与供应商模型之后，不改供应商配置顺序或默认模型标记。当前示例：Astra 6 → 5.6 Sol / Terra / Luna → 5.5 → 5.3 Spark；图像系列单独放最后、版本降序。未知模型保留，不硬编码白名单。

关注 `codexAppModelWhitelistUnlock`、`codexAppIncludeNativeModels`、`relayProfilesEnabled`、`localConfigProviderImported` 和 `tools.codex` 配置分片。RPC 对象可能不可写，须走现有适配器；本机供应商目录不能注入远程主机。

### 隐藏失效会话和删除无效会话不同

- **隐藏**：应用运行时，后端找不到 rollout/归档/备份来源后，还要本机 `thread/read` 确认。接口缺失、超时、权限问题不能判失效。隐藏 ID 使用 `codex3n.hiddenInvalidSessions.v1`，可恢复显示，重启先复核。
- **删除**：管理器要求相关应用退出，避免仍在内存中的会话被误判。不使用当前页或隐藏名单直接删除；全量扫描，只清理可确认的本机记录。远程、归档、有恢复文件或备份的记录受保护。确认后逐项重扫；会话恢复时跳过，进程重新启动时停止。
- 删除会改 SQLite、rollout、会话索引和新版侧栏目录，沿用备份机制。计数减少不等于完整成功，部分清理失败仍须报告。当前管理器清理仅针对数据库能列出的本地会话，不承诺清除所有仅存在于侧栏/索引的残留。
- Tauri 删除响应的顶层 `status/message` 是命令结果；领域结果在 `deletion` 内，包含 `local_deleted/partial/failed` 和备份信息。禁止再将带同名字段的 `DeleteResult` 扁平化，否则会覆盖 `ok`，导致批删误报。

### 上游同步与文档范围

会话导出、Stepwise、大纲、插件市场等大部分能力源自上游；这里只记录个人版兼容与交互差异，不把它们都算作个人原创。原广告模块已删除，不列成可启用功能；合并时检查广告业务是否被重新带回。普通插件/社区链接不等同于广告。

保留手动保存语义：增强页的 Stepwise、回答大纲和桌宠开关不再偷偷提交整个表单；点击保存后同步配置。不要重新加入“部分自动保存、部分手动保存”的混合行为。

## 发布检查

在 `personal` 更新 Cargo 版本及锁文件，提交干净工作区后运行 `pwsh scripts/release.ps1 -NotesFile <UTF-8说明>`。脚本测试失败必须停止；GitHub 操作显式指定 `nk33-dev/Codex3N`。Release 创建成功后默认结束，不等待安装包构建。

本次整理基线：`1.3.0-3n.4`。版本号只用于定位整理时点，不代替后续同步维护。
