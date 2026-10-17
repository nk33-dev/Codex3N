# sherpa-onnx-sys 本地依赖补丁

来源：crates.io `sherpa-onnx-sys 1.13.8`，上游提交 `11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf`。
保留原 Apache-2.0 许可证、FFI 与原生库准备流程。

唯一依赖改动：构建时使用的 `zip` 从 2.x 升至 9.0.4，开启 stored/deflate 支持，
用于 iOS XCFramework ZIP；其他平台继续使用原有 tar.bz2 预编译包。
此改动修复 RUSTSEC-2026-0367、RUSTSEC-2026-0368、RUSTSEC-2026-0369。

上游 crate 发布包含该依赖升级的版本后，更新 sherpa-onnx 并移除根清单的 patch 及本目录。
