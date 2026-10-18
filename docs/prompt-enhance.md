# 提示词增强

输入框旁的工具入口提供「增强提示词」和「需求对齐」，常用提示词单独一个入口。
三者各有开关，只渲染开启的图标。内容显示在输入框上方的浮动卡片里：宽度与输入框
一致，最高约 62vh，内部滚动，标题和操作栏固定；用底边贴住输入框，内容较短时仍保持间距。
上方不足时放到下方，两侧空间均不足时在视口内显示。跟随输入框尺寸、页面滚动和界面缩放。
Esc 或点击外部关闭。结果由用户确认后写回，不自动发送。
设计规范与 dsh-promptkit（PromptKit）保持一致，模块名各自沿用。

## 配置

配置位于 `settings.json` 的 `promptEnhance`，功能默认关闭，受
`enhancementsEnabled` 控制，管理器保存后立即生效。

- `useStepwiseConnection` 默认开启，复用下一步建议连接；关闭后使用本组
  `baseUrl`、`apiKey` / `apiKeyEnv`、`protocol`、`model`。
- `rewriteEnabled`、`grillEnabled` 分别控制增强提示词与需求对齐，缺省都开启；
  `favoritesEnabled` 控制常用提示词入口，同样独立，缺省开启。
  两种模型模式都关闭时不渲染 ✨；只开一种时点击直接开始，开放两种时先弹菜单。
  默认模式决定菜单顺序，关闭时回退到另一个。输入框为空时「增强提示词」置灰并提示，
  「需求对齐」照常可用，第一题在本地先问「你想做什么？」。
- `defaultMode` 为 `rewrite`（默认）或 `grill`，决定模式菜单的首选项。
- `systemPrompt`、`grillSystemPrompt` 分别覆盖普通改写与追问规则。留空使用
  `assets/prompt-enhance/system-prompt.md`、`grill-system-prompt.md` 的内置内容；
  两组均可在管理器填入后编辑或清空恢复。
- `timeoutSeconds` 为单次模型请求超时，5–300 秒，默认 60 秒。
- `apiKey` 加密落盘，注入页只拿到 `apiKeyConfigured`，模型请求始终由 Rust 发起。

## 项目上下文

`context.enabled` 为总开关，`project`、`instructions`、`directory`、
`manifests` 为四类开关，默认全部关闭。所选内容会发送给用户配置的模型服务。

| 分类 | 来源 | Unicode 字符上限 |
| --- | --- | --- |
| 项目名与分支 | 工作目录名、Git 分支 | 512 |
| 项目说明 | 根目录 AGENTS.md 和 CLAUDE.md；均不存在时取 README 开头 | 6000 |
| 主要清单 | Cargo、Node、Python、Go、Java、.NET 顶层清单白名单 | 合计 6000 |
| 目录结构 | 两层、最多 200 项，跳过依赖、构建与隐藏目录 | 2000 |

总上限 14000 字符，包含分类标题；按项目信息、说明、清单、目录的顺序保留。
单文件最多读 32 KiB，目录扫描最多检查 400 项，失败跳过并说明。
文件规范路径必须位于工作目录内，目录遍历跳过链接。

`93-prompt-enhance-context.js` 沿当前输入框的 React 祖先匹配会话和主机，
优先读取元数据和原生 `getConversationCwd`，必要时用已匹配主机的客户端调用
`thread/read`（`includeTurns:false`）。新会话仅接受输入框所属元数据中的明确目录。
身份冲突、主机未知、远程主机或路径不可用时跳过，不用全局最近项目兜底。

页面只传定位信息，Rust `prompt_enhance/context.rs` 读取文件并截断；
上下文与草稿以独立字段放入 user 消息，系统规则将项目材料视为不可信参考。
预览中的「本次项目上下文」列出实际分类、文件、截断和跳过原因。
会话历史及 @文件正文不作为上下文发送。

## 追问流程

每组最多 3 题，一次只显示一题。点选后自动进入下一题，一轮答完自动提交；
数字键选择选项，←/→ 切换题目。底部 `‹ n/N ›` 在首末题禁用对应方向；「跳过此题」交给模型决定。「其他…」点击后原地变成输入框，回车确认，Esc 只收起输入框。
题目右侧的 ↻ 用于换个问法。已答的问题以 ✓ 小字列在当前题下方。
底部「不问了，直接写」立即生成最终提示词。

轮数不限；模型认为方向明确时返回需求小结，显示要点列表和「写提示词」「接着问」，
以及「‹ 改答案」。改成已有答案会丢弃其后的追问记录并重新推导。
输入框在卡片打开后被改动时，流程锁定：顶部固定显示「输入框内容改过了」，
只能「按新内容重来」，不允许静默置灰。失败时错误固定在底部操作区上方，可直接重试，
已填写的答案保留。

增强模式保留任务顺序、范围、授权和假设，只补足执行所需的表达与验收，不擅自扩成功能清单。
未核实的版本、路径和仓库关系交由执行者核对；附件引用不当作已读内容。
需求对齐只追问影响目标和范围的缺口，明确的草稿直接给小结，推荐选项不当作已确认答案。
结果可编辑，下方一行「还想改哪里？回车继续」；继续修改会带上当前结果和已确认内容。

关闭卡片、切换工具及会话时保留当前窗口的整理过程，退出客户端后清空。
取消、切会话和新请求使旧 revision 失效；带 requestId 的请求可经内部 cancel 路由中断。
模型服务已处理部分是否计费，由服务方决定。

沿用内部桥接 `/prompt-enhance/generate`，不向第三方扩展开放：

- 请求保留 `prompt`，支持 `mode/workingDirectory/hostId/sessionId/history/forceFinal`，
  及可选 `messages/currentText/requestId`；messages 每项含 `role`（user/assistant）与 `text`。
  旧请求继续普通改写。
- `history` 每轮含 `questions/answers`；问题含 `id/title/question/options/recommended`，
  选项含 `label/description`，推荐索引从 0 开始，答案含 `questionId/answer`。
- 成功响应含 `status:"ok"`、`protocol`、`context`，以及
  `kind:"questions"` 和问题、`kind:"summary"` 和需求小结，或 `kind:"final"` 和提示词。
  未确认时收到 final 按 summary 处理；格式错误保留答案并提示重试。
- Rust 不持久保存整理过程，每个答案最多 3000 字符，问答和补充消息合计最多 120000 字节。
  `/prompt-enhance/cancel` 接收 requestId，支持取消先于生成请求到达。
  连接及 Chat Completions、Responses、Anthropic Messages 与自动回退复用现有实现。

## 常用提示词

入口独立于模型配置，受增强总开关和 `favoritesEnabled` 控制。卡片内是搜索框、
筛选标签和列表：标签为「全部」「本项目」「通用」以及用户自定义标签；点一行即
追加到输入框并关闭。悬停显示替换、复制、编辑、删除；删除不弹确认框，提示条提供
「撤销」。拖动 ⠿ 或按方向键调整顺序，新条目放在最前。底部「存当前输入」直接保存：
第一行作标题，范围为当前项目；提示条可打开编辑，修改标题、标签和「所有项目都能用」。

取用与增强结果共用原生 Markdown 读写及引用保护。打开卡片后草稿变化禁止替换，
会话或项目变化禁止写入；成功取用后才更新最近使用时间。

收藏包含标题、正文、标签、手动顺序和可选项目身份（`hostId/workingDirectory`）。
`pinned` 字段只用于迁移旧数据，界面不再使用。默认展示通用与当前项目收藏，
目录无法确认时只展示通用。主机身份必须匹配，Windows 目录分隔符与大小写统一后比较。
管理器的提示词增强页可集中增删改、按标签和项目筛选、拖动排序，以及导入导出；
收藏操作即时保存，不依赖顶部的配置保存按钮。

导出文件为 `{"version":1,"favorites":[...]}`，数组顺序就是用户手动排的顺序。
导入上限 8 MiB、5000 条，先预览新增与重复数量，再确认导入；重复 ID 跳过，
新条目按文件数组顺序追加到末尾。格式不正确时整次导入失败，原库保持不变。
标题最多 200 字，正文最多 20000 字，最多 20 个标签，每个标签最多 64 字。
导出使用管理器原生文件保存对话框。

旧数据库首次打开时升级到版本 2：按置顶优先、最近使用倒序写入显式 `order`，
只迁移一次。之后列表默认 `sort:"manual"`，`library/reorder` 只重排传入的条目，
未传入的收藏保持原位置；删除返回原位置，恢复时按该位置插回。
评分反馈已停用，界面入口和新增接口移除。数据库内已有记录保留，旧记录读取和导出契约保持兼容。
收藏存于实例设置目录旁的 `prompt-enhance.sqlite3`，复用 SQLite 事务与
5 秒繁忙等待；重启继续使用。管理器 `prompt_tools_request` 与内部桥接共用 Rust 存储实现。
这些路由不开放给第三方扩展；错误不回显请求正文。界面将持久化内容作为文本显示。

## 写回与验证

唯一渲染入口仍为 manifest 的 `93-prompt-enhance.js`，复用语音输入的定位和去重。
优先使用原生 `updatePromptText` 按 Markdown 读写，保留文件、技能链接，
每次写回独立成一个撤销步骤。回退路径用 ProseMirror 单个事务或 textarea setter；
含非文本节点时只可追加或复制。

收藏和增强入口使用原生输入框操作组，新版网格底栏不会因追加入口多出一行。
菜单支持方向键、Home/End、Escape 和点击外部关闭。卡片打开期间再点同一个图标会关闭，
不会重新打开；另一个图标各自独立切换。

替换前重新核对草稿文字及文档对象，变化时只可追加或复制。
输入框、会话或已知工作目录变化时拒绝写入。替换成功后提示条提供撤销；
撤销要求输入框仍是写回后的内容。结果操作区左侧为重新生成、复制、存为常用，
右侧为追加和替换。

```sh
node scripts/assemble-renderer-inject.mjs --check
node assets/inject/prompt-enhance.test.cjs
node scripts/prompt-tools-ui-smoke.mjs
cargo test -p codex-plus-core --lib prompt_enhance
cargo test -p codex-plus-core --test cdp_bridge prompt_enhance
cd apps/codex-plus-manager
npm test
npm run check
```

此前 Windows 验证使用 Codex `26.1013.3656.0` 的隔离实例：已打开新会话草稿，验证原生
输入框入口、真实模型改写、三轮追问至最终结果、原生替换写回和从草稿保存收藏。旧的
侧面板界面已在当时完成这组验证；改版后的浮动卡片尚未在真实客户端重新安装验收。
多轮问答、自动提交、小结确认、模式菜单、追加/替换与撤销、收藏即时搜索、编辑、
删除撤销、手动排序和 400px 布局由下面的新夹具覆盖。真实客户端的项目切换、完整
问答界面流程和彻底退出后的重启验证仍待完成；macOS、Linux 原生运行仍需实测。

`scripts/prompt-tools-ui-smoke.mjs` 在独立 Edge 目录运行真实 DOM 与 React 面板，
覆盖原生操作组同一行、模式菜单与单模式直达、四轮自动问答与需求小结、替换撤销、
收藏存当前输入/即时搜索/追加/编辑/删除撤销、管理器的直接新建和 400px 布局。
设置 `DSH_PROMPTKIT_ROOT` 可一并验证 PromptKit 组件（同一夹具和自动答题流程）；
通过 `CODEX_TEST_BROWSER` 指定浏览器。截图使用测试内容，不能代替真实客户端与
模型服务验证。

当前改动的 Windows 检查：`cargo fmt --check`、`cargo local-check`、`cargo local-test`
（工作区，退出码 0）、`node scripts/assemble-renderer-inject.mjs --check`、注入提示词
测试、管理器 `npm run test:local`（866 项通过、1 项跳过）、`npm run check` 和
`npm run vite:build` 均通过。Chromium 夹具连同 PromptKit 组件验证了浮动卡片、
四轮自动问答、需求小结、追加/替换与撤销、收藏即时搜索、拖拽排序入口和 400px
布局。当前浮动卡片尚未在真实 Codex 客户端重新安装验收，macOS、Linux 未实测；夹具
与编译通过不能代替真实客户端和模型服务验证。

可用 `prompt_tools_probe` example 在临时目录重现隔离客户端检查。需显式指定
`CODEX_PLUS_STATE_DIR=<临时目录>/state`、`CODEX_HOME=<临时目录>/codex-home` 和
`CODEX_PLUS_MULTI_INSTANCE=1`，参数依次为官方 App 目录、临时目录、调试端口、
已有设置路径。程序只复制提示词服务配置；Windows 复制同目录 DPAPI 主密钥的
受保护文件以读取原密文，源设置不变。已有验收目录的主密钥不同则要求另建目录。
