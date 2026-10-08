# Codex3N

[English](README_EN.md) · [下载安装](https://github.com/nk33-dev/Codex3N/releases/latest) · [个人功能文档](doc/person/README.md) · [上游项目](https://github.com/BigPizzaV3/CodexPlusPlus)

基于 CodexPlusPlus 的个人定制版，为 OpenAI Codex / ChatGPT 桌面应用提供供应商切换、协议转换、会话管理和界面增强。通过 CDP 和本地服务运行，不修改官方应用的 `app.asar`。

## 使用

从 [Releases](https://github.com/nk33-dev/Codex3N/releases/latest) 下载：

- Windows：`Codex3N-<版本>-windows-x64-setup.exe`
- macOS：`Codex3N-<版本>-macos-universal.dmg`，同时支持 Intel 和 Apple Silicon。

首次打开 **Codex++ 管理工具**，确认官方应用路径，配置供应商和增强功能；之后通过 **Codex++** 启动官方应用。管理工具的“关于”页可检查更新。

macOS 安装包使用 ad-hoc 签名，未经过 Apple 公证。若系统拦截，确认下载来源后执行：

```bash
sudo xattr -rd com.apple.quarantine "/Applications/Codex++.app"
sudo xattr -rd com.apple.quarantine "/Applications/Codex++ 管理工具.app"
```

## 个人差异

- 移除广告与推荐内容。
- 供应商默认关闭接管；支持系统默认配置导入、多个命名 API Key 和即时切换。
- 合并原生与供应商模型，统一排序，保留手工上下文窗口和自动压缩设置。
- 会话分页、失效会话检查与隐藏、备份删除和项目关联恢复。
- 管理器后台刷新、悬浮球交互、宿主兼容及移动 relay 适配。

上游的供应商、插件、微信连接、皮肤、用户脚本、独立语音输入与缓存清理功能继续保留。详细行为及代码入口见[个人文档](doc/person/README.md)。官方登录 + API 模式的模型请求始终走所配置的 API；使用前先在管理工具中测试。

## 开发与维护

同步、检查和发布步骤见[维护流程](doc/person/maintenance.md)。`personal` 是开发和发布分支；版本采用 `<上游版本>-3n.N`。

官方应用更新可能影响注入兼容性。配置与会话数据位于 `CODEX_HOME`（默认 `~/.codex`），修改前保留备份。

## 协议

Copyright (C) 2026 BigPizzaV3。采用 [AGPL-3.0-only](LICENSE)，修改后分发或通过网络提供服务时须提供对应源代码。许可证只覆盖本项目代码，不授予 OpenAI 等第三方的商标或应用资源权利。
