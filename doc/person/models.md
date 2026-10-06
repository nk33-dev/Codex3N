# 模型目录与排序

## 业务行为

- 模型来自当前供应商配置、上游目录和按设置混入的原生模型；排序不新增、不删除模型，也不把任何品牌固定置顶。
- 启用供应商配置时，模型目录会使用当前命名 Key 请求该供应商 `/models`；Key 参与缓存身份，切换分组 Key 后不会复用旧 Key 的模型结果。动态发现结果与手工模型列表合并。
- 手工模型列表是显式覆盖层：同名 `/models` 条目存在时，`modelWindows` 中的上下文窗口仍覆盖上游描述，避免手工 `1M` 被上游 `256K` 反向覆盖。
- 管理器模型行支持拖拽和键盘排序；排序同时移动行的原模型名，并关闭按行索引定位的元数据导入面板。上下文窗口和自动压缩输入的 K/M 单位通过 `model-metadata.ts` 的 `normalizeTokenCountInput` 展开。
- 用户外部 `model_catalog_json` 与每模型覆盖冲突时，保留外部目录并应用顶层上下文、自动压缩兜底值；每模型覆盖在该目录下不可用。
- 官方响应和个人版补入的模型使用同一显示排序，新增高版本不会被旧官方条目整体压到后面。
- 生成每个供应商的托管目录时保留原生模型条目；供应商模型排在前面，切换供应商会重建当前目录，不沿用上一份目录。用户显式指定的上下文窗口同时约束实际窗口和能力上限。
- 原生菜单保留选择能力，不重新插入个人版已去掉的模型管理面板或未测试提示。

## 排序规则

1. 合并官方目录和个人版补入的模型后，整份列表按实际模型 ID 排序，不按来源分层。
2. 比较时忽略大小写，将点、下划线和空白规范为分隔符，拆成文字与数字片段；只用于比较，不改写原始 ID。斜杠命名空间保留。
3. 文字片段自然升序，让相同名称前缀的系列相邻；对应数字片段降序，使较大的版本数字排前。完全相同的前缀下，完整名称排在简写前。
4. 没有数字的别名也按名称正常展示；比较结果相同的条目保持原相对顺序，重复刷新不抖动。
5. 不修改默认模型、当前选择或供应商配置的持久化顺序；只更新菜单的显示顺序和与之对应的 priority。

这是一套名称整理规则，不是模型能力排行榜。数字可能表示版本、日期或规模，不能据此宣称模型更强；也不能仅凭未知型号名称可靠判断它是图像、语音还是对话模型，因此不硬编码用途分组。不同供应商新增模型无需更新名单。

## 代码入口与配置

- `assets/inject/renderer-inject/70-model-catalog.js`：模型目录状态、加载、`sortModelChoices`、`patchModelNameArray`、`patchModelArray` 及 RPC 适配。新版宿主在导出对象不可写时，通过 `installCodexAppServerClientCapture` 定位客户端，桥接捕获后由 `installCodexAppServerClientPrototypePatch` 接管原型。
- `20-menu.js` 的 `codexAppScopeNodes`、`collectScopedAppServerRequestCandidates`：作用域 RPC 发现；`30-service-tier.js` 维护 Fast 控件与线程模型状态。
- 目录状态、失败计数、重试时间和白名单扫描时间均声明在主 IIFE。正常扫描复用进行中的请求，失败后按 5 秒起步、最多 60 秒退避；Key 切换等强制刷新会重新请求，相同结果不重绘菜单，扫描每秒最多一次。
- 注入脚本的唯一运行入口是 `crates/codex-plus-core/src/assets.rs` 的 `RENDERER_SCRIPT`，内联按 manifest 生成的 `assets/inject/renderer-inject.js`；拼装与作用域约束见 [runtime.md](runtime.md)。
- `crates/codex-plus-core/src/model_catalog.rs` / `model_suffix.rs`：目录来源与模型元数据。
- 关注 `codexAppModelWhitelistUnlock`、`codexAppIncludeNativeModels`、`relayProfilesEnabled`；RPC 对象可能不可写，应使用现有适配器，本机目录不能注入远程主机。
- 管理器供应商编辑页的家族标签由 `apps/codex-plus-manager/src/model-groups.ts` 负责，是另一处界面，不应和本页描述的原生菜单排序混为一谈。

## 回归检查

- 前端 `model-order.test.ts`：混合供应商、未知家族、别名、命名空间、大小写、数字版本、完整名称和简写、动态新增、对象元数据与稳定性。
- 前端 `model-rpc-compat.test.ts` / `renderer-model-runtime.test.ts`：实际 RPC 合并链路、默认模型保留与远程隔离。
- Rust `crates/codex-plus-core/tests/model_catalog.rs` / `cdp_bridge.rs`：目录与注入兼容。
