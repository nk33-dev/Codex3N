# Codex3N 项目指令

## 项目定位

Codex3N 是基于 CodexPlusPlus 长期维护的个人定制版本。

## 当前目标

当前只处理以下两类工作：

1. 根据个人使用需求开发和维护定制功能。
2. 持续同步 CodexPlusPlus 官方仓库的最新代码，在保留个人定制功能的前提下完成兼容与冲突处理。

## 分支约定

- `main`：只同步 `upstream/main`，不直接开发个人功能。
- `personal`：基于 `main` 维护 Codex3N 的个人定制功能；**GitHub 默认分支就是它**，因为对外可见的始终是个人版。
- 新功能需要单独开发时，从 `personal` 创建短期功能分支，完成后合并回 `personal`。

## 版本与发布

- Codex3N 版本使用“上游版本号 + `-3n.N`”格式，例如 `1.2.56-3n.1`。
- 发布标签必须与 `Cargo.toml` 中的版本一致，例如 `v1.2.56-3n.1`。
- 正式安装包只从 `personal` 对应的 Codex3N 标签构建和发布。
- 写 release 说明时要用真实换行，避免把 `\n` 当成普通文字显示出来；多行说明优先用 notes 文件。
- 默认确认 GitHub Release 创建成功后即结束发布操作，不持续轮询或等待安装包构建；只有用户明确要求时才监控构建进度，避免无谓消耗 token。
- **发布统一走 `pwsh scripts/release.ps1 -NotesFile <说明文件>`**：脚本会校验分支/工作区/标签格式/标签是否已存在，本地先跑一遍 release 门禁（fmt + Rust 测试 + 前端测试与类型检查），再推送分支、打标签、创建 Release。
- **`gh` 在本仓库默认会解析到上游**：仓库同时配置了 `origin` 与 `upstream`，`gh` 优先用 `upstream`，所以任何 `gh` 命令都必须显式带 `--repo nk33-dev/Codex3N`（`scripts/release.ps1` 已写死）。`.git/config` 里的 `pushurl = DISABLED` 只挡 `git push`，挡不住 `gh`。
- release workflow（`.github/workflows/release-assets.yml`）有测试门禁 job（`verify-tests`）与“标签 == Cargo.toml 版本”校验，安装包 job 都在门禁之后；门禁红了不会产出安装包。

## 提交规范

- 提交信息用 `type(scope): 说明`。
- 说明要直接写这次改了什么，不要堆太多虚词。
- 示例：
  - `fix(payment): 修复并发下单导致库存超卖的问题`
  - `feat(user): 增加后台用户列表导出Excel功能`

## 官方同步检查

把 `upstream/main` 合入 `personal` 时，必须同时做合并前和合并后检查：

- 合并前记录个人分支的功能入口、关键配置字段、注入脚本和测试基线，先确认工作区没有未说明的修改。
- 合并时重点检查个人改动与官方改动重叠的模块，不能只接受 Git 的自动合并结果。
- 合并后检查运行时契约和数据结构是否变化，尤其是 RPC 客户端、模型列表、配置分片、会话索引、路径处理和前端按钮布局。
- 至少执行 `cargo fmt --check`、`cargo check --workspace`、`cargo test --workspace` 和前端 `npm test`、`npm run check`；不能只用编译通过代替测试。
- 对 Windows、macOS、Linux 有差异的路径、进程、安装包和 UI 行为分别检查，优先修复跨平台测试和真实运行时不一致。

## 范围限制

除上述两项目标外，暂不主动增加其他功能，不进行无关重构，也不扩大项目范围。新增工作必须由用户明确提出。

个人版业务与代码入口见 `doc/person/README.md`；修改功能或同步上游时同步维护，删除过时说明，保持文档与当前实现一致。
