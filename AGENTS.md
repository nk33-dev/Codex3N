# Codex3N 项目指令

Codex3N 是 CodexPlusPlus 的个人定制版。只开发用户要求的个人功能、同步上游及处理兼容问题，不做无关重构。

## 日常约定

- 中文交流与新增注释，代码标识符保持英文；修改前读懂相关文件，不确定的技术细节先查文档。
- `main` 只快进同步 `upstream/main`；`personal` 是个人开发及 GitHub 默认分支，短期分支从它创建并合回。不强制覆盖分叉历史。
- 提交信息用 `type(scope): 中文说明`；GitHub 操作显式指定 `--repo nk33-dev/Codex3N`，避免命中上游。
- 修改功能时按[个人文档导航](doc/person/README.md)读取并更新相关文档；这里只留关键规则，详细步骤不重复写入。

## 同步与验证

- 同步前必须读[维护流程](doc/person/maintenance.md)。Git 无冲突不代表行为正确：按旧入口到新模块映射迁移上游行为，保持唯一运行入口，并覆盖上游修复与个人功能回归。
- 大版本及重构重叠在独立同步分支验证后合回，保留上游合并历史；数据迁移先在副本验证，代码回退不等于数据回退。
- 同步至少执行 `cargo fmt --check`、`cargo check --workspace`、`cargo test --workspace`，以及管理器目录下的 `npm test`、`npm run check`。日常修改运行相关检查；纯文档检查差异与链接。
- 平台相关改动检查 Windows、macOS、Linux 的实际行为；如实记录未验证范围和失败，编译或 mock 通过不能代替真实运行验证。

## 发布

- 版本为“上游版本号 + `-3n.N`”，标签与 `Cargo.toml` 一致；正式包只从 `personal` 对应标签发布。
- 发布必须先读维护流程中的发布步骤，统一运行 `pwsh scripts/release.ps1 -NotesFile <说明文件>`；检查失败不继续。
- Release 创建成功后默认结束，不持续等待安装包构建，除非用户明确要求监控。
