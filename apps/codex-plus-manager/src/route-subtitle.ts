import { t } from "@/i18n";
import type { ManagerRoute } from "./manager-loading";

export function routeSubtitle(route: ManagerRoute): string {
  const subtitles: Record<ManagerRoute, string> = {
    overview: t("检查问题、启动与快速修复"),
    relay: t("管理 API 供应商、协议、Key 与配置文件"),
    grok: t("管理 Grok CLI 的模型与 API 端点"),
    relayEnvironment: t("排查可能干扰中转站配置的本机环境"),
    sessions: t("查看、删除和修复 Codex 本地会话"),
    context: t("独立管理 MCP 服务器与插件"),
    skills: t("从 GitHub 仓库安装 Skill 到 Codex"),
    weixin: t("通过个人微信连接本机 Codex 会话"),
    enhance: t("会话删除、导出和脚本能力"),
    dreamSkin: t("Codex-Dream-Skin 风格主题和换图"),
    zedRemote: t("管理 Codex SSH 项目并加入 Zed workspace"),
    userScripts: t("内置和用户自定义脚本清单"),
    maintenance: t("入口安装、修复、Watcher 与手动启动"),
    about: t("版本信息、项目链接、GitHub Release 更新、日志与诊断"),
    settings: t("主题和启动参数"),
  };
  return subtitles[route];
}
