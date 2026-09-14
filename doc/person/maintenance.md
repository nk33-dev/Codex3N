# 管理器性能、配置安全、更新与上游同步

## 管理器加载和后台刷新

- `apps/codex-plus-manager/src/manager-loading.ts` 是启动和页面加载任务的唯一编排入口。公共初始化并行发起；设置首次加载可能导入本机供应商，所以工具摘要等设置完成后再读。会话、供应商扫描、环境检查和远端插件状态进入对应页面才加载。
- 页面内独立请求并行；会话供应商默认选择等待设置完成，脚本市场保留“设置 → 市场 → 库存”顺序，皮肤本地状态不等待远端市场。快速切页后不再发起旧页面的后续批次，启动和页面读取的旧设置响应不能覆盖已编辑的草稿。
- `use-manager-lifecycle.ts` 负责窗口可见性和事件接线，`manager-lifecycle.ts` 负责请求合并与定时调度。`App.tsx` 保留页面、业务状态和操作回调，不另放一套启动 effect、导航任务分支或 1.2 秒待处理轮询。
- 后端 `apps/codex-plus-manager/src-tauri/src/lib.rs` 在显示、聚焦、最小化和隐藏时发送窗口事件：`manager-visibility-changed` 的布尔载荷表示实际可见状态；`manager-navigation-requested` 通知检查待处理导航、供应商导入、会话分享和皮肤链接。失焦不等于隐藏，导航通知也不等于显示成功。
- 待处理文件有跨进程写入，因此可见时保留 30 秒兜底，窗口恢复后立即补读。隐藏时暂停待处理检查和微信页面状态；微信后台连接服务、用户已发起的扫码登录继续运行，避免丢失后端已保存凭据并消费二维码的确认结果。已发出的调用不能强制取消，旧微信状态响应不会覆盖恢复后的状态。
- 页面结构和视觉样式未因本次性能拆分调整。按需加载意味着第一次进入某页面才开始对应检查；如果跨进程唤起没有产生窗口事件，待处理链接会等到下一次兜底或窗口恢复时出现。

验证：前端 `manager-loading.test.ts`、`manager-lifecycle.test.ts`、`manager-window-lifecycle.test.ts`、`manager-navigation.test.ts`；后端窗口契约见 `apps/codex-plus-manager/src-tauri/tests/windows_subsystem.rs`。重点检查慢请求、连续事件、隐藏恢复、监听销毁和启动导航竞态。

## 配置和安装维护

- 设置写入采用跨进程锁、唯一临时文件和损坏内容隔离，避免并发写丢失或静默覆盖损坏配置。入口：`crates/codex-plus-core/src/settings.rs`；验证设置单元测试和迁移测试。
- 个人版更新源由 `crates/codex-plus-core/src/update.rs` 指向 Codex3N；同步上游不能把更新源改回官方。
- 安装失败须如实报告，Watcher 按安装实例处理进程，避免误杀其他安装。入口：`crates/codex-plus-core/src/install/` / `watcher.rs`；验证 `updater.rs`、`installers.rs`、`watcher.rs`。
- 会话快照、删除与撤销的数据保护见 [sessions.md](sessions.md)。

## 上游同步

合并前记录个人功能入口、关键配置、注入点与测试基线；合并后复核 RPC、模型目录、配置分片、会话索引、路径和按钮布局，不能只接受 Git 自动合并结果。按项目指令执行 Rust 和前端检查，分别关注 Windows、macOS、Linux 的进程、路径、安装包与 UI 差异。

同步前先沿本文和各业务文档找到当前入口；上游仍把逻辑写在 `App.tsx` 或 `commands.rs` 时，把新增行为迁入现有模块，并删除被替代的旧实现。不能仅因 Git 无冲突就保留两套监听、定时器、分页查询或页面加载逻辑。合并后搜索旧函数名和旧定时间隔，确认运行时只调用一次，并运行对应行为测试。

业务变化后同步维护对应文档；已删除的功能删掉描述，相关功能留在同一业务文档内。历史提交仅用于理解缘由，不能代替当前实现。

## 发布

从 `Cargo.toml` 与 Git 读取实际版本和分支状态，不在业务文档固定“当前版本”。依照根目录 AGENTS.md 的发布约定执行 `pwsh scripts/release.ps1 -NotesFile <UTF-8说明>`；检查通过后创建本地标签，通过一次 `git push --atomic` 同时推送 personal 和本次标签，再创建 Release，避免远端只更新其中一项。

GitHub Actions 的前端依赖安装统一使用仓库内的 `package-lock.json` 和 `npm ci`，保证相同提交在 Windows、macOS 与发布门禁中解析到同一套依赖。

检查失败不得继续发布；所有 GitHub 操作显式指定 `nk33-dev/Codex3N`。Release 创建成功后默认结束，不轮询安装包构建，除非用户明确要求。
