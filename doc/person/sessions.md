# 个人版会话管理

## 列表分页和缓存

管理器 `ManagementExtra.tsx::SessionPage` 按项目或时间分组，支持搜索、详情、分页和批删。`App.tsx::SessionMaintenance` 保留供应商同步、索引修复报告及全量无效会话清理，列表与维护共用原动作和备份删除链路。

- 列表接口保留 `offset`、`limit`、`hasMore`、`totalCount`；按更新时间降序、ID 降序排列，跨库同 ID 取较新的记录，时间相同则保留候选库顺序。子会话过滤规则与原数据适配器共用。
- 历史会话同步提供只读预览：`preview_provider_sync` 统计目标供应商、rollout 与目录影响范围，并返回执行时的备份根目录；预览不加锁、不写 rollout、不改 SQLite。实际同步会补建缺失的 canonical `threads` 行并保留备份路径，失败时返回可诊断的底层原因。
- `crates/codex-plus-data/src/storage/session_paging.rs` 的 `LocalSessionPager` 缓存 ID、排序键、来源和去重总数，翻页只读取本页 ID 的详情；不再每页从头加载 `offset + limit` 条完整会话。首次查询、库变化或缓存到期仍需重建轻量索引，缓存内存随会话数增长。
- 缓存同时检查数据库及 WAL/SHM 的文件信息和头部变化，最多复用 30 秒，避免只观察主数据库文件漏掉 WAL 提交。查询使用短读事务并及时释放连接，不在窗口闲置时占用数据库句柄。跨库没有共同事务快照，外部写入期间不承诺多次翻页结果冻结。
- Tauri `list_local_sessions` 通过 `spawn_blocking` 执行查询，沿用原返回结构；单库损坏或读取失败仍报告部分失败并保留健康库结果，不能把缓存旧数据当作成功结果。
- `storage.rs` 共用字段映射和详情读取代码；同步上游时不得在 `commands.rs` 恢复另一套全量 ID 计数和从头读取的实现。

验证：`storage/session_paging/tests.rs` 覆盖深分页、重复 ID、排序边界、WAL 更新、缓存期限、库替换及部分失败；Tauri 会话列表测试验证命令响应。删除、导入、恢复后继续复核总数和页面是否同步更新。

## 升级后项目与会话关联

- 新版 Codex 的侧栏项目存于 `~/.codex/.codex-global-state.json` 的 `local-projects`、`project-order`、`thread-project-assignments` 和宿主项目 ID 映射；数据库 `state_5.sqlite` 的 `projects`、`project_roots`、`threads.project_id` 存另一份关联。项目消失时先检查两处，不要清空用户目录。
- `codex_app_state.rs` 分别保存旧工作区路径快照与新版项目快照，恢复时不把旧路径当新版项目 ID；新版快照保留此前的项目、ID 映射和会话关联，切换供应商后合并到当前状态，当前项目同 ID 的字段优先。
- 若已升级且当前侧栏只剩少量项目，先运行 `python scripts/restore_codex_projects.py` 只读预览。确认项目数据库仍在、完全退出 Codex 桌面版和管理器后，在独立终端运行 `python scripts/restore_codex_projects.py --apply`。脚本先备份原全局状态与一致性 SQLite 副本到 `~/.codex/backups_state/project-recovery/`，再恢复可明确匹配的项目和会话；显式无项目、已归档、路径不匹配或有歧义的会话不自动归类。重新启动 Codex 后核对侧栏和会话数。

## 隐藏失效会话

Codex 内“检查并隐藏失效会话 / 显示已隐藏会话”只影响显示，不删数据。后端找不到 rollout、归档或备份恢复来源后，还须本机 `thread/read` 明确确认；接口缺失、超时、权限错误不能视为失效。

隐藏 ID 存在 `codex3n.hiddenInvalidSessions.v1`，可以恢复显示。重启后不会立即抢占资源，页面可见且空闲达到复核周期后才检查；自动复核只按已隐藏 ID 查询数据库，手动“检查并隐藏失效会话”和管理器删除预览仍执行全量扫描。远程会话和仍在内存中尚未落盘的会话不能误隐藏。

## 管理器删除

- 单删和批删共用备份删除链路。删除涉及 SQLite、rollout、会话索引和新版侧栏目录；计数减少不等于完整成功，部分失败仍须报告。
- `provider_sync.rs` 的侧栏清理在 `CODEX_HOME/tmp/provider-sync-tombstones.json` 记录删除墓碑，目录修复和 canonical 会话重建均跳过这些 ID；撤销删除时清除对应墓碑。最多保留最近 4096 个 ID，读取失败会退回原修复行为，可能重新出现旧会话。墓碑写入失败记录诊断，删除备份仍由原链路保存。
- Tauri 返回顶层 `status/message` 表示命令结果，领域结果放在 `deletion` 内，包含 `local_deleted/partial/failed` 和备份信息。不能再扁平化同名字段，否则批删会把成功误报为失败。
- “删除无效会话”检查全量本地数据库，不只当前页。确认后只全量扫描一次，再对每个会话用 `recheck_session_health` 单独复核、备份并删除；不能每删一个就全量重扫，否则几百个会话会长时间卡在“处理中”。相关 Codex 应用必须保持退出。
- 新版 Codex 会把旧 rollout 压缩成 `.jsonl.zst`，数据库仍记录原 `.jsonl` 路径。恢复来源检查必须同时认 `.zst` 文件及其文件名里的 ID，否则有内容的会话会被当成无效误删。
- 远程、归档、有恢复文件或备份的会话受保护；确认期间恢复的会话跳过，进程重新启动时停止。中途停止仍保留已完成数量和剩余失败原因。
- 对话内容还在、但项目目录（cwd 为绝对路径且确认不存在）已删除的会话单列为第二类，单独确认后走普通备份删除；目录读取出错、相对路径或已归档的会话不列入。
- 会话页按项目分组时，组标题右侧可删除整个项目的会话：后端 `list_project_local_sessions` 按规范化路径（去 `\\?\`、统一斜杠、去尾斜杠、忽略大小写）在全部本地库中匹配，前端确认后逐个走普通备份删除。
- Codex 删除快照采用上游分离文件格式，默认保留；空间预算不足时拒绝删除。旧内联快照可按份数和时间清理，分离文件快照不参与该清理。
- 清理只针对数据库能列出的本地会话，不承诺清除所有仅存在于侧栏或索引的残留。不要直接使用当前页或隐藏名单作为删除依据。

## 代码入口

- `assets/inject/renderer-inject.js` 的 `checkAndHideInvalidSessions` 及隐藏状态管理。
- `crates/codex-plus-core/src/routes.rs`：`/session/health`；`crates/codex-plus-data/src/session_health.rs`：恢复来源检查。
- `apps/codex-plus-manager/src/App.tsx`：会话管理；`apps/codex-plus-manager/src-tauri/src/commands.rs`：`delete_local_session`、`preview_invalid_local_sessions`、`delete_invalid_local_sessions`、`list_project_local_sessions`。
- `crates/codex-plus-data/src/storage.rs` / `backup.rs` / `provider_sync.rs`：删除、撤销、快照限长及索引维护。

## 回归检查

前端 `session-health.test.ts` / `session-delete-flow.test.ts`，数据层 `session_health.rs` / `storage_adapter.rs` / `provider_sync.rs`，Tauri 删除响应序列化及无效会话保护测试。需要重点覆盖远程、归档、备份、读取错误、恢复竞态、重复库记录与部分失败。

## 删除请求的主机归属

`SessionRef.host_id` 接受 snake_case 和 camelCase；缺失、空值或双字段不一致视为未知来源。桥接 `/delete` 与启动器数据服务都要求 `require_local_delete()`，只有明确 `local` 才进入本机 SQLite 删除。管理器从本机数据库列表发起的删除明确传 `local`；远程请求通过捕获的原生主机客户端处理，不能因为 thread ID 相同回退到本机。会话保护与备份删除响应仍沿用 `deletion` 包装。验证在 models、routes 与 `cdp_bridge.rs` 的主机归属用例。

## Claude Code 会话管理

- Claude 工具的“全局管理 → 会话管理”使用独立 `claudeSessions` 路由和 `screens/ClaudeSessionsScreen.tsx`，不触发 Codex 会话维护。列表按项目或时间分组，默认每页 50 条；标题、目录、ID 搜索由后端在分页前执行。详情按需读取用户与 Claude 对话，工具调用和思考默认折叠，附件只显示类型和名称。
- 数据入口为 `crates/codex-plus-data/src/claude_sessions/`。扫描默认 `~/.claude` 和 `CLAUDE_CONFIG_DIR`，规范化并去重配置目录；只列出 `projects/<project>/<uuid>.jsonl` 主会话，子代理目录随主会话处理。摘要缓存文件长度和修改时间，读取文件头尾；正文按 UUID、parentUuid 重建最新分支，合并同一回复的流式块。单行超过 16 MiB 会跳过并提示；正文扫描超过 512 MiB 或 10 万节点时停止，提示从 Claude Code 导出。
- 每个会话使用文件路径摘要作为 `key`，不能用会话 ID 合并不同位置的文件。项目删除在全量本机会话中匹配规范化目录，预览返回固定目标集合；预览最多保留 10 分钟，执行只接受后端 token。异常会话、重复 ID 或桌面端关联歧义受保护。
- 桌面端附加信息从用户数据目录下 `Claude/claude-code-sessions`、`Claude-3p/claude-code-sessions` 读取，Windows 检查 Local 与 Roaming，macOS 使用 Application Support，Linux 使用 XDG 配置目录。只处理 `cliSessionId` 与 cwd 可明确匹配的 `local_*.json`；目录缺失不影响正文列表。无法完整检查桌面信息时拒绝删除，防止留下无法判断归属的记录。
- Tauri 接口独立注册于 `commands/claude_sessions.rs`：`list_claude_sessions`、`read_claude_session`、`preview_claude_session_deletion`、`delete_claude_sessions`、`list_claude_session_backups`、`restore_claude_session`。列表保留 `sessions/offset/limit/totalCount/hasMore/warnings`；详情使用 `messages` 分页；删除返回 `outcomes` 内的逐项 `status/message/backupToken` 与 `stopped`，部分完成时外层状态为 `partial`。
- 删除和恢复要求 Claude 桌面端、原生 CLI、Node/Bun/Deno 启动的 CLI 全部退出；无法读取相关脚本进程命令行时也拒绝操作。逐项复核进程和文件 SHA-256，重新启动或文件变化即停止。路径校验拒绝上级目录、符号链接和 Windows 重解析点。
- 删除先备份主记录、对应会话目录及明确关联的 `history.jsonl` 条目、`sessions-index.json` 条目和桌面元数据，再修改源文件。项目源码、工作树和共享 memory 保留。共享索引保留其他记录与未知字段；索引损坏时不继续删除。
- 备份位于管理器状态目录的 `backups/claude-sessions/<token>/`，包含清单与原始文件，保留最近 50 份及 7 天内全部快照。删除部分完成仍返回备份 token；恢复先检查全部冲突，再还原文件并合并该会话的索引条目，已有不同内容时停止，重复恢复不追加重复记录。
- 首版管理本机文件，不接入云端、SSH、WSL，也不创建桌面端历史索引。默认开启后台写入的应用必须完全退出后再操作。

验证入口：数据层 `claude_sessions/tests.rs`、`claude_sessions/deletion/tests.rs`；管理器 `claude-sessions.test.ts`。`cargo test -p codex-plus-data inspect_local_claude_sessions -- --ignored --nocapture` 可显式执行本机只读检查，不输出标题或消息正文。Windows 本机读盘、消息读取和进程保护已验证；桌面端元数据使用测试样本，macOS、Linux 的真实应用行为尚未验证。
