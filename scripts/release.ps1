#!/usr/bin/env pwsh
<#
.SYNOPSIS
    发布 Codex3N：校验 → 打标签 → 一次原子推送分支与标签 → 创建 GitHub Release。

.DESCRIPTION
    这个脚本存在的原因是几个踩过的坑：
      * 本仓库同时有 origin 与 upstream 两个远端，`gh` 会优先解析到上游
        BigPizzaV3/CodexPlusPlus。所以所有 gh 调用都写死 --repo，
        不依赖"当前目录解析出来的仓库"。
      * 标签必须与 Cargo.toml 的 [workspace.package].version 一致：安装包显示的
        版本来自标签（NSIS /DVERSION、DMG CFBundleShortVersionString），而自更新
        的基准版本来自 Cargo.toml（CARGO_PKG_VERSION），两者分叉就会出现
        "装完还提示有新版"或者反过来测不到更新。
      * 发布前要求当前提交的 CI 构建成功，并在本地运行同一套检查。

.PARAMETER NotesFile
    Release 说明文件（UTF-8，真实换行）。不传则用默认的一段说明。

.PARAMETER SkipChecks
    复用当前提交已成功的 CI 结果，省去重复的本地检查。

.PARAMETER DryRun
    只打印将要执行的命令，不做任何写操作。

.EXAMPLE
    pwsh scripts/release.ps1 -NotesFile .\notes\1.3.0-3n.3.md
#>
[CmdletBinding()]
param(
    [string]$NotesFile,
    [switch]$SkipChecks,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# 写死仓库：本仓库存在 upstream 远端，gh 默认会解析到上游仓库。
$Repo = "nk33-dev/Codex3N"
$Branch = "personal"
$ManagerDir = "apps/codex-plus-manager"

function Invoke-Step {
    param([string]$Description, [scriptblock]$Action)
    Write-Host "==> $Description" -ForegroundColor Cyan
    if ($DryRun) {
        Write-Host "    (dry-run) $($Action.ToString().Trim())" -ForegroundColor DarkGray
        return
    }
    $global:LASTEXITCODE = 0
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "$Description 执行失败，退出码：$LASTEXITCODE"
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

$root = (git rev-parse --show-toplevel).Trim()
Set-Location $root

$currentBranch = (git rev-parse --abbrev-ref HEAD).Trim()
Assert-True ($currentBranch -eq $Branch) "当前分支是 $currentBranch，发布只允许从 $Branch 进行"

$status = (git status --porcelain)
Assert-True ([string]::IsNullOrWhiteSpace($status)) "工作区有未提交的改动，先提交或 stash 再发布：`n$status"

$manifest = Get-Content -LiteralPath (Join-Path $root "Cargo.toml") -Raw
$versionMatch = [regex]::Match($manifest, '(?m)^version = "([^"]+)"')
Assert-True $versionMatch.Success "无法从 Cargo.toml 读出 [workspace.package].version"
$version = $versionMatch.Groups[1].Value
Assert-True ($version -match '-3n\.\d+$') "Cargo.toml 版本 `"$version`" 不符合 `<上游版本>-3n.N` 约定"

$tag = "v$version"
$existingLocal = (git tag --list $tag)
Assert-True ([string]::IsNullOrWhiteSpace($existingLocal)) "本地已存在标签 $tag"
$existingRemote = (git ls-remote --tags origin "refs/tags/$tag")
Assert-True ([string]::IsNullOrWhiteSpace($existingRemote)) "远端已存在标签 $tag"

$notesArgs = @()
if ($NotesFile) {
    Assert-True (Test-Path -LiteralPath $NotesFile) "找不到说明文件 $NotesFile"
    $notesArgs = @("--notes-file", (Resolve-Path -LiteralPath $NotesFile).Path)
} else {
    $notesArgs = @("--notes", "Codex3N $version")
}

Write-Host "将发布 $tag（分支 $Branch，仓库 $Repo）" -ForegroundColor Green

$head = (git rev-parse HEAD).Trim()
Invoke-Step "确认当前提交的 CI 构建通过" {
    $runJson = gh run list --repo $Repo --workflow pr-build.yml --branch $Branch --commit $head --event push --limit 1 --json headSha,status,conclusion,url
    Assert-True ($LASTEXITCODE -eq 0) "无法查询 CI，停止发布"
    $runs = @($runJson | ConvertFrom-Json)
    Assert-True ($runs.Count -eq 1) "当前提交 $head 没有 CI 记录，先推送 personal 并等待构建通过"
    $run = $runs[0]
    Assert-True ($run.headSha -eq $head -and $run.status -eq "completed" -and $run.conclusion -eq "success") "当前提交的 CI 未通过：$($run.status) / $($run.conclusion)，$($run.url)"
    Write-Host "    已通过：$($run.url)"
}

if (-not $SkipChecks) {
    Invoke-Step "cargo fmt --all --check" { cargo fmt --all --check }
    Invoke-Step "npm test" { Push-Location $ManagerDir; try { npm test } finally { Pop-Location } }
    Invoke-Step "native browser inspector bundle" { node scripts/assemble-native-browser-inspector.mjs --check }
    Invoke-Step "npm run check" { Push-Location $ManagerDir; try { npm run check } finally { Pop-Location } }
    Invoke-Step "npm audit" { Push-Location $ManagerDir; try { npm audit --audit-level=high --registry=https://registry.npmjs.org } finally { Pop-Location } }
    Invoke-Step "npm run vite:build" { Push-Location $ManagerDir; try { npm run vite:build } finally { Pop-Location } }
    Invoke-Step "cargo check --workspace" { cargo check --workspace }
    Invoke-Step "relay Clippy" { cargo clippy -p codex-plus-mobile-relay --all-targets -- -D warnings }
    Invoke-Step "cargo audit" { cargo audit }
    # --no-fail-fast：让所有测试目标都跑完再汇总，避免第一个失败目标掩盖其余结果。
    Invoke-Step "cargo test --workspace" { cargo test --workspace --no-fail-fast }
}

Invoke-Step "确认检查后工作区仍干净" {
    $status = git status --porcelain
    Assert-True ([string]::IsNullOrWhiteSpace($status)) "检查产生了未提交改动，请提交后重新验证：`n$status"
}

Invoke-Step "创建标签 $tag" { git tag -a $tag -m "Codex3N $version" }
Invoke-Step "原子推送 $Branch 与 $tag" { git push --atomic origin "refs/heads/$Branch" "refs/tags/$tag" }

$releaseArgs = @(
    "release", "create", $tag,
    "--repo", $Repo,
    "--title", "Codex3N $version",
    "--verify-tag"
) + $notesArgs

Invoke-Step "创建 GitHub Release" { & gh @releaseArgs }

if (-not $DryRun) {
    Write-Host "发布完成：https://github.com/$Repo/releases/tag/$tag" -ForegroundColor Green
    Write-Host "release workflow 会自动构建安装包，不需要在这里等。" -ForegroundColor DarkGray
}
