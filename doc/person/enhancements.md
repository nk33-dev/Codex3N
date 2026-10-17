# 界面增强与去广告

## 无广告个人版

不展示原管理器推荐/赞助内容，不启动原广告获取链路；原广告模块已经删除，不应作为可启用功能列出。这不是浏览器通用广告拦截器，普通插件或社区链接也不等同于广告。

同步上游时检查 `apps/codex-plus-manager/src/App.tsx`、`apps/codex-plus-launcher/src/main.rs`、`crates/codex-plus-core/src/routes.rs`，防止重新带回广告模块、推荐接口和推广 UI。

## 增强设置保存

增强页分为常用增强、语音输入、下一步建议三个标签，开关统一只改草稿；顶部显示保存状态与保存按钮，点击保存后同步配置。Stepwise、回答大纲和桌宠开关也不偷偷提交整个表单，避免部分自动保存、部分手动保存造成保存栏闪烁。

总开关、保存栏与标签随页面滚动，避免覆盖功能分组标题。“自动接管官方 App”开关位于管理器的“安装维护”页。

入口为 `apps/codex-plus-manager/src/App.tsx` 的 `EnhanceScreen`。配置关注 `enhancementsEnabled`、对应 `codexApp*` 开关，不能把隐藏保存栏当作保存成功。

`codexAppUsageStatusLine` 默认开启，`83-usage-statusline.js` 在输入框下方显示生成速度、缓存命中率和上下文占用；通过内置 `/thread-usage-live` 路由只读取最近用量事件，不加入第三方拓展白名单。速度包含工具执行时间；缓存命中率为缓存输入 Token / 输入 Token，上下文占用按 Codex 会话记录中的模型窗口计算。`codexAppStandaloneQuotaUnlock` 默认关闭，独立额度解锁与供应商总开关分开保存。两项开关均沿用增强页手动保存。验证见 `usage-statusline.test.ts`、`standalone_quota_settings.rs`、`native_api_quota_gate.rs` 与 `bridge_routes.rs`。

增强页与注入面板使用中文标题、说明；产品名、协议与命令保持原文。注入面板入口为 `assets/inject/renderer-inject.js` 的 `openCodexPlusModal`，管理器英文模式沿用 i18n 字典。远程 Zed、Upstream 工作树适配、原生菜单汉化、快速启动及增强模式选择已随上游撤下，原生 SSH、工作树和会话分享保持可用。

`codexAppForceChineseLocale` 默认关闭，启用后由 `00-prelude.js::installCodexPlusForceChineseLocale` 写入原生 `localeOverride` 并补充语言包探测；关闭时只还原本工具写入且用户未另改的值。`81-capacity-auto-retry.js` 处理容量错误，`codexAppCapacityAutoRetry` 默认关闭，间隔和次数保存在注入页设置中；`82-boot-shell-recovery.js` 对长时间未挂载的启动壳执行有界刷新。`codexAppActivityOverlayRight` 默认关闭，`98-avatar-overlay-layout.js` 负责活动浮层右侧布局，均经同一 manifest 拼装入口安装。

注入页避免后台空转：`codexPlusSettings()` 挂在滚动监听和逐帧对齐路径上，缓存键包含 `localStorage` 原文、后端设置对象和 `__CODEX_PLUS_DREAM_SKIN_THEME__` 身份；命中时不重复 `JSON.parse`，仍合并当前后端设置。语音按钮兜底扫描和皮肤定时全量 `ensure` 在 `document.hidden` 时跳过，仍保留 DOM 变化触发的路径。

扫描调度由 `98-scan-schedule.js` 保持唯一入口，200 ms 内合并侧栏、会话、菜单、壳层及模型任务；未知宿主结构完整刷新兜底。消息正文的无关变化不刷新整套增强，延迟扫描只保留一帧。导航、隐藏和重新注入会取消旧任务；隐藏期间只记脏状态，恢复后补扫一次，供应商心跳和原生后台任务不受影响。每次执行扫描先复位排队标记，否则后续变更全被丢弃。

图标栏入口由 `40-backend-settings.js::codexPlusRailInsertAnchor` 定位：优先插在自动化等非固定入口之后；启动时宿主先只渲染主页和自定义，自动化约晚 1 秒出现，这段时间退到主页那一项之后，下一轮侧栏扫描再挪到自动化后面。没有任何原生入口时暂不插入。第三方拓展入口（`92-extension-host.js::refreshCodexPlusRailNavigation`）共用该锚点。位置已正确时不写 DOM。验证见 `rail-navigation.test.ts`。

服务模式徽章由 `90-action-groups.js::codexServiceTierBadgePlacement` 插在当前输入工具栏的原生模型选择器前；穿过提示与普通包裹层，保持同一 flex 行。旧版只在唯一 footer 的可见按钮组内兜底，不能确认布局时跳过；不按供应商文字匹配草稿、项目栏或编辑区。加载时显示“读取中”，状态不变时不重写文字与属性。侧栏操作组、更多菜单及工具提示也纳入扫描排除，避免自己的 DOM 更新触发增强扫描。验证见 `service-tier-badge.test.ts`。

输入框内的文字编辑不触发增强扫描；输入框或菜单挂载仍刷新。输入法组词期间取消增强扫描和会话对齐帧，结束或窗口失焦后合并补扫；不拦截原生输入事件。悬浮球回答观察忽略输入框内变化，隐藏期间不做变更分类。心跳继续检查连接与配置，配置未变时不重绘增强，连接状态文案和侧栏标记只在值改变时写入。

`assets/inject/conversation-performance.js` 由 `assets.rs` 经同一注入入口加载，识别 Codex 主页面和 ChatGPT 普通聊天页面。每个会话窗格达到 40 条已挂载消息时，对历史消息使用 `content-visibility:auto` 与实测逻辑块高度，最新两条保持原生渲染。不删除消息或 React 节点，不隐藏正文；跳过原生虚拟化、绝对定位及可能改变外边距折叠的节点。浏览器搜索、选择与辅助功能仍可访问历史内容。隐藏、输入法组词时暂停，重新注入及关闭增强总开关会还原本工具写入的样式。该优化减少挂载后的布局和绘制，不能消除宿主历史读取或 React 首次构建的耗时。

Windows 的 `03-native-performance.js` 从宿主 `app-shared-*` 模块按结构识别 Git worker 工厂；识别失败沿用原生行为，不改压缩导出名。合并同一目录和主机配置的 `stable-metadata` 查询，成功的仓库根目录与公共 Git 目录缓存 2 秒，最多 64 项；失败和非仓库结果不缓存。Git 事件、其他 Git 请求、窗口聚焦和可见性变化使缓存失效。一个调用取消不影响其他等待者，所有等待者取消时才取消共享请求。远程主机、初始化监听和写操作不合并；关闭增强或重新注入还原客户端方法并移除监听。宿主 worker 内部独立轮询与进程创建不在该补丁控制范围内。

会话居中缓存仍连接的内容、输入框节点，结构或可见性变化时重新定位；正文内部变化交给尺寸观察，不每帧全页查找。两次连续几何结果稳定后停止，单轮最多 16 帧；侧栏、窗口尺寸及布局过渡结束后可补对齐，保持批量几何读取和样式写入。性能采样入口见[运行实现](runtime.md#会话切换性能诊断)。

性能回归见 `native-performance.test.ts`、`renderer-performance.test.ts` 与现有注入测试。Windows Chromium 页面验证涵盖长历史高度、搜索、选择、滚动到底和停用还原；这些夹具结果不代表真实 ChatGPT/Codex 客户端已修复。macOS、Linux 的原生运行行为及用户长会话仍需实测。

## 悬浮球

错误态不再绘制双 X，使用温和平静的短眼形；保留微笑、拖拽、展开及建议/大纲能力。表情调整不等于忽略实际错误，状态说明仍须可见。

哑光材质展开时从第一帧铺满面板范围，展开动画期间不再从边缘漏出底层页面。

Stepwise 的 Chat Completions 返回若因推理内容耗尽输出额度而没有正文，会自动关闭该次请求的推理并重试一次，避免把有效连接误显示为 0 条建议。

系统启用“减少动态效果”时，等待状态不旋转，改用静态蓝色状态点，避免停止在圆环顶部时看起来像界面卡死；正常动画设置下仍使用持续旋转的圆环。

拖动、调整大小和指针光泽按动画帧合并更新，同一轮计算复用主界面的安全边界。普通平移使用 `transform`，内部尺寸不变时不重复更新材质几何与滚动渐隐；磨砂、通透、液态、冰晶、哑光的配色、滤镜和表情保持原样。松手应用最后坐标并保存位置，失焦、指针取消或丢失捕获时释放拖动状态；拖动期间延后回答扫描及内容重绘，避免替换捕获指针的标题节点。

入口为 `assets/inject/floating-panel/core/appearance.js`、`geometry.js`、`interaction.js`、`views.js` 与 `runtime/state.js` / `lifecycle.js`。改变需要更新的注入行为时检查脚本版本，避免旧实例继续使用旧样式。

悬浮面板隐藏时取消回答扫描计时器，恢复后补扫一次；停止运行会移除可见性监听。已发出的建议请求与设置同步继续沿用原生命周期和过期结果校验。

## 管理器市场布局

皮肤页在增强关闭、皮肤关闭或暂停时显示“Codex 原生外观”，已保存主题仅保留在编辑区，不标记为当前运行。社区与市场的卡片共用 `App.tsx::DreamSkinPreview`，直接显示各主题封面，加载失败显示占位；更换地址后允许重新加载，不以平台内置图片冒充其他主题。远程封面的 CSP 白名单见[安全边界](security.md#管理器-webview)。

皮肤状态与封面恢复回归见 `dream-skin-ui.test.ts`、`dream-skin.test.ts`。Windows Chromium 验证真实 React 组件和管理器 CSP，并用当前 Codex 输入框的 DOM 副本检查 900、600、400 像素宽度下的徽章位置和重复刷新；网络检查确认两个来源的封面返回图片。上述验证不涉及官方 App 退出重开，macOS 原生运行及完整长会话性能仍需实测。

脚本市场通过 `App.tsx::UserScriptsScreen` 从 `user_scripts` 映射市场 ID 到本地 `user:` key，`MarketScriptCard` 用原 `deleteUserScript` 操作卸载。插件修复进度是估算值，封顶 92% 后显示等待后端结果。

线程 ID 徽章在 `60-plugin-marketplace.js` 插入为官方标题节点的兄弟，并清理旧 wrapper，保持 React 节点归属。Codex++ 页面在 `40-backend-settings.js::positionCodexPlusPage` 读取顶部栏、工作区边界和官方面板圆角，再由 `10-style.js` 布局；缩放值统一换算到布局坐标。

脚本市场的标题与安装状态分别布局，状态标签不收缩、不拆行，长标题和标签可换行。列表在窄窗口中改为分行展示；皮肤市场的操作区允许换行，长名称、版本和状态截断时保留悬停提示。共享 `Badge`、`Button` 组件保留 `badge`、`button` 类名，供市场角标定位和操作区布局使用。

入口为 `apps/codex-plus-manager/src/App.tsx`、`styles.css` 与 `components/ui/`。

## 功能归属与验证

管理器沿用上游 Agent 图标栏与原生工作区布局。供应商编辑分组由 `App.tsx::RelayFold` 保存展开偏好，新出现的校验错误展开对应分组，模型配置首次默认展开。

上游已撤下 Codex++ 会话分享、文件导入与分享链接入口，原生会话能力继续由宿主提供。旧 `codexAppSessionShare` 配置保留读取兼容，不再注册分享按钮。`codexAppTypingEffect` 保存 `off`、`rainbow`、`fireworks`、`stars`，默认关闭；入口为 `94-typing-effects.js`，跟随输入法组合状态和系统减少动态效果设置。

`codexAppWhaleWidgetEnabled` 默认关闭，挂件入口是 `96-whale-compat.js` 与 `97-whale-widget.js`，完整引擎由 `assets.rs` 内联。余额查询复用已保存的供应商凭据，币种、路径、字段与倍率由 `whale-settings.ts` 校验；本地用量、余额账本和账户校正分别保存在 `whale_usage.rs`、`whale_history.rs` 与 `whale_full.rs` 的运行路径。相关读写回归使用临时数据，不操作活动数据库。

会话导出、Stepwise、大纲、插件市场等大部分能力源自上游；这里记录个人版的兼容和交互差异，不将上游能力都列作个人原创。

验证：前端 `session-delete-flow.test.ts`、`floating-panel-interaction.test.ts`，Rust `crates/codex-plus-core/tests/floating_panel_*.rs` / `cdp_bridge.rs`。同时检查市场卡片与列表的窄窗口布局，以及悬浮窗各材质、拖动、缩放、吸附和展开收起效果。

## 语音输入与缓存清理

语音输入使用独立的 `dictation` 配置，默认关闭；`enhancementsEnabled` 关闭时暂停录音，服务配置保留。管理器草稿与默认值位于 `dictation-settings.ts`、`provider-types.ts` 和 `lib/default-settings.ts`，Rust `settings.rs` 归一化并加密 `dictation.apiKey`。渲染端唯一入口是 manifest 的 `93-dictation.js`，设置加载成功后经 `runScanStep` 安装，录音界面失败不改变供应商设置加载结果。支持插入、停止并发送、重试和取消；发送前验证当前会话与原生输入框，避免把旧录音发进新会话。旧的 settings/stepwise 导航归一到增强页的下一步建议标签。

`dictation.provider` 支持 `api` 和 `sensevoice`，旧配置默认沿用 API 转写。SenseVoiceSmall INT8 模型由配置页手动下载固定版本并验证 SHA-256，录音入口不触发下载；浏览器将音频转为 16 kHz 单声道 WAV，Rust `dictation.rs` 经 sherpa-onnx 在本机推理。识别器在专用线程串行复用，模型或语言变化时重新校验和加载，PCM 样本直接进入推理；缓存会常驻一份模型内存。

提示词增强使用独立的 `promptEnhance` 配置，默认关闭并受 `enhancementsEnabled` 控制；默认复用下一步建议的连接，也可单独配置服务和改写规则；内置规则原文在 `assets/prompt-enhance/system-prompt.md`，管理器可一键填入后再改。渲染端唯一入口是 manifest 的 `93-prompt-enhance.js`，复用语音输入的输入框定位，按钮与语音入口挂在同一 footer 上。结果先在可编辑预览框中显示，确认后才写回。写回优先走 Codex 输入框登记的 `updatePromptText`，草稿以 Markdown 读写，@文件和技能引用会保留；拿不到原生接口时才直接改 ProseMirror，这时含非文本节点的草稿只能插入到末尾或复制。确认替换时重新读取草稿，生成期间有改动（含文字转成同名引用）也只能插入或复制。Rust `prompt_enhance.rs` 复用 `stepwise.rs` 的协议工具；完整说明与验证命令见 `docs/prompt-enhance.md`。

Claude 增强页通过 `claude_localization.rs` 创建受管副本、检查版本与 `app.asar` 一致性。页面由用户点击检测，后台探测单个命令最多等待 3 秒、整组最多 15 秒，超时回收子进程；离页后的结果不提交。`claudeAppLocalization` 和 `claudeAppVoiceInput` 默认开启，分别控制界面汉化与语音入口，重启副本后应用；关闭汉化时恢复已保存的外壳语言。Windows 支持普通安装和 MSIX 来源，普通副本以完整应用目录替换，失败时恢复旧目录；macOS 副本重新签名。命令只通过 Tauri 注册，回归见 `claude-localization-screen.test.ts` 和本地化单测。

`assets/claude-localization/page-dictation.js` 适配 Claude Code 与 Cowork 输入框，识别结果只写入输入框；`hook.js` 通过听写 helper 转发请求。`launcher.rs` 在 helper 运行期间保存 `dictation-helper.json`，停止时删除；语音开关关闭时不注入页面入口和调用通道。验证见 `claude-dictation.test.ts`、Claude 本地化与听写单测。

缓存页 `agent-cache.tsx` 通过 Tauri `scan_agent_cache` / `clean_agent_cache` 调用 `agent_cache.rs`。清理只接受后端保存的扫描快照和组 ID，快照 10 分钟到期且只能消费一次；逐文件校验并删除超过 24 小时的白名单缓存，不接收前端文件路径。录音、配置和会话数据不作为缓存清理对象。验证：`dictation-runtime.test.ts`、`enhancement-settings.test.ts`、`agent-cache-model.test.ts`、Rust dictation 与 agent_cache 单测。

## 低功耗与 Git 维护

`codexAppLowPower` 默认关闭，由管理器增强页保存。开启后，bridge 在同一目标的设置响应中应用 `prefers-reduced-motion: reduce`，注入运行时暂停无限循环的 CSS 动画；有限动画和过渡继续运行。关闭总开关或低功耗开关时还原动画与媒体覆盖，页面隐藏时停止动画扫描。设置读取失败保持原状态，CDP 不支持媒体模拟时记录 `low_power.media_failed`。

Windows 的启动参数区提供 `--disable-direct-composition` 快捷项，保存后需重启官方 App，效果取决于显卡。MSIX 多开 wrapper 同样透传额外参数，按 Windows argv 和 cmd 两层转义，使用 UTF-8 代码页及关闭延迟展开。

Git worker 的 `stable-metadata` 成功结果继续缓存 2 秒；低功耗开启后，非仓库结果和查询失败缓存 30 秒，取消不缓存。缓存按目录和主机隔离，Git 事件、聚焦、可见性变化和开关切换使其失效。远程请求、监听初始化和写操作继续走原生路径。入口为 renderer 的 `03-native-performance.js`，按已核对的工厂结构依次检查 shared、initial 模块，并复用模块加载缓存；单个不可读取的导出不影响识别。行为测试见 `native-performance.test.ts`。

维护页的异常 Git 扫描只读取 `.codex-global-state.json` 中的本地工作区根目录，支持旧工作区列表及现代 `local-projects[].rootPaths`。缺少 HEAD 的 `.git` 目录先列出，用户确认后重新校验工作区记录和目录指纹，再改名为 `.git.codex3n-empty-<时间戳>`。不递归扫描，不处理 `.git` 文件、链接或检查期间变化的目录。后端入口为 `git_maintenance`，Tauri 命令为 `scan_empty_git_directories`、`quarantine_empty_git_directory`。
