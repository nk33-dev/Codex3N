# Codex3N

<p align="center">
  <img src="docs/images/codex-plus-plus.png" alt="Codex++ 图标" width="160">
</p>

<p align="center">
  中文 | <a href="README_EN.md">English</a>
</p>

<p align="center">
  <img alt="Release" src="https://img.shields.io/github/v/release/nk33-dev/Codex3N">
  <img alt="License" src="https://img.shields.io/github/license/nk33-dev/Codex3N">
  <img alt="Rust" src="https://img.shields.io/badge/rust-1.85%2B-orange">
  <img alt="Tauri" src="https://img.shields.io/badge/tauri-2.x-24C8DB">
</p>

> **这是 Codex3N —— [CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus) 的个人定制版。**
> 上游功能基本保留，另外按个人使用习惯做了适配；相比上游移除了广告/推荐内容子系统。

Codex++ 是面向 OpenAI Codex / ChatGPT 桌面应用的外部启动器与管理工具。它通过 Chromium DevTools Protocol 和本地辅助服务提供供应商切换、协议转换、会话管理与界面增强，不修改官方应用的 `app.asar`，也不向安装目录写入补丁文件。

## 快速使用

从 [本仓库的 Releases](https://github.com/nk33-dev/Codex3N/releases) 下载最新版安装包（**不要**去上游仓库下载，上游的包不含 Codex3N 的个人适配）：

- Windows：`Codex3N-<版本>-windows-x64-setup.exe`
- macOS Intel：`Codex3N-<版本>-macos-x64.dmg`
- macOS Apple Silicon：`Codex3N-<版本>-macos-arm64.dmg`

版本号规则是「上游版本号 + `-3n.N`」，例如 `1.3.0-3n.3` 表示基于上游 1.3.0 的第 3 次个人版修订。安装包只从 `personal` 分支对应的标签构建。

安装后会有两个入口：

- `Codex++`：静默启动官方桌面应用，并加载已保存的供应商配置与增强功能。
- `Codex++ 管理工具`：管理供应商、模型、工具插件、会话、增强功能、脚本、更新和诊断。

首次使用建议先打开管理工具，确认应用路径和运行状态，再配置供应商与增强功能，最后从 `Codex++` 入口启动。Windows 安装包会创建桌面和开始菜单快捷方式；macOS DMG 会安装 `/Applications/Codex++.app` 和 `/Applications/Codex++ 管理工具.app`。

## 交流与支持

欢迎加入 Codex++ 交流 3 群（QQ群：619480492），反馈问题、交流使用体验或提出新功能建议。<a href="https://qm.qq.com/q/Erf1F1zwqs">点击链接加入群聊</a>。

<img src="docs/images/discussion-group-qr.jpg" alt="Codex++ 微信群二维码" width="260">

Telegram 频道：<https://t.me/CodexPlusPlus>

友情链接：<a href="https://linux.do">LINUX DO</a>

## 当前功能

| 模块 | 功能 |
| --- | --- |
| 供应商配置 | 官方登录、官方登录混入 API、纯 API、聚合供应商；Responses / Chat Completions；模型测试、模型列表、Provider Doctor、cc-switch 与链接导入 |
| 模型与上下文 | 每模型上下文窗口、自动压缩阈值、`model_catalog_json`、通用配置，以及按供应商选择 MCP、Skill 和 Plugin |
| 会话管理 | 扫描本地会话、批量删除、Markdown 导出、Token 用量历史、Provider metadata 同步与备份 |
| Codex 增强 | 插件市场与模型白名单、会话操作、粘贴修复、中文界面、快速启动、会话宽度与滚动恢复、服务层级控制、Goals、Stepwise、图片覆盖层 |
| 开发工作流 | 项目移动、Upstream worktree、线程 ID、Zed Remote 项目识别与打开 |
| 脚本与维护 | 用户脚本安装与启停、应用检测、快捷方式、Watcher、环境冲突、日志诊断、健康检查和 Release 更新 |

所有界面增强都可以单独关闭。关闭“Codex 增强”总开关后，Codex++ 仍可作为供应商和启动管理工具使用。

## 供应商模式

Codex++ 将官方登录、混入 API 和纯 API 分开保存和切换：

| 模式 | 用途 | 认证边界 |
| --- | --- | --- |
| 官方登录 | 只使用 ChatGPT / Codex 官方账号 | 清理自定义 provider 和 API Key，保留官方登录状态 |
| 官方登录 + API | 保留官方账号与插件入口，模型请求始终走兼容 API（不消耗官方额度，也不是官方优先回落） | API Key 写入 provider bearer token，不写入纯 API 的 `auth.json` |
| 纯 API | 不依赖官方账号，完全使用自定义 Base URL / Key | 独立保存 `config.toml` 与 API Key，不混入官方认证 |
| 聚合供应商 | 在多个普通 API 供应商之间路由 | 支持故障转移、按会话轮转、按请求轮转和权重轮转 |

每个供应商可配置 Responses 或 Chat Completions 协议、模型列表、测试模型、User-Agent、上下文窗口、自动压缩阈值，以及该供应商启用的 MCP Server、Skill 和 Plugin。Chat Completions 可通过本地代理转换为 Codex 使用的 Responses 协议。

Codex3N 的供应商列表提供两个入口：

- **添加自定义供应商**：填写 API 地址、密钥和模型，也可以从接口获取模型列表。
- **导入默认 config.toml**：读取 Codex 默认目录中的 `config.toml` 和配套 `auth.json`，打开供应商详情，检查后保存。默认目录通常为 `~/.codex`，设置了有效 `CODEX_HOME` 时跟随该目录。导入只生成草稿，不改写正在使用的文件；保存后可通过供应商切换恢复这份配置。导入的供应商默认不套用管理工具的通用配置。

关闭供应商配置切换后，模型列表跟随当前 Codex 配置，不再注入停用供应商保存的模型。

供应商配置页提供“混入 Codex 原生模型”复选框，默认勾选：保留原生模型并补充供应商模型；取消勾选后，第三方目录读取成功时只展示供应商清单。官方模式或目录读取失败时保留原生列表。该选项对所有供应商生效，保存后刷新本机模型查询缓存；远程主机保持自己的模型列表。

自定义模型统一在供应商详情中配置和测试，模型选择菜单只保留原生模型选项，不再插入管理面板。管理器首次读取设置时会从本机 config.toml / auth.json 提取“系统默认”供应商，之后和其他供应商一样选择、编辑、排序或删除，不会反复导入或覆盖已保存的配置。模型目录使用短期缓存、最多三个来源并发获取和失败退避；目录未变化时不重复刷新菜单，白名单就绪后停止补扫。界面增强仅对模型响应执行目录补充，会话宽度调整改由布局事件触发。

每模型窗口支持 `1M`、`200K` 或纯数字。Codex++ 会生成独立 `model_catalog_json`，让 Codex 按当前模型使用对应窗口。

切换供应商时会先保存当前配置，再写入目标配置。真实 API Key 只保存在本机，请勿放入日志、截图或 issue。

## Codex 界面增强

- 会话删除、批量删除、Markdown 导出和项目移动。
- 检查并隐藏无法恢复的本地失效会话，保留归档和含对话内容的删除备份。
- 插件市场解锁、插件自动展开和模型白名单处理。
- 富文本粘贴转纯文本、强制中文、启动加速和原生菜单本地化。
- 会话宽度、滚动位置恢复、线程 ID、服务层级切换和 Goals。
- Stepwise 下一步建议，可单独配置 API、模型、建议数量与超时。
- Upstream worktree、Zed Remote、自定义图片覆盖层和用户脚本。

依赖注入脚本的设置通常需要保存后重新启动 Codex++ 才会生效。

Codex3N 的会话检查入口位于侧边栏 **Codex++ → 主页 → 失效会话**。点击“检查并隐藏失效会话”，会检查本地数据库、会话文件和恢复备份，并通过 Codex 的只读接口复核。只隐藏明确找不到会话文件且没有恢复来源的本机会话，不改动会话数据。归档、远程会话、刚创建的会话及无法确认的记录会保留；仅有标题或索引的备份不算恢复来源。隐藏状态保存在当前应用中，重启后会重新检查；可点击“显示已隐藏会话”恢复列表显示。

## 自动更新与安装包

Codex++ 通过 GitHub Release 发布安装包。Windows 会生成 NSIS 安装程序，macOS 会生成 Intel x64 和 Apple Silicon arm64 两个 DMG。

管理工具的“关于”页可以检查并启动更新。静默启动器发现新版本时会拉起管理工具并进入更新提示。

## 数据位置

- Codex 配置：`~/.codex/config.toml`
- Codex 登录状态：`~/.codex/auth.json`
- Codex 本地数据库：优先读取 `~/.codex/sqlite/*.db`，旧版回退到 `~/.codex/state_5.sqlite`
- Codex++ 状态与日志：`~/.codex-session-delete/`
- Provider 同步备份：`~/.codex/backups_state/provider-sync`

## 常见问题

### Codex++ 菜单没出现

确认从 `Codex++` 入口启动，而不是直接打开官方应用。然后在管理工具的“安装维护”和“关于”页面检查应用路径、启动状态与诊断日志。

### 切换供应商后请求失败

先在供应商详情中运行模型测试或 Provider Doctor，并确认协议、Base URL、Key 和测试模型匹配。纯 API 与官方混入模式使用不同的认证位置，不要手工复制两种模式的 `auth.json`。

### 混入 API Key 模式是“官方优先、额度不足时 API 补偿”吗

不是。官方登录 + API（混入）模式下，模型请求**始终走你配置的兼容 API**，官方账号只保留登录状态和插件入口，不会先消耗官方额度再回落到 API。需要“一个供应商失败时切到另一个”的行为时，使用聚合供应商：它支持故障转移、按会话轮转、按请求轮转和权重轮转。两种模式的认证保存位置不同，配置前先在供应商详情里用模型测试确认目标 API 可用。

### Upstream worktree 和 Codex 原生创建有什么区别

Codex++ 的 Upstream worktree 功能等价于先更新远端分支，再执行：

```bash
git worktree add -b <new-branch> <worktree-path> upstream/<base-branch>
```

这样新 worktree 从最新的远端跟踪分支开始，而不是从当前会话所在的本地 HEAD 开始。如果 Codex++ 无法安全识别当前 Codex 版本的原生 worktree 创建表单，请从 Codex++ 菜单中手动填写仓库路径、分支名、worktree 路径、remote 和 base branch。

### macOS 提示无法打开或已损坏

当前安装包未签名/未公证时，macOS Gatekeeper 可能拦截，出现“已损坏，无法打开”的提示：

![macOS 提示 Codex++ 管理工具已损坏](docs/images/macos-damaged-warning.png)

如果遇到该提示，可以在终端执行下面两条命令，解除苹果系统的安全隔离限制：

```bash
sudo xattr -rd com.apple.quarantine /Applications/Codex++\ 管理工具.app
sudo xattr -rd com.apple.quarantine /Applications/Codex++.app
```

执行后重新打开 `Codex++` 或 `Codex++ 管理工具` 即可。

### macOS Intel 能用吗

可以。Release 会分别提供 `macos-x64.dmg` 和 `macos-arm64.dmg`。Intel Mac 下载 x64 包，Apple Silicon 下载 arm64 包。

## 开发

```bash
# 前端检查
cd apps/codex-plus-manager
npm ci
npm run check
npm run vite:build

# Rust 检查
cd ../..
cargo fmt --all -- --check
cargo test
cargo build --release
```

主要结构：

```text
apps/
  codex-plus-launcher/          静默启动入口
  codex-plus-manager/           Tauri 管理工具
assets/inject/
  renderer-inject.js            注入到 Codex 渲染端的增强脚本
crates/
  codex-plus-core/              启动、注入、配置、更新、安装、桥接等核心逻辑
  codex-plus-data/              会话数据、导出、Provider 同步
scripts/installer/
  windows/CodexPlusPlus.nsi     Windows NSIS 安装包
  macos/package-dmg.sh          macOS DMG 打包
```

## 开源协议

Copyright (C) 2026 BigPizzaV3

CodexPlusPlus 采用 [GNU Affero General Public License v3.0](LICENSE)，SPDX 标识为 `AGPL-3.0-only`。修改并分发本项目，或通过网络提供修改后的版本时，需要按 AGPLv3 提供对应源代码。

许可证只覆盖 CodexPlusPlus 自身代码，不授予 OpenAI、ChatGPT、Codex 的商标、应用资源或其他第三方内容的权利。

## 兼容性说明

Codex++ 依赖官方桌面应用的页面结构、CDP 和本地数据格式。官方应用更新后，部分注入功能可能需要跟随适配；修改供应商配置或本地会话数据前应保留备份。
