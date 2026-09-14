# 供应商与本地配置

## 业务行为

- 首次将本机 `config.toml` / `auth.json` 导入为普通可选的“系统默认”供应商，不重复覆盖用户配置。
- 自定义供应商及配置导入入口在管理器供应商页。
- `providerSyncEnabled` 和 `relayProfilesEnabled` 默认关闭；首次导入不应自动启用代理或接管当前配置。
- 供应商切换从读取当前配置快照开始即锁定操作，完成或失败后释放，避免重复点击排队执行旧切换请求。
- 设置保存与供应商切换共用互斥检查，重复保存不会排队；保存失败保留草稿，保存/切换的旧响应不覆盖期间产生的新编辑。供应商详情在保存或切换期间禁用编辑、返回和再次操作，销毁后的保存结果不再触发旧页面回调。

## 代码入口与配置

- `crates/codex-plus-core/src/provider_import.rs`：`initialize_local_config_provider`，关注 `localConfigProviderImported`。
- `crates/codex-plus-core/src/settings.rs`：供应商持久化与工具配置分片。
- `crates/codex-plus-core/src/relay_config.rs` / `relay_switch.rs`：配置应用与切换。
- `apps/codex-plus-manager/src/App.tsx`：供应商页状态、配置保存与切换编排。列表的 `onSwitch` 先调用 `syncLegacyRelayFields` 同步目标配置，再将结果和旧供应商 ID 交给 `switchRelayProfile`，保留切换前快照与锁定流程。
- `apps/codex-plus-manager/src/provider-types.ts`：`BackendSettings`、`ToolShard`、`RelayProfile` 及其关联类型；不从 `App.tsx` 反向导入。
- `apps/codex-plus-manager/src/provider-utils.ts`：供应商首字、模式/协议/倍率标签，以及聚合和系统默认判断的唯一实现。涉及配置解析、聚合归一化的摘要仍由 `App.tsx` 生成。
- `apps/codex-plus-manager/src/provider-config.ts`：导入与编辑共用的配置读取和鉴权 JSON 解析；保留既有 TOML 字段读取兼容规则，`parseProviderAuth` 给出文件/字段错误。后端保存前使用既有 `toml_edit` 检查完整 TOML 语法；仅检查新增或变更的文件，避免历史未修改配置阻断其他设置保存。
- `apps/codex-plus-manager/src-tauri/src/commands/provider_import.rs`：cc-switch 读取/导入、待确认供应商读取/确认/取消五个命令；`commands.rs` 重导出原入口，Tauri 命令名称、参数和返回载荷保持兼容。配置校验也在此边界实施，失败信息不包含配置原文或密钥。
- `apps/codex-plus-manager/src/components/providers/`：`ProviderImportActions`、`EnvConflictNotice`、`RelayProfileList` 分别负责导入操作栏、环境冲突提示和可拖拽列表。组件通过明确的操作回调连接业务；列表不直接操作 Tauri 或同步配置，也不接收整个 `Actions` 对象。

## 同步风险与验证

切换、导入或升级迁移时同时检查扁平字段和 `tools.codex`，防止旧镜像覆盖新配置；不能仅凭界面显示“系统默认”就认定实际配置已应用。

验证：`crates/codex-plus-core/tests/local_config_provider.rs`、前端 `local-config-provider.test.ts`，以及供应商切换相关测试。

`provider-components.test.ts` 执行真实组件的按钮、拖拽回调和 App 的列表切换接线，验证同步顺序、旧供应商 ID 和禁用条件。类型契约读取 `provider-types.ts` 的 AST；迁移后须更新测试入口，不能在注释中复制旧代码来满足断言。新增含翻译调用的模块须加入 `tools/i18n-verify.mjs` 的扫描清单。

`provider-save.test.ts` 覆盖连续保存、与切换互斥、保存期间新编辑、失败保留草稿及重试；`provider-config.test.ts` 覆盖官方鉴权、损坏 JSON、字段类型和多供应商 TOML 读取。Rust 导入模块测试验证完整语法检查与历史配置兼容。
