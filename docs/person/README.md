# Codex3N 个人功能业务索引

本目录只记录个人版当前仍存在、可触发、可验证的业务功能，帮助同步上游和后续 AI 快速理解业务、代码入口、配置字段与兼容边界。

## 维护规则

- 功能删除、重命名或入口变化时，同一提交同步更新本文档。
- 文档不能代替测试；代码和测试优先，发现不一致立即修正文档。
- 重点记录业务目的、用户入口、代码入口和维护风险，不堆实现细节。

## 当前功能

### Codex++ 增强与个人版注入

- 入口：`apps/codex-plus-manager/src/App.tsx` 的“Codex增强”页面。
- 注入：`assets/inject/renderer-inject.js`、`assets/inject/floating-panel-inject.js`。
- 配置：`BackendSettings` 中的 `enhancementsEnabled` 与 `codexApp*` 字段。
- 业务：会话管理、导出、插件/模型增强、悬浮球，以及个人版界面整理。

### 模型目录排序

- 入口：`crates/codex-plus-core/src/model_catalog.rs`。
- 业务：模型列表使用稳定的个人版可读顺序，避免上游返回顺序导致 Terra 抢到第一项。
- 当前优先级：Astra、Terra、Sol、Luna、5.5、Codex Spark、Image，其余模型置后。

### 会话管理与失效会话

- 管理入口：`apps/codex-plus-manager/src/App.tsx` 的“会话管理”。
- 运行时入口：`assets/inject/renderer-inject.js` 的 `/session/health` 检查、隐藏和恢复逻辑。
- 后端入口：`crates/codex-plus-core/src/routes.rs` 的 `/session/health`。
- 约束：只有本机 `thread/read` 明确确认不存在才隐藏；连接失败、远程会话和权限错误不能当作失效。

### 个人版界面整理

- 个人版不主动展示不需要的推广或干扰入口；同步上游时重点检查菜单、启动页、模型目录和插件市场注入点。
