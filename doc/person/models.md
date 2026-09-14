# 模型目录与排序

## 业务行为

- 模型来自当前供应商配置、上游目录和按设置混入的原生模型；排序不新增、不删除模型，也不把任何品牌固定置顶。
- Codex 官方响应已有的模型保持官方顺序，避免个人版用名称规则覆盖官方维护的能力顺序。
- 原生菜单保留选择能力，不重新插入个人版已去掉的模型管理面板或未测试提示。

## 排序规则

1. 先记录 Codex 官方响应中已有模型的相对顺序，合并后仍按该顺序展示这些模型。
2. 官方响应中没有、由个人版补入的模型排在已有模型之后，再按实际模型 ID 生成排序键；若官方响应中没有任何可保留模型，则整份列表使用该兜底规则。
3. 兜底比较时忽略大小写，将点、下划线和空白规范为分隔符，拆成文字与数字片段；只用于比较，不改写原始 ID。斜杠命名空间保留。
4. 文字片段自然升序，让相同名称前缀的系列相邻；对应数字片段降序，使较大的版本数字排前。完全相同的前缀下，完整名称排在简写前。
5. 没有数字的别名也按名称正常展示；比较结果相同的条目保持原相对顺序，重复刷新不抖动。
6. 不修改默认模型、当前选择或供应商配置的持久化顺序；只更新菜单的显示顺序和与之对应的 priority。

这是一套名称整理规则，不是模型能力排行榜。数字可能表示版本、日期或规模，不能据此宣称模型更强；也不能仅凭未知型号名称可靠判断它是图像、语音还是对话模型，因此不硬编码用途分组。不同供应商新增模型无需更新名单。

## 代码入口与配置

- `assets/inject/renderer-inject.js`：`sortModelChoices`、`patchModelNameArray`、`patchModelArray` 及现有 RPC 适配层。
- `crates/codex-plus-core/src/model_catalog.rs` / `model_suffix.rs`：目录来源与模型元数据。
- 关注 `codexAppModelWhitelistUnlock`、`codexAppIncludeNativeModels`、`relayProfilesEnabled`；RPC 对象可能不可写，应使用现有适配器，本机目录不能注入远程主机。
- 管理器供应商编辑页的家族标签由 `apps/codex-plus-manager/src/model-groups.ts` 负责，是另一处界面，不应和本页描述的原生菜单排序混为一谈。

## 回归检查

- 前端 `model-order.test.ts`：混合供应商、未知家族、别名、命名空间、大小写、数字版本、完整名称和简写、动态新增、对象元数据与稳定性。
- 前端 `model-rpc-compat.test.ts` / `renderer-model-runtime.test.ts`：实际 RPC 合并链路、默认模型保留与远程隔离。
- Rust `crates/codex-plus-core/tests/model_catalog.rs` / `cdp_bridge.rs`：目录与注入兼容。
