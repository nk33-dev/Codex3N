# 上游同步审查

- 原个人提交：`3eafee2c8893874d90b7720375285dbe51f5c533`。
- 上次合并基线：`84afcbda98d5b0e02a4c63d440018e7de79fe834`（v1.5.1，经 `ec222cb` 合入个人历史）。
- 目标上游：`0a5fa537d98cf51a5e6205742d8b18699bd7c5dd`（v1.5.4），提交前重新 fetch 确认仍为最新；审查基线至目标的全部 39 个文件，独立分支 `codex/sync-1.5.4` 保留上游合并祖先。
- 发布版本：`1.5.4-3n.1`，版本和标签对应 `personal`；个人更新源与 mobile relay workspace 成员保留。
- 本机 Windows；桌面宿主版本未确认，未在活动用户数据上执行迁移或重启。

## 重叠行为

| 上游入口 | 个人版处理 | 回归依据 |
| --- | --- | --- |
| `App.tsx` 脚本市场、修复进度 | 沿用原文件，卸载映射使用后端的本地 key；更新翻译字典 | 管理器前端测试、类型检查和翻译校验 |
| `commands.rs` 重启 | 原命令统一调用 `wait_for_exit_or_force`，保留个人端口、provider guard 和后台启动流程 | commands 状态测试、watcher 进程身份与退出测试 |
| `LauncherHooks::run_provider_sync` | 同步失败记录诊断后继续个人版的索引修复 | 启动器同步降级测试 |
| `app_paths.rs` / `launcher.rs` | 有效保存路径优先，MSIX 先校验注册；保留个人 standalone CLI 探测及 helper 来源限制 | 路径、启动和 helper 回归 |
| `relay_config.rs` | 在原合并入口增加 MCP 完整性检查和失效 catalog 路径处理，保留命名 Key、总开关及手工窗口 | relay_config、relay_switch 和模型目录回归 |
| `provider_sync.rs` | 删除墓碑同时接入两条重建路径；恢复沿用备份链路并撤销墓碑 | provider_sync、storage_adapter 和 session_health 临时数据测试 |
| renderer 分片 | 以 manifest 为源码入口，生成单份 `renderer-inject.js`；迁入客户端内容定位、全局状态能力识别、徽章兄弟节点和页面边界测量 | renderer-model-runtime 行为测试、注入产物校验和 cdp_bridge |
| macOS 打包及工作流 | `build-universal.sh` 统一编译合并双架构，保留个人门禁、缓存、包名和 ZIP；个人仓库无 Apple 凭据，沿用 ad-hoc 签名 | DMG 生命周期模拟、更新资产选择；原生构建由 macOS CI 执行 |

`codex_sqlite.rs::backfill_thread_models_to_default` 随上游同步保留；目标上游也只有测试调用，不在个人启动路径额外接入数据库改写。日志后缀清理采用上游分批事务。

## 数据和兼容边界

新增墓碑位于 `CODEX_HOME/tmp/provider-sync-tombstones.json`，旧版本会忽略它，因此代码降级后删除记录可能再次被旧修复流程补回。墓碑不是会话备份；恢复仍依靠原备份与一致性数据库副本。新增状态字段可读取旧状态 JSON。

会话、MCP 和模型目录回归均在临时目录及临时数据库运行，未复制或改写正在使用的会话正文和凭据。README 和维护文档同步通用包名称；上游站点删除过时 macOS 提示的改动一并合入。

## 验证记录

基线的 `npm ci`、`npm test`、`npm run check`、`npm run vite:build`、`cargo fmt --check` 和 `cargo check --workspace` 通过。基线 `cargo test --workspace --no-fail-fast` 有一项 Stepwise 协议回退失败，其他测试目标通过；完整日志保存在本机临时目录 `codex3n-sync-1.5.4`。

最终本地检查通过：`cargo fmt --check`、`cargo check --workspace`、`cargo test --workspace --no-fail-fast`（1926 通过、8 跳过）；管理器 `npm ci`、`npm test`（503 通过、1 跳过）、`npm run check`、`npm audit --audit-level=high`、`npm run vite:build`；relay Clippy、`cargo audit`、renderer/native inspector 产物校验及 Bash 语法检查。Node 使用经官方 SHA256 校验的 22.23.3，Bash 使用 Git for Windows。

基线 Stepwise 回退在合并后的两次全量 Rust 检查中通过。合并检查发现翻译缺项和两项仍指向分架构包名的断言，已按当前调用和通用包产物更新；并行编译期间出现一次 DMG 模拟进程超时，停止并行编译后全量前端复跑通过。Rust 审计有 8 项仓库允许的警告，退出码为 0。

发布脚本另校验最终 `personal` SHA 的全部 push CI job。Windows、macOS、Linux 桌面宿主安装、升级和交互未实机验证，模拟和 CI 产包不能替代这些验证。
