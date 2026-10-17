# 提示词增强

在 Codex 输入框底部加一个增强按钮。点击后把当前草稿交给模型改写，结果
在可编辑的预览框里显示；用户点「替换」或「插入到末尾」后才写回输入框，
点「取消」或按 Esc 时输入框保持原样。

## 配置

设置保存在 `settings.json` 的 `promptEnhance` 对象中，默认关闭，并受
`enhancementsEnabled` 总开关控制。管理器的 Codex 增强页有独立的「提示词增强」
标签，保存后无需重启 Codex。

- `useStepwiseConnection` 默认开启，沿用下一步建议的 Base URL、API Key、协议
  和模型；关闭后使用本组的 `baseUrl`、`apiKey` / `apiKeyEnv`、`protocol`、`model`。
- `systemPrompt` 留空时使用内置改写规则：推断真实意图，补充范围、关键功能、
  技术约束、交付物和验收方式；需要取舍时直接写明合理假设，不反问用户；保留原文
  的代码、路径、命令和 @引用，按任务大小控制篇幅，并沿用草稿语言。
- 内置规则的原文在 `assets/prompt-enhance/system-prompt.md`，编译时嵌入，调整规则
  只改这个文件。管理器「改写规则」旁的「填入内置规则」会把它填进输入框，改完保存
  即生效；「恢复内置规则」清空设置，重新使用内置规则。
- `timeoutSeconds` 范围 5–300 秒，默认 60 秒。

`promptEnhance.apiKey` 沿用密钥字段规则加密落盘，注入页只拿到
`apiKeyConfigured`。

## 实现

- 渲染端入口是 manifest 的 `93-prompt-enhance.js`，复用语音输入的输入框
  定位和 footer 去重逻辑。开关关闭时不挂载 DOM。
- 页面经桥接调用 `/prompt-enhance/generate`，Rust 的 `prompt_enhance.rs`
  请求模型，并复用 `stepwise.rs` 的协议列表和请求头工具，支持 Chat
  Completions、Responses、Anthropic Messages 以及自动回退。页面不直接访问
  模型服务，也不接触 API Key。
- 优先使用 Codex 输入框自己登记的 `updatePromptText`（按函数能力识别，不依赖
  压缩后的导出名）。它以 Markdown 读写草稿，@文件、技能等引用序列化成链接，
  写回时由 Codex 重新解析，所以含引用的草稿也能整段替换，替换单独成为一个
  撤销步骤。
- 找不到原生接口时退回旧路径：ProseMirror 用一次事务替换或追加段落；
  textarea 通过原型 setter 写入并派发 `input`。旧路径下草稿含 @文件、技能、
  附件等非文本节点时只能插入到末尾或复制。

确认替换时会重新读取当前草稿，以下情况不允许整段替换，只能插入到末尾或复制：

- 旧路径下草稿含非文本节点，包括生成期间把文字转成了同名 @文件引用；
- 生成期间草稿被修改过（原生路径比较 Markdown，旧路径比较文档对象，
  文字相同但结构变化也算修改）；
- 输入框或会话已经变化（这时插入也会被拒绝）。

预览框只在可以替换时显示「替换」按钮，不能替换时把原因写在状态行。

## 验证

```sh
cargo test -p codex-plus-core --lib prompt_enhance
cargo test -p codex-plus-core --test cdp_bridge prompt_enhance
node assets/inject/prompt-enhance.test.cjs
cd apps/codex-plus-manager && node --test src/prompt-enhance-settings.test.ts src/enhancement-settings.test.ts
```
