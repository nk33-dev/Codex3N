# 界面增强与去广告

## 无广告个人版

不展示原管理器推荐/赞助内容，不启动原广告获取链路；原广告模块已经删除，不应作为可启用功能列出。这不是浏览器通用广告拦截器，普通插件或社区链接也不等同于广告。

同步上游时检查 `apps/codex-plus-manager/src/App.tsx`、`apps/codex-plus-launcher/src/main.rs`、`crates/codex-plus-core/src/routes.rs`，防止重新带回广告模块、推荐接口和推广 UI。

## 增强设置保存

增强页开关统一只改草稿；存在未保存修改时显示底部保存栏，点击保存后同步配置。Stepwise、回答大纲和桌宠开关也不偷偷提交整个表单，避免部分自动保存、部分手动保存造成保存栏闪烁。

入口为 `apps/codex-plus-manager/src/App.tsx` 的 `EnhanceScreen`。配置关注 `enhancementsEnabled`、对应 `codexApp*` 开关，不能把隐藏保存栏当作保存成功。

## 悬浮球

错误态不再绘制双 X，使用温和平静的短眼形；保留微笑、拖拽、展开及建议/大纲能力。表情调整不等于忽略实际错误，状态说明仍须可见。

拖动、调整大小和指针光泽按动画帧合并更新，同一轮计算复用主界面的安全边界。普通平移使用 `transform`，内部尺寸不变时不重复更新材质几何与滚动渐隐；磨砂、通透、液态、冰晶、哑光的配色、滤镜和表情保持原样。松手应用最后坐标并保存位置，失焦、指针取消或丢失捕获时释放拖动状态；拖动期间延后回答扫描及内容重绘，避免替换捕获指针的标题节点。

入口为 `assets/inject/floating-panel/core/appearance.js`、`geometry.js`、`interaction.js`、`views.js` 与 `runtime/state.js` / `lifecycle.js`。改变需要更新的注入行为时检查脚本版本，避免旧实例继续使用旧样式。

## 管理器市场布局

脚本市场的标题与安装状态分别布局，状态标签不收缩、不拆行，长标题和标签可换行。列表在窄窗口中改为分行展示；皮肤市场的操作区允许换行，长名称、版本和状态截断时保留悬停提示。共享 `Badge`、`Button` 组件保留 `badge`、`button` 类名，供市场角标定位和操作区布局使用。

入口为 `apps/codex-plus-manager/src/App.tsx`、`styles.css` 与 `components/ui/`。

## 功能归属与验证

会话导出、Stepwise、大纲、插件市场等大部分能力源自上游；这里记录个人版的兼容和交互差异，不将上游能力都列作个人原创。

验证：前端 `session-delete-flow.test.ts`、`floating-panel-interaction.test.ts`，Rust `crates/codex-plus-core/tests/floating_panel_*.rs` / `cdp_bridge.rs`。同时检查市场卡片与列表的窄窗口布局，以及悬浮窗各材质、拖动、缩放、吸附和展开收起效果。
