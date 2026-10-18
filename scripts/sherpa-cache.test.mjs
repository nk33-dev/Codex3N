import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const buildRoot = path.join(root, "target/debug/build");
const executable = process.platform === "win32" ? "build-script-build.exe" : "build-script-build";
const buildScript = readdirSync(buildRoot)
  .filter((name) => name.startsWith("sherpa-onnx-sys-"))
  .map((name) => path.join(buildRoot, name, executable))
  .filter(existsSync)
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
assert.ok(buildScript, "先执行 cargo check --workspace，生成语音库构建脚本");

const libraries = ["sherpa-onnx-c-api", "sherpa-onnx-core", "kaldi-decoder-core", "sherpa-onnx-kaldifst-core",
  "sherpa-onnx-fstfar", "sherpa-onnx-fst", "kaldi-native-fbank-core", "kissfft-float", "piper_phonemize",
  "espeak-ng", "ucd", "onnxruntime", "ssentencepiece_core"];

function fixture(t, os = "windows") {
  const directory = mkdtempSync(path.join(tmpdir(), "codex-sherpa-cache-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const platform = { windows: "win-x64-static-MT-Release", linux: "linux-x64-static", macos: "osx-x64-static" }[os];
  const stem = `sherpa-onnx-v1.13.8-${platform}-lib`;
  const cache = path.join(directory, "target/sherpa-onnx-prebuilt");
  const lib = path.join(cache, stem, "lib");
  const archiveSource = path.join(directory, "archives");
  const filename = (name) => os === "windows" ? `${name}.lib` : `lib${name}.a`;
  const env = { ...process.env, CARGO_CFG_TARGET_OS: os, CARGO_CFG_TARGET_ARCH: "x86_64",
    CARGO_FEATURE_STATIC: "1", PROFILE: "debug", TARGET: `${os}-x86_64`,
    CARGO_TARGET_DIR: path.join(directory, "target"),
    OUT_DIR: path.join(directory, "target/debug/build/fixture/out"),
    HTTP_PROXY: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", ALL_PROXY: "http://127.0.0.1:1", NO_PROXY: "",
  };
  for (const key of ["DOCS_RS", "CARGO_FEATURE_SHARED", "SHERPA_ONNX_LIB_DIR", "SHERPA_ONNX_ARCHIVE_DIR",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) delete env[key];
  const populate = (destination) => {
    mkdirSync(destination, { recursive: true });
    for (const name of libraries) writeFileSync(path.join(destination, filename(name)), "native fixture");
  };
  function archive() {
    const staging = path.join(directory, "staging");
    populate(path.join(staging, stem, "lib"));
    mkdirSync(archiveSource, { recursive: true });
    const result = spawnSync("tar", ["-cjf", path.join(archiveSource, `${stem}.tar.bz2`), "-C", staging, stem], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    env.SHERPA_ONNX_ARCHIVE_DIR = archiveSource;
  }
  const run = (extra = {}) => spawnSync(buildScript, [], { env: { ...env, ...extra }, encoding: "utf8", timeout: 15000 });
  return { directory, cache, lib, env, stem, filename, populate, archive, run };
}

for (const os of ["windows", "linux", "macos"]) {
  test(`${os} 开发构建引用完整原生库，发布构建保留打包`, (t) => {
    const f = fixture(t, os);
    f.populate(f.lib);
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /cargo:rustc-link-lib=static:-bundle=sherpa-onnx-c-api/);
    for (const name of libraries) assert.ok(result.stdout.includes(`cargo:rerun-if-changed=${path.join(f.lib, f.filename(name))}`));
    assert.doesNotMatch(result.stderr, /Downloading/);
    const release = f.run({ PROFILE: "release" });
    assert.equal(release.status, 0, release.stderr);
    assert.match(release.stdout, /cargo:rustc-link-lib=static=sherpa-onnx-c-api/);
    assert.doesNotMatch(release.stdout, /static:-bundle/);
  });
}

test("缓存全部不存在时从本地压缩包准备原生库", (t) => {
  const f = fixture(t); f.archive();
  assert.equal(existsSync(f.cache), false);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.ok(statSync(path.join(f.lib, f.filename("onnxruntime"))).size > 0);
});

for (const state of ["empty-directory", "missing-file", "empty-file"]) {
  test(`部分缓存 ${state} 自动从已有压缩包恢复`, (t) => {
    const f = fixture(t); f.archive();
    assert.equal(f.run().status, 0);
    delete f.env.SHERPA_ONNX_ARCHIVE_DIR;
    if (state === "empty-directory") {
      rmSync(f.lib, { recursive: true }); mkdirSync(f.lib);
    } else if (state === "missing-file") {
      rmSync(path.join(f.lib, f.filename("onnxruntime")));
    } else writeFileSync(path.join(f.lib, f.filename("onnxruntime")), "");
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    for (const name of libraries) assert.ok(statSync(path.join(f.lib, f.filename(name))).size > 0);
    assert.doesNotMatch(result.stderr, /Downloading/);
  });
}

test("外部库不完整时报告文件路径，保持外部目录原样", (t) => {
  const f = fixture(t);
  const external = path.join(f.directory, "external"); f.populate(external);
  const missing = path.join(external, f.filename("onnxruntime")); rmSync(missing);
  const before = readdirSync(external);
  const result = f.run({ SHERPA_ONNX_LIB_DIR: external });
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(missing));
  assert.deepEqual(readdirSync(external), before);
  assert.equal(existsSync(f.cache), false);
});

test("下载失败时明确报错，不把空目录作为有效缓存", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Failed to download sherpa-onnx archive/);
  assert.equal(existsSync(f.lib), false);
});

test("损坏的压缩包不会留下可复用的半成品", (t) => {
  const f = fixture(t);
  mkdirSync(f.cache, { recursive: true });
  const archive = path.join(f.cache, `${f.stem}.tar.bz2`);
  writeFileSync(archive, "broken archive");
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Failed to unpack cached archive/);
  assert.equal(existsSync(archive), false);
  assert.equal(existsSync(f.lib), false);
});
