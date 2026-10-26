# Codex3N 维护流程

本文件说明同步、验证、数据恢复与发布步骤。模块职责和当前代码入口见[运行实现](runtime.md)及[业务导航](README.md)。

## 1. 同步前准备

- 确认工作区改动有归属并已妥善保存。记录原 `personal` 提交、上次已验证的上游提交、目标上游提交/版本和实际宿主 Codex 版本。
- 共同祖先只辅助确定差异；cherry-pick、部分迁移和未验证合并单独标记，不能当作完整同步基线。
- 比较基线到目标上游的完整变化，再与个人差异对照。覆盖新增、删除、重命名、弃用、安全修复、依赖/锁文件和构建工作流，不只看冲突文件或发布说明。
- 按根 AGENTS.md 的检查命令建立测试基线，记录既有失败，后续与新失败区分。

## 2. 合并与重构迁移

`main` 仅快进同步 `upstream/main`。大版本或涉及重构时从 `personal` 创建 `codex/sync-<版本或提交>`，在同步分支执行 `git merge --no-commit --no-ff main`，先审查再提交。用户指定官方正式版时，将合并目标替换为对应 Release 标签，不额外引入 `main` 上未发布的提交。普通同步也要执行以下检查：

1. 按业务文档的入口映射处理重叠变化。上游仍向 `App.tsx`、`commands.rs` 或旧注入位置写入的行为，应迁到个人版当前模块，新调用者也须接入同一入口。
2. 对重叠变化记录沿用、迁移、已覆盖或暂缓的依据。检查上游删除及安全修复是否也在个人模块生效，不能为保留功能恢复旧缺陷。
3. 搜索旧实现并追踪实际调用，检查重复监听、定时器、分页查询、页面加载和注入注册。若上游架构更合适，先调整归属与映射，再移除被替代路径。
4. 核对 RPC 客户端、模型目录、配置分片、会话索引、路径、前端布局及宿主兼容性；具体契约以业务文档和代码为准。

重构时就在对应业务文档维护下列映射，不等到上游合并时才补记：

| 上游旧文件/符号 | 当前模块/符号 | 唯一调用或注册入口 | 保留的行为契约 | 回归测试 |
| --- | --- | --- | --- | --- |
| 按实际重构填写 | 当前运行位置 | 谁调用、何时注册 | 输入输出及生命周期 | 可复现的行为检查 |

### 结构分叉的代价

对上游文件的任何拆分都是**永久成本**：上游改原文件、个人版改拆出来的新文件，Git 无法自动对位，只能手工搬运。所以拆分前先量上游在该区域的改动频率——`git log --since=<一年前> upstream/main -- <上游原文件> | wc -l`——再和本地收益比较，不要按「文件看起来大不大」决定。

已量化的结论（统计区间 2026-01-01 起，截至 2026-09-30）：

| 上游文件 | 近一年改动 | 平均规模 | 个人版现状 |
| --- | --- | --- | --- |
| `apps/codex-plus-manager/src/App.tsx` | 217 次（约每 1.7 天一次） | — | 部分拆分（screens、components/providers、provider-types） |
| `assets/inject/renderer-inject.js` | 22 次 | 543 行/次 | 沿用上游 manifest 分片，生成单文件产物 |
| `assets/inject/floating-panel/**` | 上游本就是分片 | — | 沿用上游分片，结构一致 |

由此得出的边界：

- **不要再拆 `App.tsx`**。它是上游改动最频繁的文件，拆走哪一块，上游改那一块时就要手工迁移。已有拆分中划算的是上游低频区（`screens/*`、`commands/dream_skin.rs`、`commands/provider_import.rs`），不划算的是高频区（编辑器、类型定义）。
- `RelayProfile`、`BackendSettings` 等类型已从 `App.tsx` 移到 `provider-types.ts`（上游原始定义在 `App.tsx` 内），上游再改这些定义就会冲突。这是既成成本，不要再扩大外移范围。
- renderer 注入脚本按上游 `assets/inject/renderer-inject/manifest.json` 维护分片，`scripts/assemble-renderer-inject.mjs` 生成单文件产物。同步时沿用这份清单与边界；分片可能跨函数或模板，须按完整产物判断作用域。
- 上游高频改动区的个人行为，优先写进上游同一文件，让它随三方合并走，而不是搬到新文件。

旧入口作为迁移依据，不列为当前实现。合并未提交时可用 `git merge --abort` 放弃；合回 `personal` 时保留上游合并祖先，不 squash 整次同步，也不强制重置共享历史。

## 3. 数据迁移与恢复

仅在涉及配置、数据库、索引或备份格式变化时执行：

- 使用副本验证旧数据升级、重复启动、迁移中断和失败恢复；活动数据库使用一致性备份方式，不只复制主文件。
- 区分可重建缓存与用户配置、凭据、会话，不能通过清空用户目录绕过兼容问题。
- 明确新格式能否被旧版本读取，不能承诺未经验证的降级；记录备份恢复或前向修复步骤。Git 提交恢复点不能代替数据恢复点。
- 不在唯一一份用户数据上试验，记录和日志不包含密钥或会话正文。

## 4. 验证与合回

在仓库根目录执行：

```sh
cargo fmt --check
cargo check --workspace
cargo test --workspace
```

在 `apps/codex-plus-manager` 执行 `npm test` 和 `npm run check`。CI 用 `npm ci` 和仓库锁文件安装前端依赖。

- 回归同时覆盖上游修复场景与个人功能。异步、轮询和注入重载验证调用次数、销毁及旧响应隔离；文本搜索不能代替行为测试。
- 平台相关改动分别核对 Windows、macOS、Linux 的路径、进程、安装与 UI；mock 验证不代表原生环境实测。
- 核对实际运行的构建、注入产物、宿主版本和个人更新源，避免缓存或旧进程掩盖结果。打包变化还需检查产物来源和升级路径。
- 记录既有失败、新失败及未验证范围。检查未完成不标记为完整通过；同步分支验证完成后才合回 `personal`。官方发布大版本不等于个人版已兼容。

### 本地构建占用

开发和测试保留完整调试信息与增量编译。桌面管理器只生成供可执行入口调用的 `rlib`；如增加移动端客户端，需另行配置其原生库产物。

本地使用 `cargo local-build`、`cargo local-check`、`cargo local-test`，管理器使用 `npm run test:local`：最多同时运行两个 Cargo 编译任务、两个 Rust 测试线程或两个前端测试文件。GitHub Actions 仍使用原有 `cargo build/check/test`、`npm test`，不受这些本地入口限制。局部 Rust 测试使用 `cargo test -p <包> -j 2 <过滤条件> -- --test-threads=2`。本地重任务顺序运行；这些参数限制任务并发，不是整个进程树的 CPU 百分比上限。

`sherpa-onnx-sys` 在桌面 debug 构建中以 `static:-bundle` 引用 `target/sherpa-onnx-prebuilt` 的原生库，最终链接仍为静态链接；release 沿用打包静态库的方式。构建脚本跟踪全部必需静态库，缓存缺文件或含空文件时从已有压缩包重新解压，没有压缩包时下载。`SHERPA_ONNX_LIB_DIR` 指定的外部目录只校验，错误会列出文件路径。

删除整个 `target` 后，下一次构建会重新下载并编译；只清理 `target/debug` 可保留原生库下载缓存和 release 产物。日常保持同一工具链和构建参数，使用自动管理的原生库路径，避免临时切换环境变量产生额外构建组合。缓存修复回归在 `cargo check --workspace` 后执行 `node --test scripts/sherpa-cache.test.mjs`，测试只操作临时目录；平台模拟不代表真实跨平台链接已经验证。

2026-10-17 Windows 验证：格式、workspace 编译及测试通过（2,503 通过、11 忽略）；前端测试 866 通过、1 跳过，类型检查和 Vite 构建通过。缓存回归 10 项通过，真实原生调用完成 48 kHz 到 16 kHz 的重采样，独立状态目录下的管理器创建窗口成功。首次启动探针与已有 helper 端口冲突，独立状态文件改用未运行的调试端口后完成验证。清理旧开发产物并完成检查后，`target/debug` 从 Cargo 报告的 121.6 GiB 降至文件大小合计约 22.1 GiB，整个 `target` 约 25.2 GiB；差值包含历史缓存清理。`sherpa-onnx-sys` 的开发 `rlib` 约 321 KiB，保留原生库缓存约 1.1 GiB。macOS、Linux 的真实链接与启动尚未验证。

### Windows 与跨平台门禁

`pr-build.yml` 的 `windows-artifacts` job 执行完整前端、Rust 和安全门禁，并构建 NSIS 安装包；独立并行的 `rust-lint` job 在 Windows 上只跑 `cargo fmt`、`cargo check` 与 relay clippy，把编译类失败提前到 2～3 分钟暴露，它不设 `needs`，产包 job 不等它。Ubuntu、macOS job 执行共享前端测试，macOS universal job 编译 x64/arm64 并合并为通用 DMG。job 所在系统只表示测试宿主：Windows 上的 `macos-dmg.test.ts` 是磁盘命令模拟，不能据此认定 Windows 安装包或真实 macOS 挂载已验证。

- CI 的耗时几乎全在 Rust 编译：依赖编译由 `Swatinem/rust-cache` 复用，`cargo-audit` 改用 `taiki-e/install-action` 装预编译二进制（`cargo install` 每次从源码编译约 6 分钟），CI 不再重复 `cargo check`（`cargo test --workspace` 已编译全部目标；本地仍按上面的步骤保留 check）。`release-assets.yml` 的 `verify-tests` 与两个产包 job 同样加了 rust-cache，并把源码编译的 cargo-audit 换掉。同一 ref 的新 push 会取消未结束的旧 run，`personal` 和 `main` 除外：发布脚本要求标签提交的那次 push CI 成功，取消会让它永远等不到结果。

- rust-cache 清理 `target` 时会移除 `sherpa-onnx-prebuilt` 中的原生静态库，但可能保留空目录和 `sherpa-onnx-sys` 的链接记录。CI 与发布的每个 Rust job 在恢复缓存后删除该原生库目录，并执行 `cargo clean -p sherpa-onnx-sys`（含 release），让其构建脚本重新准备原生库；macOS 还清理 x64、arm64 目标记录，其余依赖继续复用。

- 本地使用 PowerShell 7、CI 同一主版本的 Node 22（直接运行 TypeScript 测试要求至少 22.18）及 Git for Windows Bash。用 `node --version`、`where.exe node.exe`、`where.exe bash.exe` 核对实际程序；测试选取 Git 目录内的 Bash，系统的 WSL `bash.exe` 不能代替它。非默认 Git 安装路径可在当前进程将其 `usr/bin` 加入 `PATH`。
- 先 `npm ci`，再执行测试、类型检查、安全审计和 `npm run vite:build`；Tauri 编译依赖前端产物，完成后才运行 Rust 门禁。保留完整输出，并在每条原生命令后立即记录 `$LASTEXITCODE`；只看到局部 `test result: ok` 不能证明整个 workspace 通过。
- 排查时记录 run URL、提交 SHA、job、失败 step 和失败测试名。修复后验证同一提交的所有必需 job，区分测试失败、编译失败、打包失败和安装运行问题。

| 表现 | 检查与维护方式 |
| --- | --- |
| Bash 退出 0，但无最终路径、trace 停在 attach/detach | 将待执行脚本写成 LF 文件，作为 Bash 参数传入，并隔离 stdin；子命令可能读取标准输入，吞掉余下脚本。 |
| 模拟卸载后仍显示挂载，或重试计数不变 | 命令替换在子 shell 运行，模拟状态用临时文件跨调用保存；同时覆盖真实流程的直接打包回退与最终输出大小。 |
| 源码断言通过，宿主却报未定义变量或函数 | 校验完整注入产物的主作用域，并执行真实函数；测试使用真实状态声明，不自行补出生产代码缺失的变量，也不在注释中复制断言字符串。 |
| 脚本在不同 checkout 中行为不同 | 按 `.gitattributes` 保持 `.sh`、注入 JS 和 workflow 为 LF，普通 `.bat`、`.cmd`、`.ps1` 为 CRLF；`assets/claude-localization/*.ps1` 是内嵌资产，用 `-text` 保持上游原始编码与换行。路径作为独立参数传递，回归覆盖空格和中文目录。 |
| 模型元数据断言与混合目录冲突 | 按 slug 找目标条目，同时验证原生模型仍在目录；先核对业务契约，再调整测试定位。 |
| 上游供应商切换用例报总开关关闭 | 个人版默认关闭 `relayProfilesEnabled`；测试真实切换时显式开启，关闭场景则断言拒绝及 live 文件保持原样。 |

新增平台功能或同步重叠模块时，把实际入口、环境约束和回归用例一起更新到对应业务文档。跨平台模拟通过仍不能代替各平台的安装、升级及宿主运行实测。

## 5. 同步记录与文档

同步提交说明或 PR 记录四项（不在 `docs/reports` 另建个人同步报告），长期事实更新对应业务文档：

- 原个人提交、已验证基线、目标上游提交/版本与宿主版本。
- 入口映射、重叠变化的处理位置、暂缓项及原因。
- 检查命令与结果、平台、实际产物、最终验证提交。
- 数据恢复依据和遗留限制。

文档按业务归类，修改功能时更新入口和契约，删除过时说明；导航页不堆积历史日志。这套规则依赖审查与测试落实，不是自动化语义冲突检测。

管理器文案或模块移动后，同步 `src/i18n-en.ts` 与 `tools/i18n-verify.mjs` 的 `SRC_FILES`；`npm test` 在行为测试后检查真实翻译调用，二者都成功才算完成。模板翻译保留占位参数，移除失效词条。

## 6. 发布

- 从 Git 和 `Cargo.toml` 读取实际分支与版本，不在文档固定“当前版本”。版本为“上游版本 + `-3n.N`”，标签为对应的 `v<版本>`，仅发布 `personal` 对应标签。
- 改完 `Cargo.toml` 版本先跑一次 `cargo check --workspace`（或任意 cargo 构建）让 `Cargo.lock` 跟上工作区成员的新版本号，再把锁文件和版本一起提交；否则发布脚本里的构建会就地改锁文件，标签指向的提交会留下过期锁版本。发布工作流不带 `--locked`，因此只影响版本一致性，不会让安装包构建失败。
- 提交并推送 `personal`，等待该 SHA 的 `Codex3N CI artifacts` 所有 job 成功。准备 UTF-8 说明文件，使用真实换行，放在仓库外的临时目录，发布后以 GitHub Release 为准，不提交到仓库；统一执行 `pwsh scripts/release.ps1 -NotesFile <说明文件>`。
- 脚本校验分支、工作区、标签，查询个人仓库中该 SHA 最新一次 push CI，并运行本地门禁；检查后再次确认工作区干净，再原子推送分支与标签并创建 Release。CI 缺失、运行中、失败或查询异常都会在打标签前停止。`.github/workflows/release-assets.yml` 仍保留独立测试门禁和标签版本校验。
- 同一 SHA 已通过完整 CI 时，可以添加 `-SkipChecks` 复用结果，省去重复本地检查。该参数仍须通过远端 CI 校验；有任何新提交就重新验证。
- 所有 GitHub 操作显式指定 `--repo nk33-dev/Codex3N`。`pushurl = DISABLED` 只限制 Git 推送，不能防止 `gh` 误操作上游。同步时保持个人更新源。
- 发布工作流修复后，可从已通过 CI 的 `personal` 手动执行 `release-assets.yml`，指定已有 `tag` 与所需 `platform` 补跑；构建源码仍来自目标标签。附件全部齐备后才生成 `latest.json` 与校验和。
- 失败不得继续发布。Release 创建成功后默认结束，不轮询构建；“Release 已创建”“安装包构建成功”“安装运行已验证”分别报告。

### 官方 v1.10.0 同步

同步起点为 `4fd431aa`，官方标签对应 `85f9117`。上游改写历史后，Git 共同祖先早于已同步代码；以既有同步提交的上游父提交 `1dd48eb9` 作内容比较基线，用 `merge-tree --merge-base` 合并，再保留正式标签为合并父节点。历史标签不强制覆盖。

重叠区域按当前入口合并：设置保留修订号、未知字段及个人密钥加密；供应商类型和默认值迁入 `provider-types.ts` 与 `lib/default-settings.ts`；会话修复挂在现有维护区，保留项目删除；原生 Fast 取代旧服务模式控件；注入扫描保留个人调度，增加官方受管会话连接；更新进度继续经过个人版校验和与降级检查。保持个人更新源及无广告入口。

同步分支的编译、前端检查与回归完成后才合回 `personal`，平台实测范围随最终发布验证记录。

2026-10-18 Windows 同步验证：`cargo test --workspace -j 2 --no-fail-fast -- --test-threads=2` 共 2,739 通过、24 忽略；`cargo local-check`、格式检查通过。Node 22.23.3 下 `npm run test:local` 共 952 通过、1 跳过，TypeScript、Vite 构建、npm 高危审计及 cargo audit 通过。配置专项覆盖备份、一次性导入、SQLite WAL、旧快照冲突、未知字段、程序文件替换及删除配置后默认值。干净克隆已完成 `npm ci` 与 `npm run vite:build`。浏览器预览使用真实弹窗代码与模拟模型数据，不能代替客户端模型调用实测。macOS、Linux 原生启动与安装升级未在本机验证。

### 官方 v1.12.1 同步

个人起点为 `2add075b`，现有工作区先保存为 `a5c96e36`；已验证上游基线为 `85f9117f`，目标 `upstream/main` 与 v1.12.1 均为 `ca1b212d`。在 `codex/sync-1.12.1` 保留上游合并父节点，`main` 仅快进。宿主为 Windows 官方 App 26.1013.3656.0。

入口映射维护在 [runtime.md](runtime.md#配置和安装维护)：常驻 helper 接入现有恢复服务，设置迁入共用类型与默认值，会话页统一使用 `ProjectSessionPage`，旁支保存、回退及菜单修复接入个人扫描调度。保留手动保存、供应商默认关闭、加密与修订号、公开字段白名单、个人更新源和分离文件备份保护。Grok、微信跟随上游 App 入口，旧独立文件移除。

Windows 本地格式、`cargo local-check`、relay Clippy、`cargo local-build` 通过；workspace 测试 3,149 通过、25 忽略，随后模型目录专项 21 项通过，包含补充的两个上游用例。Node 22.23.3 下前端 1,081 通过、1 跳过，类型检查、Vite 构建、两套注入一致性及缓存回归 10 项通过。npm 审计无漏洞；Rust 审计消除 6 项阻断漏洞，仍有 9 项允许的维护/健全性告警。所有原始检查日志保存在系统临时目录 `codex3n-sync-20261026`。

Edge 隔离回归覆盖后端重连、键盘焦点、提示词问答、收藏筛选与正文按需读取，包含 400 px 窄窗口。管理器 debug 产物复制到临时目录，以独立配置和空 `CODEX_HOME` 最小化启动，未附加或启动官方 App，检查后结束测试进程。数据保护仅操作临时副本，覆盖侧栏改名后的搜索缓存、旧分离文件保留及 Windows 主密钥路径迁移冲突。macOS/Linux 的真实安装升级、宿主调用和 Computer Use 授权未在本机验证；跨平台编译与产包以最终提交的 CI 为准，Release 创建前必须全部成功。
