# 个人版会话管理

## 列表分页和缓存

- 列表接口保留 `offset`、`limit`、`hasMore`、`totalCount`；按更新时间降序、ID 降序排列，跨库同 ID 取较新的记录，时间相同则保留候选库顺序。子会话过滤规则与原数据适配器共用。
- `crates/codex-plus-data/src/storage/session_paging.rs` 的 `LocalSessionPager` 缓存 ID、排序键、来源和去重总数，翻页只读取本页 ID 的详情；不再每页从头加载 `offset + limit` 条完整会话。首次查询、库变化或缓存到期仍需重建轻量索引，缓存内存随会话数增长。
- 缓存同时检查数据库及 WAL/SHM 的文件信息和头部变化，最多复用 30 秒，避免只观察主数据库文件漏掉 WAL 提交。查询使用短读事务并及时释放连接，不在窗口闲置时占用数据库句柄。跨库没有共同事务快照，外部写入期间不承诺多次翻页结果冻结。
- Tauri `list_local_sessions` 通过 `spawn_blocking` 执行查询，沿用原返回结构；单库损坏或读取失败仍报告部分失败并保留健康库结果，不能把缓存旧数据当作成功结果。
- `storage.rs` 共用字段映射和详情读取代码；同步上游时不得在 `commands.rs` 恢复另一套全量 ID 计数和从头读取的实现。

验证：`storage/session_paging/tests.rs` 覆盖深分页、重复 ID、排序边界、WAL 更新、缓存期限、库替换及部分失败；Tauri 会话列表测试验证命令响应。删除、导入、恢复后继续复核总数和页面是否同步更新。

## 隐藏失效会话

Codex 内“检查并隐藏失效会话 / 显示已隐藏会话”只影响显示，不删数据。后端找不到 rollout、归档或备份恢复来源后，还须本机 `thread/read` 明确确认；接口缺失、超时、权限错误不能视为失效。

隐藏 ID 存在 `codex3n.hiddenInvalidSessions.v1`，可以恢复显示，重启后先复核再应用。远程会话和仍在内存中尚未落盘的会话不能误隐藏。

## 管理器删除

- 单删和批删共用备份删除链路。删除涉及 SQLite、rollout、会话索引和新版侧栏目录；计数减少不等于完整成功，部分失败仍须报告。
- Tauri 返回顶层 `status/message` 表示命令结果，领域结果放在 `deletion` 内，包含 `local_deleted/partial/failed` 和备份信息。不能再扁平化同名字段，否则批删会把成功误报为失败。
- “删除无效会话”检查全量本地数据库，不只当前页。用户确认后逐项重扫、备份并删除，相关 Codex 应用必须保持退出。
- 远程、归档、有恢复文件或备份的会话受保护；确认期间恢复的会话跳过，进程重新启动时停止。中途停止仍保留已完成数量和剩余失败原因。
- 清理只针对数据库能列出的本地会话，不承诺清除所有仅存在于侧栏或索引的残留。不要直接使用当前页或隐藏名单作为删除依据。

## 代码入口

- `assets/inject/renderer-inject.js`：`checkAndHideInvalidSessions` 及隐藏状态管理。
- `crates/codex-plus-core/src/routes.rs`：`/session/health`；`crates/codex-plus-data/src/session_health.rs`：恢复来源检查。
- `apps/codex-plus-manager/src/App.tsx`：会话管理；`apps/codex-plus-manager/src-tauri/src/commands.rs`：`delete_local_session`、`preview_invalid_local_sessions`、`delete_invalid_local_sessions`。
- `crates/codex-plus-data/src/storage.rs` / `backup.rs` / `provider_sync.rs`：删除、撤销、快照限长及索引维护。

## 回归检查

前端 `session-health.test.ts` / `session-delete-flow.test.ts`，数据层 `session_health.rs` / `storage_adapter.rs` / `provider_sync.rs`，Tauri 删除响应序列化及无效会话保护测试。需要重点覆盖远程、归档、备份、读取错误、恢复竞态、重复库记录与部分失败。
