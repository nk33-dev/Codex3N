import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const source = await readFile(new URL("../../../scripts/release.ps1", import.meta.url), "utf8");
const head = "1111111111111111111111111111111111111111";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function runRelease(scenario: string, skipChecks = true) {
  const parent = resolve(tmpdir());
  const dir = await mkdtemp(join(parent, "codex3n release 回归-"));
  try {
    await writeFile(join(dir, "release.ps1"), source);
    await writeFile(join(dir, "Cargo.toml"), '[workspace.package]\nversion = "1.2.3-3n.1"\n');
    const runs = scenario === "missing" ? [] : [{
      headSha: scenario === "wrong-head" ? "2222222222222222222222222222222222222222" : head,
      status: scenario === "pending" ? "in_progress" : "completed",
      conclusion: scenario === "failed" ? "failure" : scenario === "pending" ? "" : "success",
      url: "https://github.com/nk33-dev/Codex3N/actions/runs/123",
    }];
    // 在独立 PowerShell 进程中替换外部命令，断言真实发布脚本的执行顺序。
    await writeFile(join(dir, "driver.ps1"), `
$ErrorActionPreference = "Stop"
$fixtureRoot = ${quote(dir)}
$scenario = ${quote(scenario)}
$runJson = ${quote(JSON.stringify(runs))}
$checksRan = $false
function git {
    $global:LASTEXITCODE = 0
    Add-Content -LiteralPath (Join-Path $fixtureRoot "trace.log") -Value "git $args"
    switch ($args[0]) {
        "rev-parse" {
            switch ($args[1]) {
                "--show-toplevel" { return $fixtureRoot }
                "--abbrev-ref" { return "personal" }
                "HEAD" { return "${head}" }
            }
        }
        "status" {
            if ($script:checksRan -and $scenario -eq "dirty") { return " M Cargo.lock" }
        }
    }
}
function gh {
    $global:LASTEXITCODE = 0
    Add-Content -LiteralPath (Join-Path $fixtureRoot "trace.log") -Value "gh $args"
    if ($args[0] -eq "run") {
        if ($scenario -eq "query-error") { $global:LASTEXITCODE = 1; return }
        return $runJson
    }
}
function cargo {
    $script:checksRan = $true
    Add-Content -LiteralPath (Join-Path $fixtureRoot "trace.log") -Value "cargo $args"
    $global:LASTEXITCODE = $(if ($scenario -eq "local-failure") { 1 } else { 0 })
}
function npm {
    $global:LASTEXITCODE = 0
    Add-Content -LiteralPath (Join-Path $fixtureRoot "trace.log") -Value "npm $args"
}
New-Item -ItemType Directory -Force (Join-Path $fixtureRoot "apps/codex-plus-manager") | Out-Null
& (Join-Path $fixtureRoot "release.ps1") ${skipChecks ? "-SkipChecks" : ""}
`);
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", join(dir, "driver.ps1")], {
      cwd: dir,
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    const trace = await readFile(join(dir, "trace.log"), "utf8");
    return { ...result, trace };
  } finally {
    assert.equal(dirname(resolve(dir)), parent);
    await rm(dir, { recursive: true, force: true });
  }
}

for (const scenario of ["missing", "pending", "failed", "wrong-head", "query-error"]) {
  test(`发布拒绝复用不合格的 CI：${scenario}`, async () => {
    const result = await runRelease(scenario);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /CI/);
    assert.doesNotMatch(result.trace, /git tag -a|git push|gh release create/);
  });
}

test("发布复用同一提交已成功的 CI，查询显式限定个人仓库和工作流", async () => {
  const result = await runRelease("passed");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.trace, new RegExp(`gh run list --repo nk33-dev/Codex3N --workflow pr-build.yml --branch personal --commit ${head} --event push`));
  assert.doesNotMatch(result.trace, /cargo |npm /);
  assert.match(result.trace, /git tag -a v1\.2\.3-3n\.1[\s\S]*git push --atomic origin[\s\S]*gh release create v1\.2\.3-3n\.1 --repo nk33-dev\/Codex3N/);
});

for (const scenario of ["local-failure", "dirty"]) {
  test(`发布在本地检查后停止：${scenario}`, async () => {
    const result = await runRelease(scenario, false);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.trace, /cargo fmt/);
    assert.match(result.stderr, scenario === "dirty" ? /未提交改动/ : /执行失败/);
    assert.doesNotMatch(result.trace, /git tag -a|git push|gh release create/);
  });
}
