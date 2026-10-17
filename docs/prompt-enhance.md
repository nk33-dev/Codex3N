# 提示词增强

输入框底部的增强按钮可选择「普通改写」或「追问」。结果先进入可编辑预览，
确认替换或插入后才写回；也可复制、取消或按 Esc 关闭。

## 配置

配置位于 `settings.json` 的 `promptEnhance`，功能默认关闭，受
`enhancementsEnabled` 控制，管理器保存后立即生效。

- `useStepwiseConnection` 默认开启，复用下一步建议连接；关闭后使用本组
  `baseUrl`、`apiKey` / `apiKeyEnv`、`protocol`、`model`。
- `rewriteEnabled`、`grillEnabled` 分别控制普通改写与追问，缺省都开启。
  只有一种可用时直接进入该模式，两种可用时在增强图标旁显示窄的竖向菜单「改写 / 追问」；默认模式仅决定菜单顺序。默认模式已关闭时回退到另一个。
  两种都关闭时停止收集项目上下文，已保存的规则和分类选择继续保留。
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

## 追问流程与接口

问题标签可切换，每题 2–3 个选项并标记推荐项，也可自行填写。推荐项需主动选择，
切题保留答案，整轮提交。每轮最多 3 题、最多 3 轮；第三轮提交后强制生成，
也可随时直接生成，仅使用已确认或填写的答案。

追问中草稿文字或结构变化时暂停，重新开始会读取新草稿并清空问答。
失败保留答案供修改、重试；取消、切会话、重新开始或新请求使旧 revision 失效。
取消使结果作废，已经发出的模型请求仍可能继续计费。

沿用内部桥接 `/prompt-enhance/generate`，不向第三方扩展开放：

- 请求保留 `prompt`，新增可选 `mode/workingDirectory/hostId/sessionId/history/forceFinal`；
  旧请求继续普通改写。
- `history` 每轮含 `questions/answers`；问题含 `id/title/question/options/recommended`，
  选项含 `label/description`，推荐索引从 0 开始，答案含 `questionId/answer`。
- 成功响应含 `status:"ok"`、`protocol`、`context`，以及
  `kind:"questions"` 和问题，或 `kind:"final"` 和 `text`。
  结构化解析失败时原文进入预览；强制生成仍收到合法追问时提示重试。
- Rust 保持无状态，限制 3 轮、每轮 3 题、每个答案 3000 字符及历史 120000 字节。
  连接及 Chat Completions、Responses、Anthropic Messages 与自动回退复用现有实现。

## 场景、收藏与反馈

预览提供通用、新功能、修 bug、代码审查四种场景，默认通用。场景规则附加在用户
规则后，同时适用于普通改写与追问。选择场景不发请求，点击重新生成才生效；
已有编辑或追问答案时先提示，重新生成追问会清空答案并开始新一轮。
`/prompt-enhance/generate` 接受可选 `scenario`（`general/feature/bugfix/review`），
旧请求按通用处理；成功响应的 `metadata` 含 `mode/scenario/model/systemPrompt`。

收藏入口独立于模型开关，受增强总开关控制。输入框旁可搜索、预览、新建、编辑，
也可从当前草稿或增强结果收藏。取用支持替换、插入到末尾、复制；与增强结果共用
原生 Markdown 读写及引用保护。打开预览后草稿变化禁止替换，会话或项目变化禁止
写入；成功取用后才更新最近使用时间。

收藏包含标题、正文、标签、置顶状态和可选项目身份（`hostId/workingDirectory`）。
快捷面板宽度最多 420 像素，搜索即时筛选，列表直接展示标题和两行摘要；展开后预览全文和使用操作，筛选与排序默认收起。默认展示全局与当前项目收藏，目录无法确认时只展示全局。主机身份必须匹配，
Windows 目录分隔符与大小写统一后比较。管理器的提示词增强页可集中增删改、筛选
项目、排序、置顶，以及导入导出；收藏操作即时保存，不依赖顶部的配置保存按钮。

导出文件为 `{"version":1,"favorites":[...]}`，包含时间和项目身份。导入上限 8 MiB、
5000 条，先预览新增与重复数量，再确认导入。重复 ID 跳过；格式不正确时整次导入
失败，原库保持不变。标题最多 200 字，正文最多 20000 字，最多 20 个标签，每个
标签最多 64 字。导出使用管理器原生文件保存对话框。

结果预览的「反馈」默认折叠，评价与备注仅在点击「提交反馈」时落盘。保存原稿、生成结果、编辑后的
结果、已确认追问答案、模式、场景、模型、规则快照和时间。增强页提供查看、搜索、
评价筛选、删除和 JSON 导出，供人工集中调整规则。记录不包含 API Key 或项目上下文
文件正文；原稿与结果本身可能含用户输入的内容。

收藏和反馈分别存于实例设置目录旁的 `prompt-enhance.sqlite3`，复用 SQLite 事务与
5 秒繁忙等待；重启继续使用。管理器 `prompt_tools_request` 与内部桥接
`/prompt-enhance/library/*`、`/prompt-enhance/feedback/*` 共用 Rust 存储实现。
这些路由不开放给第三方扩展；错误不回显请求正文。界面将持久化内容作为文本显示。

## 写回与验证

唯一渲染入口仍为 manifest 的 `93-prompt-enhance.js`，复用语音输入的定位和去重。
优先使用原生 `updatePromptText` 按 Markdown 读写，保留文件、技能链接，
每次写回独立成一个撤销步骤。回退路径用 ProseMirror 单个事务或 textarea setter；
含非文本节点时只可追加或复制。

收藏和增强入口使用原生输入框操作组，新版网格底栏不会因追加入口多出一行。菜单支持方向键、Home/End、Escape 和点击外部关闭。

替换前重新核对草稿文字及文档对象，变化时只可追加或复制。
输入框、会话或已知工作目录变化时拒绝写入。结果预览沿用替换、追加、复制快捷键。

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

Windows 验证使用 Codex `26.1013.3656.0` 的隔离实例：已打开新会话草稿，验证原生
输入框入口、真实模型改写、三轮追问至最终结果、原生替换写回和从草稿保存收藏。
更新后的两个入口位于原生操作组同一行。真实模型多轮通过内部桥接验证，界面问答
和改稿/取消/过期响应由运行夹具覆盖。真实客户端的项目切换、完整问答界面流程和
彻底退出后的重启验证仍待完成；macOS、Linux 原生运行仍需实测。

`scripts/prompt-tools-ui-smoke.mjs` 在独立 Edge 目录运行真实 DOM 与 React 面板，
覆盖搜索、收藏创建/追加、主动反馈、单模式直达、双模式菜单、网格底栏和 400 像素
布局；通过 `CODEX_TEST_BROWSER` 可指定兼容 Chromium 的浏览器。截图使用测试内容，
不能代替真实客户端与模型服务验证。

完整检查包括 `cargo fmt --check`、`cargo check --workspace`、`cargo test --workspace`、
`npm test`、`npm run check` 和前端构建。旧工作树的 relay 测试程序只有 `.d/.pdb`，
缺少 `.exe`；独立构建目录已重建并通过 relay 的全部 3 项测试，原文件丢失原因未确认，
未修改 relay 业务逻辑。构建负载较高时 Windows 上的 macOS DMG 夹具有 15 秒 shell
超时；本次最终 `npm test` 与串行全量均为 848 项通过、1 项原有跳过。Rust workspace 全量为 2473 项通过、10 项原有忽略。

可用 `prompt_tools_probe` example 在临时目录重现隔离客户端检查。需显式指定
`CODEX_PLUS_STATE_DIR=<临时目录>/state`、`CODEX_HOME=<临时目录>/codex-home` 和
`CODEX_PLUS_MULTI_INSTANCE=1`，参数依次为官方 App 目录、临时目录、调试端口、
已有设置路径。程序只复制提示词服务配置；Windows 复制同目录 DPAPI 主密钥的
受保护文件以读取原密文，源设置不变。已有验收目录的主密钥不同则要求另建目录。
