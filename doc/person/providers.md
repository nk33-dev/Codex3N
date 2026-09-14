# 供应商与本地配置

## 业务行为

- 首次将本机 `config.toml` / `auth.json` 导入为普通可选的“系统默认”供应商，不重复覆盖用户配置。
- 自定义供应商及配置导入入口在管理器供应商页。
- `providerSyncEnabled` 和 `relayProfilesEnabled` 默认关闭；首次导入不应自动启用代理或接管当前配置。
- 供应商切换从读取当前配置快照开始即锁定操作，完成或失败后释放，避免重复点击排队执行旧切换请求。

## 代码入口与配置

- `crates/codex-plus-core/src/provider_import.rs`：`initialize_local_config_provider`，关注 `localConfigProviderImported`。
- `crates/codex-plus-core/src/settings.rs`：供应商持久化与工具配置分片。
- `crates/codex-plus-core/src/relay_config.rs` / `relay_switch.rs`：配置应用与切换。
- `apps/codex-plus-manager/src/App.tsx`：供应商页和导入入口。

## 同步风险与验证

切换、导入或升级迁移时同时检查扁平字段和 `tools.codex`，防止旧镜像覆盖新配置；不能仅凭界面显示“系统默认”就认定实际配置已应用。

验证：`crates/codex-plus-core/tests/local_config_provider.rs`、前端 `local-config-provider.test.ts`，以及供应商切换相关测试。
