use codex_plus_core::update::{
    ALLOW_DOWNGRADE_ENV, ALLOW_UNVERIFIED_ENV, DEFAULT_LATEST_JSON_URL, DEFAULT_REPOSITORY,
    Release, ReleaseAsset, UpdatePolicy, download_and_verify_update, download_asset_to,
    is_newer_version, normalize_sha256, parse_sha256sums, parse_version_tag,
    release_from_github_payload, release_from_latest_json_payload,
    resolve_expected_sha256_for_tests, safe_asset_name, select_update_asset,
    select_update_asset_entry, sha256_file, sibling_asset_url, verify_asset_sha256,
};
use serde_json::json;
use sha2::{Digest, Sha256};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// 测试用的固定基准版本，与 `Cargo.toml` 的真实版本**解耦**：这里只需要一个
/// 符合 `上游版本-3n.N` 形状的常量来做新旧比较，不必随每次发版同步修改。
const CURRENT_VERSION: &str = "1.3.0-3n.6";

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// 把诊断日志重定向到临时文件，避免测试写进真实的用户诊断日志。
fn redirect_diagnostic_log() {
    codex_plus_core::diagnostic_log::set_diagnostic_log_path_for_tests(Some(
        std::env::temp_dir().join("codex3n-updater-tests.log"),
    ));
}

fn release_for(version: &str, asset_name: &str, asset_url: &str) -> Release {
    Release {
        version: version.to_string(),
        url: String::new(),
        body: String::new(),
        asset_name: Some(asset_name.to_string()),
        asset_url: Some(asset_url.to_string()),
        asset_sha256: None,
        sha256sums_url: None,
    }
}

#[test]
fn parse_version_tag_accepts_prefix_and_suffix() {
    assert_eq!(parse_version_tag("v1.2.3").unwrap(), vec![1, 2, 3]);
    assert_eq!(parse_version_tag("1.2.3").unwrap(), vec![1, 2, 3]);
    assert_eq!(parse_version_tag("v1.2.3-beta.1").unwrap(), vec![1, 2, 3]);
    assert_eq!(parse_version_tag("v1.2.3-3n.4").unwrap(), vec![1, 2, 3, 4]);
}

#[test]
fn version_comparison_uses_numeric_segments() {
    assert!(is_newer_version("v1.0.10", "1.0.4").unwrap());
    assert!(is_newer_version("v1.2.56-3n.2", "1.2.56-3n.1").unwrap());
    assert!(is_newer_version("v1.2.56-3n.1", "1.2.56").unwrap());
    assert!(!is_newer_version("v1.0.4", "1.0.4").unwrap());
    assert!(!is_newer_version("v1.0.3", "1.0.4").unwrap());
}

#[test]
fn version_comparison_handles_codex3n_revisions_and_upstream_bumps() {
    // `-3n.N` 的 N 是第四段数字，用来判断个人版修订。
    assert!(is_newer_version("1.3.0-3n.7", "1.3.0-3n.6").unwrap());
    assert!(!is_newer_version("1.3.0-3n.6", "1.3.0-3n.7").unwrap());
    assert!(!is_newer_version("1.3.0-3n.7", "1.3.0-3n.7").unwrap());
    assert!(!is_newer_version("v1.2.99-3n.9", "1.3.0-3n.6").unwrap());
    // 上游大版本更高时，即使个人版修订更小也算更新。
    assert!(is_newer_version("1.4.0", "1.3.0-3n.7").unwrap());
    assert!(is_newer_version("v1.4.0-3n.1", "1.4.0").unwrap());
    assert!(!is_newer_version("v1.4.0", "1.4.0-3n.1").unwrap());
}

#[test]
fn codex3n_uses_personal_release_repository() {
    assert_eq!(DEFAULT_REPOSITORY, "nk33-dev/Codex3N");
    assert_eq!(
        DEFAULT_LATEST_JSON_URL,
        "https://github.com/nk33-dev/Codex3N/releases/latest/download/latest.json"
    );
}

#[test]
fn github_payload_selects_platform_installer() {
    let release = release_from_github_payload(&json!({
        "tag_name": "v1.0.9",
        "html_url": "https://github.com/BigPizzaV3/CodexPlusPlus/releases/tag/v1.0.9",
        "body": "fixes",
        "assets": [
            {"name": "source.zip", "browser_download_url": "https://example.test/source.zip"},
            {"name": "codex-plus-plus-manager.exe", "browser_download_url": "https://example.test/manager.exe"},
            {"name": "CodexPlusPlus_1.0.9_x64-setup.exe", "browser_download_url": "https://example.test/setup.exe"},
            {"name": "CodexPlusPlus_1.0.9_x64.dmg", "browser_download_url": "https://example.test/app.dmg"}
        ]
    }))
    .unwrap();

    assert_eq!(release.version, "v1.0.9");
    assert_eq!(release.asset_sha256, None);
    assert_eq!(release.sha256sums_url, None);
    if cfg!(windows) {
        assert_eq!(
            release.asset_name.as_deref(),
            Some("CodexPlusPlus_1.0.9_x64-setup.exe")
        );
    } else if cfg!(target_os = "macos") {
        assert_eq!(
            release.asset_name.as_deref(),
            Some("CodexPlusPlus_1.0.9_x64.dmg")
        );
    } else {
        assert_eq!(release.asset_name.as_deref(), None);
    }
}

#[test]
fn github_payload_reads_asset_digest_field() {
    let digest = "a".repeat(64);
    let release = release_from_github_payload(&json!({
        "tag_name": "v1.3.0-3n.7",
        "assets": [
            {
                "name": "Codex3N-1.3.0-3n.7-windows-x64-setup.exe",
                "browser_download_url": "https://example.test/setup.exe",
                "digest": format!("sha256:{digest}")
            },
            {
                "name": "SHA256SUMS.txt",
                "browser_download_url": "https://example.test/SHA256SUMS.txt",
                "digest": "sha256:not-a-valid-digest"
            }
        ]
    }))
    .unwrap();

    assert_eq!(
        release.sha256sums_url.as_deref(),
        Some("https://example.test/SHA256SUMS.txt")
    );
    if cfg!(windows) {
        assert_eq!(release.asset_sha256.as_deref(), Some(digest.as_str()));
    } else {
        // 非 Windows 平台挑不到产物，也就不该带上产物校验和。
        assert_eq!(release.asset_sha256, None);
    }
}

#[test]
fn latest_json_payload_selects_platform_installer_without_github_api_shape() {
    let release = release_from_latest_json_payload(&json!({
        "version": "v1.1.6",
        "url": "https://github.com/BigPizzaV3/CodexPlusPlus/releases/tag/v1.1.6",
        "body": "静态更新描述",
        "assets": [
            {"name": "source.zip", "url": "https://example.test/source.zip"},
            {"name": "CodexPlusPlus-1.1.6-windows-x64-setup.exe", "url": "https://example.test/setup.exe"},
            {"name": "CodexPlusPlus-1.1.6-macos-x64.dmg", "url": "https://example.test/app.dmg"}
        ]
    }))
    .unwrap();

    assert_eq!(release.version, "v1.1.6");
    assert_eq!(release.body, "静态更新描述");
    if cfg!(windows) {
        assert_eq!(
            release.asset_name.as_deref(),
            Some("CodexPlusPlus-1.1.6-windows-x64-setup.exe")
        );
    } else if cfg!(target_os = "macos") {
        assert_eq!(
            release.asset_name.as_deref(),
            Some("CodexPlusPlus-1.1.6-macos-x64.dmg")
        );
    } else {
        assert_eq!(release.asset_name.as_deref(), None);
    }
}

#[test]
fn latest_json_payload_reads_sha256_and_digest_fields() {
    let sha_field = "b".repeat(64);
    let digest_field = "c".repeat(64);
    let release = release_from_latest_json_payload(&json!({
        "version": "v1.3.0-3n.7",
        "assets": [
            {
                "name": "Codex3N-1.3.0-3n.7-windows-x64-setup.exe",
                "url": "https://example.test/setup.exe",
                "sha256": sha_field
            },
            {
                "name": "Codex3N-1.3.0-3n.7-macos-arm64.dmg",
                "url": "https://example.test/app.dmg",
                "digest": format!("sha256:{}", digest_field.to_uppercase())
            },
            {
                "name": "SHA256SUMS.txt",
                "url": "https://example.test/SHA256SUMS.txt",
                "sha256": "d".repeat(64)
            }
        ]
    }))
    .unwrap();

    assert_eq!(
        release.sha256sums_url.as_deref(),
        Some("https://example.test/SHA256SUMS.txt")
    );
    if cfg!(windows) {
        assert_eq!(release.asset_sha256.as_deref(), Some(sha_field.as_str()));
    } else if cfg!(target_os = "macos") {
        // `digest: sha256:<大写 hex>` 归一化成小写。
        assert_eq!(
            release.asset_sha256.as_deref(),
            Some(digest_field.as_str()),
            "macOS 平台应挑到 dmg 并读出 digest 归一化后的 sha256"
        );
    } else {
        assert_eq!(release.asset_sha256, None);
    }
}

#[test]
fn latest_json_payload_ignores_malformed_sha256() {
    let release = release_from_latest_json_payload(&json!({
        "version": "v1.3.0-3n.7",
        "assets": [
            {
                "name": "Codex3N-1.3.0-3n.7-windows-x64-setup.exe",
                "url": "https://example.test/setup.exe",
                "sha256": "SHA256:deadbeef",
                "digest": "sha512:abc"
            }
        ]
    }))
    .unwrap();

    assert_eq!(release.asset_sha256, None);
}

#[test]
fn asset_selection_prefers_current_platform_artifacts() {
    let assets = vec![
        (
            "CodexPlusPlus.zip".to_string(),
            "https://example.test/source.zip".to_string(),
        ),
        (
            "codex-plus-plus-manager.exe".to_string(),
            "https://example.test/manager.exe".to_string(),
        ),
        (
            "CodexPlusPlus_1.0.9_x64-setup.exe".to_string(),
            "https://example.test/setup.exe".to_string(),
        ),
        (
            "CodexPlusPlus_1.0.9_x64.dmg".to_string(),
            "https://example.test/app.dmg".to_string(),
        ),
    ];

    if cfg!(windows) {
        let selected = select_update_asset(&assets).unwrap();
        assert_eq!(selected.name, "CodexPlusPlus_1.0.9_x64-setup.exe");
        assert_eq!(selected.sha256, None);
    } else if cfg!(target_os = "macos") {
        let selected = select_update_asset(&assets).unwrap();
        assert_eq!(selected.name, "CodexPlusPlus_1.0.9_x64.dmg");
    } else {
        assert!(select_update_asset(&assets).is_none());
    }
}

#[test]
fn asset_selection_entry_keeps_sha256_and_never_picks_sha256sums() {
    let hash = "e".repeat(64);
    let assets = vec![
        ReleaseAsset {
            name: "SHA256SUMS.txt".to_string(),
            browser_download_url: "https://example.test/SHA256SUMS.txt".to_string(),
            sha256: Some("f".repeat(64)),
        },
        ReleaseAsset {
            name: "Codex3N-1.3.0-3n.7-windows-x64-setup.exe".to_string(),
            browser_download_url: "https://example.test/setup.exe".to_string(),
            sha256: Some(hash.clone()),
        },
    ];

    if cfg!(windows) {
        let selected = select_update_asset_entry(&assets).expect("应挑到 Windows 安装包");
        assert_eq!(selected.name, "Codex3N-1.3.0-3n.7-windows-x64-setup.exe");
        assert_eq!(selected.sha256.as_deref(), Some(hash.as_str()));
    } else {
        assert!(select_update_asset_entry(&assets).is_none());
    }
}

#[test]
fn asset_selection_accepts_codex3n_installers() {
    let assets = vec![
        (
            "Codex3N-1.2.56-3n.1-windows-x64-setup.exe".to_string(),
            "https://example.test/setup.exe".to_string(),
        ),
        (
            "Codex3N-1.2.56-3n.1-macos-x64.dmg".to_string(),
            "https://example.test/app.dmg".to_string(),
        ),
    ];

    if cfg!(windows) {
        let selected = select_update_asset(&assets).unwrap();
        assert_eq!(selected.name, "Codex3N-1.2.56-3n.1-windows-x64-setup.exe");
    } else if cfg!(target_os = "macos") {
        let selected = select_update_asset(&assets).unwrap();
        assert_eq!(selected.name, "Codex3N-1.2.56-3n.1-macos-x64.dmg");
    } else {
        assert!(select_update_asset(&assets).is_none());
    }
}

#[test]
fn asset_selection_distinguishes_x64_and_arm64_macos_dmgs() {
    // Regression test for the bug where an x86_64 Mac user could be handed
    // the arm64 DMG (or vice versa) because `is_macos_installer_asset` did
    // not check the arch token in the filename.
    let assets = vec![
        (
            "CodexPlusPlus-1.2.17-macos-arm64.dmg".to_string(),
            "https://example.test/app-arm64.dmg".to_string(),
        ),
        (
            "CodexPlusPlus-1.2.17-macos-x64.dmg".to_string(),
            "https://example.test/app-x64.dmg".to_string(),
        ),
    ];

    if cfg!(target_os = "macos") {
        let selected = select_update_asset(&assets)
            .expect("a macOS DMG should be selected for the running arch");
        let expected = match std::env::consts::ARCH {
            "x86_64" => "CodexPlusPlus-1.2.17-macos-x64.dmg",
            "aarch64" => "CodexPlusPlus-1.2.17-macos-arm64.dmg",
            other => panic!("unexpected target arch in test: {other}"),
        };
        assert_eq!(
            selected.name, expected,
            "x86_64 binary must select x64 DMG, aarch64 binary must select arm64 DMG"
        );
    } else {
        // Non-macOS platforms should not pick either macOS DMG.
        assert!(select_update_asset(&assets).is_none());
    }
}

#[test]
fn safe_asset_name_rejects_path_traversal() {
    assert_eq!(safe_asset_name("pkg.zip").unwrap(), "pkg.zip");
    assert!(safe_asset_name("../pkg.zip").is_err());
    assert!(safe_asset_name("").is_err());
}

#[test]
fn download_asset_to_writes_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let release = release_for("v1.0.9", "pkg.zip", "https://example.test/pkg.zip");

    let path = download_asset_to(&release, b"abcdef", dir.path()).unwrap();

    assert_eq!(path, dir.path().join("pkg.zip"));
    assert_eq!(std::fs::read(path).unwrap(), b"abcdef");
}

#[test]
fn normalize_sha256_accepts_and_rejects_expected_shapes() {
    let hash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    assert_eq!(normalize_sha256(hash).as_deref(), Some(hash));
    assert_eq!(
        normalize_sha256(hash.to_uppercase().as_str()).as_deref(),
        Some(hash)
    );
    assert_eq!(
        normalize_sha256(&format!("sha256:{hash}")).as_deref(),
        Some(hash)
    );
    assert_eq!(
        normalize_sha256(&format!("SHA256:{hash}")).as_deref(),
        Some(hash)
    );
    assert_eq!(
        normalize_sha256(&format!("  sha256:{hash}  ")).as_deref(),
        Some(hash)
    );

    assert_eq!(normalize_sha256(""), None);
    assert_eq!(normalize_sha256("   "), None);
    assert_eq!(normalize_sha256(&hash[..63]), None);
    assert_eq!(normalize_sha256(&format!("{hash}0")), None);
    assert_eq!(normalize_sha256(&"z".repeat(64)), None);
    assert_eq!(normalize_sha256(&format!("sha512:{hash}")), None);
    assert_eq!(normalize_sha256("sha256:"), None);
}

#[test]
fn parse_sha256sums_reads_bsd_and_gnu_formats() {
    let hash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    let other = "a".repeat(64);
    // 本地样板：BSD 风格两空格 + GNU 风格 `*` 二进制标记 + BSD `sha256` 工具输出。
    let text = format!(
        "# Codex3N SHA256SUMS\n\
         {other}  Codex3N-1.3.0-3n.7-macos-arm64.dmg\n\
         {hash}  Codex3N-1.3.0-3n.7-windows-x64-setup.exe\n\
         {other} *Codex3N-1.3.0-3n.7-windows-x64.zip\n\
         SHA256 (Codex3N-1.3.0-3n.7-macos-x64.dmg) = {other}\n"
    );

    assert_eq!(
        parse_sha256sums(&text, "Codex3N-1.3.0-3n.7-windows-x64-setup.exe").as_deref(),
        Some(hash)
    );
    assert_eq!(
        parse_sha256sums(&text, "Codex3N-1.3.0-3n.7-windows-x64.zip").as_deref(),
        Some(other.as_str())
    );
    assert_eq!(
        parse_sha256sums(&text, "Codex3N-1.3.0-3n.7-macos-x64.dmg").as_deref(),
        Some(other.as_str())
    );
    // 也接受带目录的写法，按 basename 匹配。
    assert_eq!(
        parse_sha256sums(&text, "dist/Codex3N-1.3.0-3n.7-windows-x64-setup.exe").as_deref(),
        Some(hash)
    );
}

#[test]
fn parse_sha256sums_reads_workflow_generated_sample() {
    // 这段文本是 `.github/workflows/release-assets.yml` 的生成脚本在本机对
    // 三个假产物跑出来的真实输出（BSD 风格两空格、按文件名排序），
    // 末尾手工补一行 GNU 风格 `*` 二进制标记，确认两种格式都能被解析。
    let text = "\
ff5f0b30c8f955f94c64abb8be4be0723828d36a61b428e134607e8295b9b9a4  Codex3N-1.3.0-3n.7-macos-arm64.dmg\n\
e73fb2d8cbf980203e0aaf0d33daac829fc14d88f6c955bcc834a0c122b24d64  Codex3N-1.3.0-3n.7-windows-x64-setup.exe\n\
87631ccd82005449380f604be656382da31678b530cd719d686af4a65324c343 *Codex3N-1.3.0-3n.7-windows-x64.zip\n";

    assert_eq!(
        parse_sha256sums(text, "Codex3N-1.3.0-3n.7-macos-arm64.dmg").as_deref(),
        Some("ff5f0b30c8f955f94c64abb8be4be0723828d36a61b428e134607e8295b9b9a4")
    );
    assert_eq!(
        parse_sha256sums(text, "Codex3N-1.3.0-3n.7-windows-x64-setup.exe").as_deref(),
        Some("e73fb2d8cbf980203e0aaf0d33daac829fc14d88f6c955bcc834a0c122b24d64")
    );
    assert_eq!(
        parse_sha256sums(text, "Codex3N-1.3.0-3n.7-windows-x64.zip").as_deref(),
        Some("87631ccd82005449380f604be656382da31678b530cd719d686af4a65324c343")
    );
    assert_eq!(
        parse_sha256sums(text, "Codex3N-1.3.0-3n.7-macos-x64.dmg"),
        None
    );
}

#[test]
fn sibling_asset_url_swaps_the_file_name_inside_the_same_release_directory() {
    let asset_url = "https://github.com/nk33-dev/Codex3N/releases/download/v1.3.0-3n.7/Codex3N-1.3.0-3n.7-windows-x64-setup.exe";
    assert_eq!(
        sibling_asset_url(asset_url, "SHA256SUMS.txt").as_deref(),
        Some("https://github.com/nk33-dev/Codex3N/releases/download/v1.3.0-3n.7/SHA256SUMS.txt")
    );
    assert_eq!(sibling_asset_url("", "SHA256SUMS.txt"), None);
    assert_eq!(sibling_asset_url("setup.exe", "SHA256SUMS.txt"), None);
    assert_eq!(sibling_asset_url(asset_url, ""), None);
}

#[test]
fn parse_sha256sums_handles_missing_entry_and_empty_text() {
    let text = format!("{}  other.exe\n", "a".repeat(64));

    assert_eq!(parse_sha256sums(&text, "target.exe"), None);
    assert_eq!(parse_sha256sums("", "target.exe"), None);
    assert_eq!(parse_sha256sums("\n  \n", "target.exe"), None);
    assert_eq!(parse_sha256sums(&text, ""), None);
    // 只有非法行时也不能误判。
    assert_eq!(
        parse_sha256sums("not-a-hash  target.exe\n", "target.exe"),
        None
    );
}

#[test]
fn sha256_file_matches_known_digest_and_verify_detects_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("payload.bin");
    std::fs::write(&path, b"hello").unwrap();

    let expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    assert_eq!(sha256_file(&path).unwrap(), expected);
    verify_asset_sha256(&path, expected).unwrap();
    verify_asset_sha256(&path, &expected.to_uppercase()).unwrap();
    verify_asset_sha256(&path, &format!("sha256:{expected}")).unwrap();

    // 大文件分块读取路径也要一致
    let big = dir.path().join("big.bin");
    let bytes = vec![7u8; 200 * 1024];
    std::fs::write(&big, &bytes).unwrap();
    assert_eq!(sha256_file(&big).unwrap(), sha256_hex(&bytes));

    let error = verify_asset_sha256(&path, &"0".repeat(64)).unwrap_err();
    let message = error.to_string();
    assert!(message.contains("expected"), "{message}");
    assert!(message.contains("actual"), "{message}");

    assert!(verify_asset_sha256(&path, "deadbeef").is_err());
    assert!(sha256_file(&dir.path().join("missing.bin")).is_err());
}

#[tokio::test]
async fn download_and_verify_update_accepts_matching_checksum() {
    redirect_diagnostic_log();
    let server = MockServer::start().await;
    let bytes = b"installer-bytes".to_vec();
    let expected = sha256_hex(&bytes);
    Mock::given(method("GET"))
        .and(path("/setup.exe"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes.clone()))
        .mount(&server)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let release = release_for(
        "1.3.0-3n.7",
        "Codex3N-1.3.0-3n.7-windows-x64-setup.exe",
        &format!("{}/setup.exe", server.uri()),
    );

    let path = download_and_verify_update(
        &release,
        dir.path(),
        CURRENT_VERSION,
        Some(expected.clone()),
        UpdatePolicy::default(),
    )
    .await
    .unwrap();

    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(sha256_file(&path).unwrap(), expected);
}

#[tokio::test]
async fn download_and_verify_update_rejects_and_deletes_on_checksum_mismatch() {
    redirect_diagnostic_log();
    let server = MockServer::start().await;
    let bytes = b"tampered-installer".to_vec();
    Mock::given(method("GET"))
        .and(path("/setup.exe"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
        .mount(&server)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let release = release_for(
        "1.3.0-3n.7",
        "Codex3N-1.3.0-3n.7-windows-x64-setup.exe",
        &format!("{}/setup.exe", server.uri()),
    );
    let wrong = "0".repeat(64);

    let error = download_and_verify_update(
        &release,
        dir.path(),
        CURRENT_VERSION,
        Some(wrong),
        UpdatePolicy::default(),
    )
    .await
    .unwrap_err();

    let message = error.to_string();
    assert!(message.contains("sha256"), "{message}");
    // 文件必须被删掉，调用方拿不到可启动的安装包。
    assert!(
        !dir.path()
            .join("Codex3N-1.3.0-3n.7-windows-x64-setup.exe")
            .exists(),
        "校验失败后必须删除已下载文件"
    );
    assert_eq!(
        std::fs::read_dir(dir.path())
            .expect("下载目录应可读")
            .count(),
        0,
        "校验失败后下载目录应保持为空"
    );
}

#[tokio::test]
async fn download_and_verify_update_fails_closed_without_checksum() {
    redirect_diagnostic_log();
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/setup.exe"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"unverified".to_vec()))
        .mount(&server)
        .await;

    let dir = tempfile::tempdir().unwrap();
    let release = release_for(
        "1.3.0-3n.7",
        "Codex3N-1.3.0-3n.7-windows-x64-setup.exe",
        &format!("{}/setup.exe", server.uri()),
    );

    let error = download_and_verify_update(
        &release,
        dir.path(),
        CURRENT_VERSION,
        None,
        UpdatePolicy::default(),
    )
    .await
    .unwrap_err();
    let message = error.to_string();
    assert!(message.contains("未提供安装包 sha256"), "{message}");
    assert!(message.contains(ALLOW_UNVERIFIED_ENV), "{message}");
    // 失败关闭发生在写盘之前，目录里不应留下任何文件。
    assert_eq!(
        std::fs::read_dir(dir.path())
            .map(|e| e.count())
            .unwrap_or(0),
        0
    );

    // 逃生开关打开时放行未校验产物。
    let allowed = download_and_verify_update(
        &release,
        dir.path(),
        CURRENT_VERSION,
        None,
        UpdatePolicy {
            allow_unverified: true,
            ..UpdatePolicy::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(std::fs::read(&allowed).unwrap(), b"unverified");
}

#[tokio::test]
async fn download_and_verify_update_rejects_downgrade_and_same_version() {
    redirect_diagnostic_log();
    let dir = tempfile::tempdir().unwrap();
    let release = release_for(
        "1.3.0-3n.6",
        "Codex3N-1.3.0-3n.6-windows-x64-setup.exe",
        "https://example.test/setup.exe",
    );
    let hash = "a".repeat(64);

    let error = download_and_verify_update(
        &release,
        dir.path(),
        CURRENT_VERSION,
        Some(hash.clone()),
        UpdatePolicy::default(),
    )
    .await
    .unwrap_err();
    let message = error.to_string();
    assert!(message.contains("不高于当前版本"), "{message}");
    assert!(message.contains(ALLOW_DOWNGRADE_ENV), "{message}");

    // 更低的版本同样被拒绝（且不会发起下载）。
    let lower = release_for(
        "1.2.9-3n.9",
        "Codex3N-1.2.9-3n.9-windows-x64-setup.exe",
        "https://example.test/setup.exe",
    );
    let error = download_and_verify_update(
        &lower,
        dir.path(),
        CURRENT_VERSION,
        Some(hash.clone()),
        UpdatePolicy::default(),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("不高于当前版本"));

    // 打开降级开关后放行：这里由 mock server 提供产物，校验通过。
    let server = MockServer::start().await;
    let bytes = b"older-installer".to_vec();
    let expected = sha256_hex(&bytes);
    Mock::given(method("GET"))
        .and(path("/setup.exe"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
        .mount(&server)
        .await;
    let downgrade = release_for(
        "1.3.0-3n.5",
        "Codex3N-1.3.0-3n.5-windows-x64-setup.exe",
        &format!("{}/setup.exe", server.uri()),
    );
    let path = download_and_verify_update(
        &downgrade,
        dir.path(),
        CURRENT_VERSION,
        Some(expected),
        UpdatePolicy {
            allow_downgrade: true,
            ..UpdatePolicy::default()
        },
    )
    .await
    .unwrap();
    assert!(path.exists());
}

#[tokio::test]
async fn download_and_verify_update_rejects_malformed_expected_checksum() {
    redirect_diagnostic_log();
    let dir = tempfile::tempdir().unwrap();
    let release = release_for(
        "1.3.0-3n.7",
        "Codex3N-1.3.0-3n.7-windows-x64-setup.exe",
        "https://example.test/setup.exe",
    );

    let error = download_and_verify_update(
        &release,
        dir.path(),
        CURRENT_VERSION,
        Some("sha256:deadbeef".to_string()),
        UpdatePolicy::default(),
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("格式非法"), "{error}");
}

#[tokio::test]
async fn expected_sha256_prefers_release_metadata_and_derived_sums_file() {
    redirect_diagnostic_log();
    let asset_name = "Codex3N-1.3.0-3n.7-windows-x64-setup.exe";

    // 1) Release 自带的 asset_sha256 优先，不需要任何网络请求。
    let unreachable = MockServer::start().await;
    let declared_hash = "1".repeat(64);
    let mut declared = release_for(
        "1.3.0-3n.7",
        asset_name,
        &format!("{}/setup.exe", unreachable.uri()),
    );
    declared.asset_sha256 = Some(declared_hash.to_uppercase());
    assert_eq!(
        resolve_expected_sha256_for_tests(&declared, &format!("{}/latest.json", unreachable.uri()))
            .await
            .as_deref(),
        Some(declared_hash.as_str())
    );

    // 2) 没有 sha256 时回落到产物同目录的 SHA256SUMS.txt。
    let sums_server = MockServer::start().await;
    let sums_hash = "2".repeat(64);
    Mock::given(method("GET"))
        .and(path("/SHA256SUMS.txt"))
        .respond_with(
            ResponseTemplate::new(200).set_body_string(format!("{sums_hash}  {asset_name}\n")),
        )
        .mount(&sums_server)
        .await;
    let plain = release_for(
        "1.3.0-3n.7",
        asset_name,
        &format!("{}/setup.exe", sums_server.uri()),
    );
    assert_eq!(
        resolve_expected_sha256_for_tests(&plain, &format!("{}/latest.json", sums_server.uri()))
            .await
            .as_deref(),
        Some(sums_hash.as_str())
    );

    // 3) SHA256SUMS.txt 拿不到时回落到 latest.json 的 asset sha256（同版本才行）。
    let json_server = MockServer::start().await;
    let payload_hash = "3".repeat(64);
    Mock::given(method("GET"))
        .and(path("/latest.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "version": "v1.3.0-3n.7",
            "assets": [
                {
                    "name": asset_name,
                    "url": "https://example.test/setup.exe",
                    "sha256": payload_hash
                }
            ]
        })))
        .mount(&json_server)
        .await;
    let json_only = release_for(
        "1.3.0-3n.7",
        asset_name,
        &format!("{}/setup.exe", json_server.uri()),
    );
    assert_eq!(
        resolve_expected_sha256_for_tests(
            &json_only,
            &format!("{}/latest.json", json_server.uri())
        )
        .await
        .as_deref(),
        Some(payload_hash.as_str())
    );
}

#[tokio::test]
async fn expected_sha256_returns_none_when_metadata_is_missing_or_from_another_version() {
    redirect_diagnostic_log();
    let asset_name = "Codex3N-1.3.0-3n.7-windows-x64-setup.exe";
    let server = MockServer::start().await;

    // latest.json 属于另一个版本：不能拿它的校验和给本次安装用。
    Mock::given(method("GET"))
        .and(path("/latest.json"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "version": "v1.3.0-3n.8",
            "assets": [
                {
                    "name": asset_name,
                    "url": "https://example.test/setup.exe",
                    "sha256": "4".repeat(64)
                }
            ]
        })))
        .mount(&server)
        .await;
    let release = release_for(
        "1.3.0-3n.7",
        asset_name,
        &format!("{}/setup.exe", server.uri()),
    );
    assert_eq!(
        resolve_expected_sha256_for_tests(&release, &format!("{}/latest.json", server.uri())).await,
        None
    );

    // 元数据整体不可用时也是 None（调用方据此失败关闭）。
    assert_eq!(
        resolve_expected_sha256_for_tests(&release, "http://127.0.0.1:1/latest.json").await,
        None
    );
}
