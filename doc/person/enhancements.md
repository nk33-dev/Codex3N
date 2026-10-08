# 界面增强与去广告

## 无广告个人版

不展示原管理器推荐/赞助内容，不启动原广告获取链路；原广告模块已经删除，不应作为可启用功能列出。这不是浏览器通用广告拦截器，普通插件或社区链接也不等同于广告。

同步上游时检查 `apps/codex-plus-manager/src/App.tsx`、`apps/codex-plus-launcher/src/main.rs`、`crates/codex-plus-core/src/routes.rs`，防止重新带回广告模块、推荐接口和推广 UI。

## 增强设置保存

增强页分为常用增强、语音输入、下一步建议三个标签，开关统一只改草稿；顶部显示保存状态与保存按钮，点击保存后同步配置。Stepwise、回答大纲和桌宠开关也不偷偷提交整个表单，避免部分自动保存、部分手动保存造成保存栏闪烁。

入口为 `apps/codex-plus-manager/src/App.tsx` 的 `EnhanceScreen`。配置关注 `enhancementsEnabled`、对应 `codexApp*` 开关，不能把隐藏保存栏当作保存成功。

增强页与注入面板使用中文标题、说明；产品名、协议与命令保持原文。注入面板入口为 `assets/inject/renderer-inject.js` 的 `openCodexPlusModal`，管理器英文模式沿用 i18n 字典。远程 Zed、Upstream 工作树适配、强制中文、原生菜单汉化、快速启动及增强模式选择已随上游撤下，原生 SSH、工作树和会话分享保持可用。旧语言标记只恢复本工具曾设置且用户没有随后更改的值，失败时保留标记供下次重试。

注入页避免后台空转：`codexPlusSettings()` 挂在滚动监听和逐帧对齐路径上，因此按输入身份缓存（后端设置对象、`__CODEX_PLUS_DREAM_SKIN_THEME__` 全局），缓存命中时不再读 `localStorage` 也不再 `JSON.parse`；本地设置写入与皮肤原地更新处显式调用 `invalidateCodexPlusSettingsCache()`。语音按钮兜底扫描和皮肤定时全量 `ensure` 在 `document.hidden` 时跳过，仍保留 DOM 变化触发的路径。

## 悬浮球

错误态不再绘制双 X，使用温和平静的短眼形；保留微笑、拖拽、展开及建议/大纲能力。表情调整不等于忽略实际错误，状态说明仍须可见。

哑光材质展开时从第一帧铺满面板范围，展开动画期间不再从边缘漏出底层页面。

Stepwise 的 Chat Completions 返回若因推理内容耗尽输出额度而没有正文，会自动关闭该次请求的推理并重试一次，避免把有效连接误显示为 0 条建议。

系统启用“减少动态效果”时，等待状态不旋转，改用静态蓝色状态点，避免停止在圆环顶部时看起来像界面卡死；正常动画设置下仍使用持续旋转的圆环。

拖动、调整大小和指针光泽按动画帧合并更新，同一轮计算复用主界面的安全边界。普通平移使用 `transform`，内部尺寸不变时不重复更新材质几何与滚动渐隐；磨砂、通透、液态、冰晶、哑光的配色、滤镜和表情保持原样。松手应用最后坐标并保存位置，失焦、指针取消或丢失捕获时释放拖动状态；拖动期间延后回答扫描及内容重绘，避免替换捕获指针的标题节点。

入口为 `assets/inject/floating-panel/core/appearance.js`、`geometry.js`、`interaction.js`、`views.js` 与 `runtime/state.js` / `lifecycle.js`。改变需要更新的注入行为时检查脚本版本，避免旧实例继续使用旧样式。

## 管理器市场布局

脚本市场通过 `App.tsx::UserScriptsScreen` 从 `user_scripts` 映射市场 ID 到本地 `user:` key，`MarketScriptCard` 用原 `deleteUserScript` 操作卸载。插件修复进度是估算值，封顶 92% 后显示等待后端结果。

线程 ID 徽章在 `60-plugin-marketplace.js` 插入为官方标题节点的兄弟，并清理旧 wrapper，保持 React 节点归属。Codex++ 页面在 `40-backend-settings.js::positionCodexPlusPage` 读取顶部栏、工作区边界和官方面板圆角，再由 `10-style.js` 布局；缩放值统一换算到布局坐标。

脚本市场的标题与安装状态分别布局，状态标签不收缩、不拆行，长标题和标签可换行。列表在窄窗口中改为分行展示；皮肤市场的操作区允许换行，长名称、版本和状态截断时保留悬停提示。共享 `Badge`、`Button` 组件保留 `badge`、`button` 类名，供市场角标定位和操作区布局使用。

入口为 `apps/codex-plus-manager/src/App.tsx`、`styles.css` 与 `components/ui/`。

## 功能归属与验证

会话导出、Stepwise、大纲、插件市场等大部分能力源自上游；这里记录个人版的兼容和交互差异，不将上游能力都列作个人原创。

验证：前端 `session-delete-flow.test.ts`、`floating-panel-interaction.test.ts`，Rust `crates/codex-plus-core/tests/floating_panel_*.rs` / `cdp_bridge.rs`。同时检查市场卡片与列表的窄窗口布局，以及悬浮窗各材质、拖动、缩放、吸附和展开收起效果。

## 语音输入与缓存清理

语音输入使用独立的 `dictation` 配置，默认关闭；`enhancementsEnabled` 关闭时暂停录音，服务配置保留。管理器草稿与默认值位于 `dictation-settings.ts`、`provider-types.ts` 和 `lib/default-settings.ts`，Rust `settings.rs` 归一化并加密 `dictation.apiKey`。渲染端唯一入口是 manifest 的 `93-dictation.js`，设置加载成功后经 `runScanStep` 安装，录音界面失败不改变供应商设置加载结果。支持插入、停止并发送、重试和取消；发送前验证当前会话与原生输入框，避免把旧录音发进新会话。旧的 settings/stepwise 导航归一到增强页的下一步建议标签。

缓存页 `agent-cache.tsx` 通过 Tauri `scan_agent_cache` / `clean_agent_cache` 调用 `agent_cache.rs`。清理只接受后端保存的扫描快照和组 ID，快照 10 分钟到期且只能消费一次；逐文件校验并删除超过 24 小时的白名单缓存，不接收前端文件路径。录音、配置和会话数据不作为缓存清理对象。验证：`dictation-runtime.test.ts`、`enhancement-settings.test.ts`、`agent-cache-model.test.ts`、Rust dictation 与 agent_cache 单测。
