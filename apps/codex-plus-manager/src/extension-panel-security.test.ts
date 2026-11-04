import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

test("拓展面板使用独立协议，主窗口继续拒绝内联脚本与任意 frame", () => {
  const config = JSON.parse(read("../src-tauri/tauri.conf.json"));
  for (const policy of [config.app.security.csp, config.app.security.devCsp]) {
    const directives = new Map<string, string[]>(policy.split(";").map((item: string) => {
      const [name, ...sources] = item.trim().split(/\s+/);
      return [name, sources];
    }));
    assert.deepEqual(directives.get("script-src"), ["'self'"]);
    assert.deepEqual(directives.get("frame-src"), ["codex3n-panel:", "http://codex3n-panel.localhost"]);
  }
  const panel = read("./ExtensionManagerPanel.tsx");
  assert.match(panel, /sandbox="allow-scripts allow-forms"/);
  assert.match(panel, /src=\{panelUrl\}/);
  assert.doesNotMatch(panel, /srcDoc=/);
  assert.match(panel, /if \(!target \|\| event\.source !== target/);
  assert.match(panel, /if \(cancelled\) void invoke\("release_extension_panel"/);
  assert.match(panel, /if \(token\) void invoke\("release_extension_panel"/);
  const native = read("../src-tauri/src/extension_panel.rs");
  assert.match(native, /window\.label\(\) != crate::MAIN_WINDOW_LABEL/);
  assert.match(native, /connect-src 'none'/);
  assert.match(native, /uuid::Uuid::parse_str\(token\)/);
  assert.match(read("../src-tauri/src/lib.rs"), /WindowEvent::Destroyed => \{\s*extension_panel::clear\(\)/);
});
