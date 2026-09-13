#!/usr/bin/env pwsh
<#
.SYNOPSIS
    发布 Codex3N：校验 → 推送 personal → 打标签 → 创建 GitHub Release。

.DESCRIPTION
    这个脚本存在的原因是几个踩过的坑：
      * 本仓库同时有 origin 与 upstream 两个远端，`gh` 会优先解析到上游
        BigPizzaV3/CodexPlusPlus。所以所有 gh 调用都写死 --repo，
        不依赖"当前目录解析出来的仓库"。
      * 标签必须与 Cargo.toml 的 [workspace.package].version 一致：安装包显示的
        版本来自标签（NSIS /DVERSION、DMG CFBundleShortVersionString），而自更新
        的基准版本来自 Cargo.toml（CARGO_PKG_VERSION），两者分叉就会出现
        "装完还提示有新版"或者反过来测不到更新。
      * release workflow 里有测试门禁，这里在本地先跑同一套检查，避免推送完才发现
        CI 会红。

.PARAMETER NotesFile
    Release 说明文件（UTF-8，真实换行）。不传则用默认的一段说明。

.PARAMETER SkipChecks
    跳过本地测试（只在明确知道 CI 会覆盖时使用）。

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

if (-not $SkipChecks) {
    Invoke-Step "cargo fmt --all --check" { cargo fmt --all --check }
    Invoke-Step "npm test" { Push-Location $ManagerDir; try { npm test } finally { Pop-Location } }
    Invoke-Step "npm run check" { Push-Location $ManagerDir; try { npm run check } finally { Pop-Location } }
    Invoke-Step "npm run vite:build" { Push-Location $ManagerDir; try { npm run vite:build } finally { Pop-Location } }
    Invoke-Step "cargo check --workspace" { cargo check --workspace }
    Invoke-Step "cargo test --workspace" { cargo test --workspace }
}

Invoke-Step "推送 $Branch" { git push origin $Branch }
Invoke-Step "创建标签 $tag" { git tag -a $tag -m "Codex3N $version" }
Invoke-Step "推送标签 $tag" { git push origin $tag }

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
