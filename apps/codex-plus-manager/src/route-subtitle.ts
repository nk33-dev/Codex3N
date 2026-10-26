import { t } from "@/i18n";
import type { ManagerRoute } from "./manager-loading";

export function routeSubtitle(route: ManagerRoute): string {
  const subtitles: Record<ManagerRoute, string> = {
    overview: t("检查问题、启动与快速修复"),
    relay: t("管理 API 供应商、协议、Key 与配置文件"),
    multiLaunch: t("为不同供应商启动相互隔离的 Codex 实例"),
    grok: t("管理 Grok CLI 的模型与 API 端点"),
    claude: t("保留官方 Claude.app 原样，通过受管副本为 Claude 应用增强功能"),
    claudeSessions: t("查看、删除和恢复 Claude Code 本地会话"),
    claudeRelay: t("管理 Claude Code 的 API 供应商，切换时写入 ~/.claude/settings.json"),
    computerUse: t("复用 Codex 的 Computer Use，通过 MCP 接给 Claude Code、Claude Desktop 与 Codex。"),
    requestLog: t("查看代理请求的状态、模型、重试、token 用量与缓存命中"),
    agentSettings: t("当前 Agent 的专属设置"),
    relayEnvironment: t("排查可能干扰中转站配置的本机环境"),
    sessions: t("查看、删除和修复 Codex 本地会话"),
    context: t("独立管理 MCP 服务器与插件"),
    skills: t("从 GitHub 仓库安装 Skill 到 Codex"),
    weixin: t("通过个人微信连接本机 Codex 会话"),
    enhance: t("管理常用功能、语音输入与下一步建议。"),
    dreamSkin: t("Codex-Dream-Skin 风格主题和换图"),
    agentCollaboration: t("Agent 协作"),
    agentCache: t("扫描 Codex、Claude 与 Codex++ 的已知缓存目录，由你选择清理项目。"),
    pluginMarket: t("检索插件，按需下载并安装到 Codex"),
    userScripts: t("内置和用户自定义拓展清单"),
    maintenance: t("入口检查与修复、开机启动与应用路径"),
    about: t("版本信息、项目链接、GitHub Release 更新、日志与诊断"),
    settings: t("主题和启动参数"),
  };
  return subtitles[route];
}
