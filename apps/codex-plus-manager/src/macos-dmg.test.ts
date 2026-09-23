import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";

const source = await readFile(new URL("../../../scripts/installer/macos/package-dmg.sh", import.meta.url), "utf8");
const start = source.indexOf('DMG_WORK_DIR="$(mktemp');
assert.ok(start >= 0, "the real DMG lifecycle must be exercised");
const bash = process.platform === "win32"
  ? join(resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "..", "..", ".."), "bin", "bash.exe")
  : "/bin/bash";

// Run the actual packaging tail with synthetic disk commands, never real mounts.
const fixture = `
set -euo pipefail
DMG="out/final.dmg"
DIST="out"
STAGE="stage"
printf '1' > attached.state
CONVERT_CALLS=0
printf '0' > detach-calls.state
OUTPUT_WAITS=0
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
osascript() { if [ "\${1:-}" != -e ]; then cat >/dev/null; fi; }
hdiutil() {
  printf '%s\\n' "$*" >> trace.log
  case "$1" in
    create)
      if [[ " $* " == *" -format UDZO "* ]]; then printf 'compressed image' > "$DMG";
      else printf 'writable image' > "$DMG_WORK_PATH"; fi
      ;;
    attach)
      case "$SCENARIO" in
        no-device) printf 'Apple_HFS\\t/Volumes/fixture\\n' ;;
        no-volume) printf '/dev/disk4\\tApple_HFS\\n' ;;
        *) printf '/dev/disk4\\tApple_HFS\\t/Volumes/fixture\\n' ;;
      esac
      ;;
    detach)
      DETACH_CALLS=$(cat detach-calls.state)
      DETACH_CALLS=$((DETACH_CALLS + 1))
      printf '%s' "$DETACH_CALLS" > detach-calls.state
      case "$SCENARIO" in
        busy|info-error) return 1 ;;
        delayed|no-device) if [ "$DETACH_CALLS" -eq 1 ]; then return 1; fi ;;
        force-only) if [ "\${3:-}" != -force ]; then return 1; fi ;;
        already-gone) printf '0' > attached.state; return 1 ;;
      esac
      printf '0' > attached.state
      ;;
    info)
      if [ "$SCENARIO" = info-error ]; then return 1; fi
      if [ "$(cat attached.state)" -eq 1 ]; then printf '/dev/disk4\\tApple_HFS\\t%s\\n' "$DMG_WORK_PATH"; fi
      printf '/dev/disk40\\tApple_HFS\\n'
      ;;
    convert)
      CONVERT_CALLS=$((CONVERT_CALLS + 1))
      if [ "$(cat attached.state)" -ne 0 ]; then return 1; fi
      case "$SCENARIO" in
        fail-convert) return 1 ;;
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
  const dir = await mkdtemp(join(parent, "cpp-dmg-test-"));
  try {
    await mkdir(join(dir, "work"));
    await mkdir(join(dir, "out"));
    const result = spawnSync(bash, ["--noprofile", "--norc"], {
      cwd: dir,
      input: `${fixture}\n${source.slice(start)}`,
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, BASH_ENV: "", SCENARIO: scenario },
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

for (const scenario of ["success", "retry-convert", "late-convert", "delayed-output", "delayed", "already-gone", "force-only"]) {
  test(`DMG packaging succeeds after ${scenario}`, async () => {
    const result = await runScenario(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /out\/final\.dmg/);
    assert.match(result.trace, /detach \/dev\/disk4(?:\n| )/);
    if (scenario === "retry-convert") {
      assert.equal(result.trace.match(/^convert /gm)?.length, 3);
    }
    if (scenario === "late-convert") {
      assert.equal(result.trace.match(/^convert /gm)?.length, 5);
      assert.match(result.stderr, /退回直接打包/);
    }
    if (scenario === "delayed-output") {
      assert.equal(result.trace.match(/^convert /gm)?.length, 1);
    }
    if (scenario === "delayed") {
      assert.match(result.trace, /detach \/dev\/disk4 -force/);
    }
    if (scenario === "force-only") {
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
      assert.equal(result.trace.match(/^detach \/Volumes\/fixture$/gm)?.length, 2);
    } else {
      assert.match(result.trace, /detach \/dev\/disk4/);
    }
  });
}

test("DMG packaging falls back when layout conversion fails", async () => {
  const result = await runScenario("fail-convert");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.trace.match(/^convert /gm)?.length, 5);
  assert.match(result.stderr, /退回直接打包/);
  assert.match(result.stdout, /out\/final\.dmg/);
});

for (const scenario of ["missing-output", "empty-output"]) {
  test(`DMG packaging rejects ${scenario} instead of reporting create success`, async () => {
    const result = await runScenario(scenario);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /DMG output is missing or empty after conversion/);
    assert.equal(result.trace.match(/^convert /gm)?.length, 1);
    assert.doesNotMatch(result.stdout, /out\/final\.dmg/);
  });
}

for (const scenario of ["busy", "info-error"]) {
  test(`DMG packaging uses direct fallback when detach is ${scenario}`, async () => {
    const result = await runScenario(scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.trace, /^convert /m);
    assert.match(result.stderr, /退回直接打包/);
    assert.match(result.stdout, /out\/final\.dmg/);
  });
}
