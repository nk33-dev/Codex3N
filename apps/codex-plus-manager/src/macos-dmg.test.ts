import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const source = await readFile(new URL("../../../scripts/installer/macos/package-dmg.sh", import.meta.url), "utf8");
const start = source.indexOf('DMG_WORK_DIR="$(mktemp');
assert.ok(start >= 0, "the real DMG lifecycle must be exercised");
const gitExecutable = process.platform === "win32"
  ? spawnSync("where.exe", ["git.exe"], { encoding: "utf8" }).stdout.split(/\r?\n/).find((path) => /\\(?:cmd|bin)\\git\.exe$/i.test(path))
  : undefined;
const bash = process.platform === "win32"
  ? spawnSync("where.exe", ["bash.exe"], { encoding: "utf8" }).stdout
      .split(/\r?\n/)
      .find((path) => /\\Git\\(?:usr\\)?bin\\bash\.exe$/i.test(path))
      ?? (gitExecutable && [join(dirname(dirname(gitExecutable)), "bin", "bash.exe"), join(dirname(dirname(gitExecutable)), "usr", "bin", "bash.exe")].find(existsSync))
      ?? join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe")
  : "/bin/bash";

// 执行真实打包流程，只替换磁盘命令，不挂载实际镜像。
const fixture = `
set -euo pipefail
DMG="out/final.dmg"
DIST="out"
STAGE="stage"
CONVERT_CALLS=0
OUTPUT_WAITS=0
printf '1\\n' > attached.state
printf '0\\n' > detach.state
mktemp() { printf '%s\\n' "work"; }
sleep() {
  if [ "$SCENARIO" = delayed-output ] && [ "$CONVERT_CALLS" -gt 0 ]; then
    OUTPUT_WAITS=$((OUTPUT_WAITS + 1))
    if [ "$OUTPUT_WAITS" -eq 2 ]; then printf 'compressed image' > "$DMG"; fi
  fi
  return 0
}
rm() { :; }
rmdir() { :; }
osascript() { cat >/dev/null; }
lsof() { return 1; }
pgrep() { return 1; }
hdiutil() {
  printf '%s\\n' "$*" >> trace.log
  case "$1" in
    create)
      case " $* " in
        *" -format UDZO "*)
          case "$SCENARIO" in
            fail-convert|busy-create-fails|info-error-create-fails) return 1 ;;
          esac
          printf 'compressed image' > "$DMG"
          ;;
        *) printf 'writable image' > "$DMG_WORK_PATH" ;;
      esac
      ;;
    attach)
      case "$SCENARIO" in
        no-device) printf 'Apple_HFS\\t/Volumes/fixture\\n' ;;
        no-volume) printf '/dev/disk4\\tApple_HFS\\n' ;;
        *) printf '/dev/disk4\\tApple_HFS\\t/Volumes/fixture\\n' ;;
      esac
      ;;
    detach)
      # detach 在命令替换的子 shell 中运行，状态须写文件才能供下一次 info 读取。
      read -r DETACH_CALLS < detach.state
      DETACH_CALLS=$((DETACH_CALLS + 1))
      printf '%s\\n' "$DETACH_CALLS" > detach.state
      case "$SCENARIO" in
        busy|busy-create-fails|info-error|info-error-create-fails) return 1 ;;
        delayed) if [ "$DETACH_CALLS" -eq 1 ]; then return 1; fi ;;
        force-only) if [ "\${3:-}" != -force ]; then return 1; fi ;;
        already-gone) printf '0\\n' > attached.state; return 1 ;;
      esac
      printf '0\\n' > attached.state
      ;;
    info)
      case "$SCENARIO" in info-error|info-error-create-fails) return 1 ;; esac
      read -r ATTACHED < attached.state
      if [ "$ATTACHED" -eq 1 ]; then
        printf 'image-path : %s\\n/dev/disk4\\tApple_HFS\\n' "$DMG_WORK_PATH"
      fi
      printf 'image-path : work/another.dmg\\n'
      printf '/dev/disk40\\tApple_HFS\\n'
      ;;
    convert)
      CONVERT_CALLS=$((CONVERT_CALLS + 1))
      read -r ATTACHED < attached.state
      if [ "$ATTACHED" -ne 0 ]; then return 1; fi
      case "$SCENARIO" in
        fail-convert|fallback-convert) return 1 ;;
        missing-output|delayed-output) return 0 ;;
        empty-output) : > "$DMG"; return 0 ;;
        retry-convert) if [ "$CONVERT_CALLS" -lt 3 ]; then return 1; fi ;;
        late-convert) if [ "$CONVERT_CALLS" -lt 7 ]; then return 1; fi ;;
      esac
      printf 'compressed image' > "$DMG"
      ;;
    *) return 99 ;;
  esac
}
`;

async function runScenario(scenario: string) {
  const parent = resolve(tmpdir());
  const dir = await mkdtemp(join(parent, "cpp dmg 回归-"));
  try {
    await mkdir(join(dir, "work"));
    await mkdir(join(dir, "out"));
    // 子命令会读取标准输入；脚本写入文件，避免剩余代码被读走。
    await writeFile(join(dir, "scenario.sh"), `${fixture}\n${source.slice(start)}`.replace(/\r\n/g, "\n"));
    const result = spawnSync(bash, ["--noprofile", "--norc", "scenario.sh"], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, BASH_ENV: "", SCENARIO: scenario },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, result.stderr);
    const trace = await readFile(join(dir, "trace.log"), "utf8");
    const output = await readFile(join(dir, "out", "final.dmg")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return { ...result, trace, output };
  } finally {
    assert.equal(dirname(resolve(dir)), parent);
    await rm(dir, { recursive: true, force: true });
  }
}

for (const scenario of ["success", "retry-convert", "late-convert", "delayed-output", "delayed", "already-gone", "force-only"]) {
  test(`DMG packaging succeeds after ${scenario}`, async () => {
    const result = await runScenario(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /out\/final\.dmg/);
    assert.equal(result.output?.toString(), "compressed image");
    assert.match(result.trace, /detach \/dev\/disk4(?:\n| )/);
    assert.doesNotMatch(result.trace, /create .* -format UDZO /);
    if (scenario === "retry-convert") {
      assert.equal(result.trace.match(/^convert /gm)?.length, 3);
    }
    if (scenario === "late-convert") {
      assert.equal(result.trace.match(/^convert /gm)?.length, 7);
    }
    if (scenario === "delayed-output") {
      assert.equal(result.trace.match(/^convert /gm)?.length, 1);
    }
    if (scenario === "delayed" || scenario === "force-only") {
      assert.equal(result.trace.match(/^detach /gm)?.length, 2);
      assert.match(result.trace, /detach \/dev\/disk4 -force/);
    }
  });
}

for (const scenario of ["no-device", "no-volume"]) {
  test(`DMG packaging cleans up failed attach parsing: ${scenario}`, async () => {
    const result = await runScenario(scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /failed to find mounted DMG device and volume/);
    assert.doesNotMatch(result.trace, /^convert /m);
    if (scenario === "no-device") {
      // 只有挂载点可清理（无设备），detach 一次即成功。
      assert.equal(result.trace.match(/^detach \/Volumes\/fixture$/gm)?.length, 1);
    } else {
      assert.match(result.trace, /detach \/dev\/disk4/);
    }
  });
}

for (const scenario of ["fail-convert", "missing-output", "empty-output"]) {
  test(`DMG packaging rejects ${scenario} instead of reporting create success`, async () => {
    const result = await runScenario(scenario);
    assert.equal(result.status, 1, result.stderr);
    if (scenario === "fail-convert") {
      assert.match(result.stderr, /failed to create DMG after 12 attempts/);
      assert.equal(result.trace.match(/^convert /gm)?.length, 12);
      assert.equal(result.trace.match(/^create .* -format UDZO /gm)?.length, 5);
    } else {
      assert.match(result.stderr, /DMG output is missing or empty after conversion/);
      assert.equal(result.trace.match(/^convert /gm)?.length, 1);
    }
    assert.doesNotMatch(result.stdout, /out\/final\.dmg/);
  });
}

for (const scenario of ["busy", "info-error", "fallback-convert"]) {
  test(`DMG packaging falls back to direct create after ${scenario}`, async () => {
    const result = await runScenario(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /out\/final\.dmg/);
    assert.equal(result.output?.toString(), "compressed image");
    assert.match(result.stderr, /退回直接打包/);
    assert.equal(result.trace.match(/^create .* -format UDZO /gm)?.length, 1);
    if (scenario === "fallback-convert") {
      assert.equal(result.trace.match(/^convert /gm)?.length, 12);
    } else {
      assert.doesNotMatch(result.trace, /^convert /m);
    }
  });
}

for (const scenario of ["busy-create-fails", "info-error-create-fails"]) {
  test(`DMG packaging fails when both detach and direct create fail: ${scenario}`, async () => {
    const result = await runScenario(scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.trace, /^convert /m);
    assert.equal(result.trace.match(/^create .* -format UDZO /gm)?.length, 5);
    assert.match(result.stderr, /failed to create DMG/);
    assert.doesNotMatch(result.stdout, /out\/final\.dmg/);
  });
}
