# Codex3N

[English](README_EN.md) · [下载安装](https://github.com/nk33-dev/Codex3N/releases/latest) · [个人功能文档](doc/person/README.md) · [上游项目](https://github.com/BigPizzaV3/CodexPlusPlus)

CodexPlusPlus 的个人定制版，给 OpenAI Codex / ChatGPT 桌面应用加上供应商切换、协议转换、会话管理和界面增强。通过 CDP 和本地服务运行，不修改官方应用的 `app.asar`。

## 安装

从 [Releases](https://github.com/nk33-dev/Codex3N/releases/latest) 下载：

- Windows：`Codex3N-<版本>-windows-x64-setup.exe`
- macOS：`Codex3N-<版本>-macos-universal.dmg`，Intel 与 Apple Silicon 通用

打开 **Codex++**，确认官方应用路径，配置供应商和增强功能，然后在概览页启动官方应用。界面和后台服务在同一个应用里，关闭窗口后收起到托盘；「关于」页可检查更新。

macOS 安装包是 ad-hoc 签名，未经 Apple 公证。被系统拦截时，确认下载来源后执行：

```bash
sudo xattr -rd com.apple.quarantine "/Applications/Codex++.app"
```

## 与上游的差异

**供应商与模型**
- 默认不接管供应商；可从系统默认配置导入，支持多个命名 API Key 并即时切换。
- 原生模型与供应商模型合并排序，保留手工设置的上下文窗口和自动压缩。

**会话**
- 全库会话搜索与分页、失效会话检查与隐藏，删除前备份，可恢复项目关联。

**提示词工具**（默认关闭，在管理器「Codex增强 → 提示词增强」开启）
- **增强提示词**：把草稿补全为可直接发送的提示词。能定的方案直接写明，只有你知道的信息留成【列表页 URL】这类空位。
- **需求对齐**：按草稿缺口提问，单选题给出推荐和理由；方向清楚就直接生成。
- **常用提示词**：收藏、搜索、按标签筛选，一键追加或替换到输入框。
- 微调 / 标准 / 详细三档深度；受众画像可选无技术经验或 P4–P10。结果确认后才写回，不会自动发送。

**界面与运行**
- 移除广告与推荐内容。
- 管理器后台刷新、悬浮球交互、宿主兼容和移动端 relay 适配。
- 后端断连自动恢复，可手动重连并保留当前页面与会话。

上游的供应商、插件、微信连接、皮肤、用户脚本、语音输入、缓存清理、用量状态栏和官方 App 自动接管等功能都保留。官方登录 + API 模式下，模型请求始终走所配置的 API，使用前先在管理器里测试连接。

同时同步上游的常驻协议代理、请求避震与日志、Claude Code 供应商、旁支保存和轮次回退。Computer Use 接入依赖上游支持的 macOS 运行时；平台限制和数据保护见[运行文档](doc/person/runtime.md)。

各功能的行为和代码入口见[个人功能文档](doc/person/README.md)。

## 开发与维护

`personal` 是开发和发布分支，版本号为 `<上游版本>-3n.N`。同步上游、检查和发布步骤见[维护流程](doc/person/maintenance.md)。

官方应用更新可能影响注入兼容。配置和会话数据在 `CODEX_HOME`（默认 `~/.codex`），改动前先备份。

## 协议

Copyright (C) 2026 BigPizzaV3。采用 [AGPL-3.0-only](LICENSE)，修改后分发或通过网络提供服务时须提供对应源代码。许可证只覆盖本项目代码，不授予 OpenAI 等第三方的商标或应用资源权利。
