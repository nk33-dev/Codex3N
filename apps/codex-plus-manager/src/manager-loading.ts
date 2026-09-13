export type ManagerRoute = "overview" | "relay" | "grok" | "relayEnvironment" | "sessions" | "context" | "skills" | "weixin" | "enhance" | "dreamSkin" | "zedRemote" | "userScripts" | "maintenance" | "about" | "settings";

type PageTask = "settings" | "overview" | "weixin" | "relay" | "relayFiles" | "envConflicts" | "ccsProviders" | "relayEnvironment" | "sessions" | "providerSyncTargets" | "zedRemoteProjects" | "liveContextEntries" | "dreamSkinStatus" | "dreamSkinLibrary" | "dreamSkinMarket" | "dreamSkinCommunity" | "scriptMarket" | "userScriptInventory" | "logs" | "diagnostics" | "watcher" | "remotePluginMarketplace";
export type ManagerPageLoaders = Record<PageTask, () => Promise<unknown>>;

/** 同一批任务互不依赖；不同批次保留设置、脚本库存等数据的写入顺序。 */
const pageLoadBatches: Record<ManagerRoute, PageTask[][]> = {
  overview: [["overview"]],
  relay: [["settings", "weixin", "relay", "relayFiles", "envConflicts", "ccsProviders"]],
  grok: [["settings"]],
  relayEnvironment: [["relayEnvironment"]],
  sessions: [["settings", "sessions"], ["providerSyncTargets"]],
  context: [["settings", "relayFiles", "liveContextEntries"]],
  skills: [],
  // 微信页面的状态由可见性调度立即刷新，避免切页时重复请求。
  weixin: [["settings", "sessions"]],
  enhance: [["settings", "remotePluginMarketplace"]],
  dreamSkin: [["settings", "overview", "dreamSkinLibrary", "dreamSkinMarket", "dreamSkinCommunity", "dreamSkinStatus"]],
  zedRemote: [["settings", "zedRemoteProjects"]],
  userScripts: [["settings"], ["scriptMarket"], ["userScriptInventory"]],
  maintenance: [["overview", "watcher"]],
  about: [["overview", "logs", "diagnostics"]],
  settings: [["settings"]],
};

export async function loadManagerPage(
  route: ManagerRoute,
  loaders: ManagerPageLoaders,
  alreadyLoaded: ReadonlySet<PageTask> = new Set(),
  isCurrent: () => boolean = () => true,
) {
  for (const batch of pageLoadBatches[route]) {
    if (!isCurrent()) return;
    await Promise.all(batch.filter((task) => !alreadyLoaded.has(task)).map((task) => loaders[task]()));
  }
}

/** 公共数据先并行发起；页面专属数据由导航的唯一加载入口负责。 */
export async function initializeManager<T>(tasks: {
  startup: () => Promise<T>;
  settings: () => Promise<unknown>;
  overview: () => Promise<unknown>;
  tools: () => Promise<unknown>;
}) {
  // 设置首次加载会导入本机供应商，工具摘要须读取导入后的设置。
  const [startup] = await Promise.all([tasks.startup(), tasks.settings().then(tasks.tools), tasks.overview()]);
  return startup;
}
