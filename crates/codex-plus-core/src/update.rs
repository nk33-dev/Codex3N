use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const DEFAULT_REPOSITORY: &str = "nk33-dev/Codex3N";
pub const DEFAULT_LATEST_JSON_URL: &str =
    "https://github.com/nk33-dev/Codex3N/releases/latest/download/latest.json";
/// 发布侧生成的校验和文件名；客户端在 asset 元数据缺少 sha256 时回落到它。
pub const SHA256SUMS_ASSET_NAME: &str = "SHA256SUMS.txt";
/// 逃生开关：允许安装不高于当前版本的包（默认关闭）。
pub const ALLOW_DOWNGRADE_ENV: &str = "CODEX_PLUS_UPDATE_ALLOW_DOWNGRADE";
/// 逃生开关：允许在发布方未提供 sha256 时继续安装（默认关闭）。
pub const ALLOW_UNVERIFIED_ENV: &str = "CODEX_PLUS_UPDATE_ALLOW_UNVERIFIED";
const UPDATE_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const UPDATE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);
/// 计算文件 sha256 时的分块大小，避免把安装包整份读进内存。
const SHA256_READ_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
    /// 发布方给出的该产物 sha256（小写 hex）；缺省表示无可信校验和。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Release {
    pub version: String,
    pub url: String,
    pub body: String,
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    /// 选中产物的 sha256（小写 hex，来自 latest.json 的 `sha256`/`digest` 或 API 的 `digest`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_sha256: Option<String>,
    /// release 里 `SHA256SUMS.txt` 的下载地址，作为产物自身 sha256 的回落来源。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256sums_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateCheck {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_summary: String,
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
    pub update_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateInstall {
    pub release: Release,
    pub installer_path: PathBuf,
    pub launched: bool,
}

pub fn parse_version_tag(value: &str) -> anyhow::Result<Vec<u64>> {
    let normalized = value.trim().trim_start_matches(['v', 'V']);
    let (core, suffix) = normalized
        .split_once('-')
        .map_or((normalized, None), |(core, suffix)| (core, Some(suffix)));
    let mut digits = String::new();
    for ch in core.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            digits.push(ch);
        } else {
            break;
        }
    }
    if digits.is_empty() {
        anyhow::bail!("Invalid version tag: {value}");
    }
    let mut segments = digits
        .split('.')
        .map(|part| part.parse::<u64>().map_err(Into::into))
        .collect::<anyhow::Result<Vec<_>>>()?;
    if let Some(suffix) = suffix {
        let suffix = suffix.to_ascii_lowercase();
        if let Some(revision) = suffix.strip_prefix("3n.") {
            let revision = revision
                .split('.')
                .next()
                .ok_or_else(|| anyhow::anyhow!("Invalid Codex3N version tag: {value}"))?;
            segments.push(revision.parse::<u64>()?);
        }
    }
    Ok(segments)
}

pub fn is_newer_version(candidate: &str, current: &str) -> anyhow::Result<bool> {
    let mut left = parse_version_tag(candidate)?;
    let mut right = parse_version_tag(current)?;
    let len = left.len().max(right.len());
    left.resize(len, 0);
    right.resize(len, 0);
    Ok(left > right)
}

pub fn release_from_github_payload(payload: &Value) -> anyhow::Result<Release> {
    let version = payload
        .get("tag_name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("release payload missing tag_name"))?
        .to_string();
    let assets = payload
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(asset_from_github_entry)
        .collect::<Vec<_>>();
    let selected = select_update_asset_entry(&assets);
    let sha256sums_url = find_asset_url(&assets, SHA256SUMS_ASSET_NAME);
    Ok(Release {
        version,
        url: payload
            .get("html_url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        body: payload
            .get("body")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        asset_name: selected.as_ref().map(|asset| asset.name.clone()),
        asset_url: selected
            .as_ref()
            .map(|asset| asset.browser_download_url.clone()),
        asset_sha256: selected.and_then(|asset| asset.sha256),
        sha256sums_url,
    })
}

pub fn release_from_latest_json_payload(payload: &Value) -> anyhow::Result<Release> {
    let version = payload
        .get("version")
        .or_else(|| payload.get("tag_name"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("latest.json missing version"))?
        .to_string();
    let assets = payload
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(asset_from_latest_json_entry)
        .collect::<Vec<_>>();
    let selected = select_update_asset_entry(&assets);
    let sha256sums_url = find_asset_url(&assets, SHA256SUMS_ASSET_NAME);
    Ok(Release {
        version,
        url: payload
            .get("url")
            .or_else(|| payload.get("html_url"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        body: payload
            .get("body")
            .or_else(|| payload.get("release_summary"))
            .or_else(|| payload.get("notes"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        asset_name: selected.as_ref().map(|asset| asset.name.clone()),
        asset_url: selected
            .as_ref()
            .map(|asset| asset.browser_download_url.clone()),
        asset_sha256: selected.and_then(|asset| asset.sha256),
        sha256sums_url,
    })
}

/// 解析 GitHub Releases API 的 asset 条目；`digest` 是新字段，形如 `sha256:<hex>`。
fn asset_from_github_entry(asset: &Value) -> Option<ReleaseAsset> {
    Some(ReleaseAsset {
        name: asset.get("name")?.as_str()?.to_string(),
        browser_download_url: asset.get("browser_download_url")?.as_str()?.to_string(),
        sha256: asset
            .get("digest")
            .and_then(Value::as_str)
            .and_then(normalize_sha256),
    })
}

/// 解析发布侧静态 latest.json 的 asset 条目；`sha256` 是首选字段，`digest` 兼容 API 形态。
fn asset_from_latest_json_entry(asset: &Value) -> Option<ReleaseAsset> {
    Some(ReleaseAsset {
        name: asset.get("name")?.as_str()?.to_string(),
        browser_download_url: asset
            .get("url")
            .or_else(|| asset.get("browser_download_url"))?
            .as_str()?
            .to_string(),
        sha256: asset
            .get("sha256")
            .or_else(|| asset.get("digest"))
            .and_then(Value::as_str)
            .and_then(normalize_sha256),
    })
}

fn find_asset_url(assets: &[ReleaseAsset], file_name: &str) -> Option<String> {
    assets
        .iter()
        .find(|asset| asset.name == file_name)
        .map(|asset| asset.browser_download_url.clone())
}

/// 按平台挑出最合适的产物（含发布方给出的 sha256）。
pub fn select_update_asset_entry(assets: &[ReleaseAsset]) -> Option<ReleaseAsset> {
    let mut best: Option<(u8, &ReleaseAsset)> = None;
    for asset in assets {
        if asset.name.trim().is_empty() || asset.browser_download_url.trim().is_empty() {
            continue;
        }
        let rank = platform_asset_rank(&asset.name.to_ascii_lowercase());
        if rank >= 2 {
            continue;
        }
        if best
            .as_ref()
            .map_or(true, |(best_rank, _)| rank < *best_rank)
        {
            best = Some((rank, asset));
        }
    }
    best.map(|(_, asset)| asset.clone())
}

pub fn select_update_asset(assets: &[(String, String)]) -> Option<ReleaseAsset> {
    let entries = assets
        .iter()
        .map(|(name, url)| ReleaseAsset {
            name: name.clone(),
            browser_download_url: url.clone(),
            sha256: None,
        })
        .collect::<Vec<_>>();
    select_update_asset_entry(&entries)
}

pub async fn fetch_latest_release(latest_json_url: &str) -> anyhow::Result<Release> {
    let client = update_http_client()?;
    let payload = client
        .get(latest_json_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;
    release_from_latest_json_payload(&payload)
}

pub async fn check_for_update(current_version: &str) -> anyhow::Result<UpdateCheck> {
    let release = fetch_latest_release(DEFAULT_LATEST_JSON_URL).await?;
    let update_available = is_newer_version(&release.version, current_version)?;
    Ok(UpdateCheck {
        current_version: current_version.to_string(),
        latest_version: Some(release.version),
        release_summary: release.body,
        asset_name: release.asset_name,
        asset_url: release.asset_url,
        update_available,
    })
}

/// 更新安装的两道保护开关。默认全关：拒绝降级，且拒绝无校验和的产物。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct UpdatePolicy {
    /// `CODEX_PLUS_UPDATE_ALLOW_DOWNGRADE=1`：允许安装不高于当前版本的包。
    pub allow_downgrade: bool,
    /// `CODEX_PLUS_UPDATE_ALLOW_UNVERIFIED=1`：允许在发布方未提供 sha256 时安装。
    pub allow_unverified: bool,
}

impl UpdatePolicy {
    pub fn from_env() -> Self {
        Self {
            allow_downgrade: env_flag_enabled(ALLOW_DOWNGRADE_ENV),
            allow_unverified: env_flag_enabled(ALLOW_UNVERIFIED_ENV),
        }
    }
}

fn env_flag_enabled(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| {
        let value = value.trim();
        !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false")
    })
}

pub async fn perform_update(
    release: &Release,
    download_dir: &Path,
) -> anyhow::Result<UpdateInstall> {
    let policy = UpdatePolicy::from_env();
    let expected_sha256 = resolve_expected_sha256(release, DEFAULT_LATEST_JSON_URL).await;
    let installer_path = download_and_verify_update(
        release,
        download_dir,
        crate::version::VERSION,
        expected_sha256,
        policy,
    )
    .await?;
    if let Err(error) = launch_installer(&installer_path) {
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "update.launch.failed",
            json!({
                "version": release.version,
                "assetName": release.asset_name,
                "installerPath": installer_path.to_string_lossy(),
                "error": error.to_string()
            }),
        );
        return Err(error);
    }
    let _ = crate::diagnostic_log::append_diagnostic_log(
        "update.launch.completed",
        json!({
            "version": release.version,
            "assetName": release.asset_name,
            "installerPath": installer_path.to_string_lossy()
        }),
    );
    Ok(UpdateInstall {
        release: release.clone(),
        installer_path,
        launched: true,
    })
}

/// 下载安装包并做校验，返回已落盘的安装包路径；**不启动安装包**。
///
/// 判定顺序（fail closed）：
/// 1. 降级保护：目标版本必须高于 `current_version`，否则拒绝（除非 `policy.allow_downgrade`）。
/// 2. `expected_sha256` 为 `None`（发布方未提供）时直接拒绝，不写盘（除非 `policy.allow_unverified`）。
/// 3. 下载写盘后比对 sha256；不匹配则删除文件并报错，绝不交给调用方启动。
pub async fn download_and_verify_update(
    release: &Release,
    download_dir: &Path,
    current_version: &str,
    expected_sha256: Option<String>,
    policy: UpdatePolicy,
) -> anyhow::Result<PathBuf> {
    enforce_upgrade_target(release, current_version, policy)?;
    let url = release
        .asset_url
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("没有可下载的 Release asset"))?;
    let expected_sha256 = match expected_sha256 {
        Some(value) => Some(normalize_sha256(&value).ok_or_else(|| {
            anyhow::anyhow!("发布方提供的 sha256 校验和格式非法：{value}，已拒绝安装")
        })?),
        None => None,
    };
    if expected_sha256.is_none() && !policy.allow_unverified {
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "update.verify.missing_checksum_rejected",
            json!({ "version": release.version, "assetName": release.asset_name }),
        );
        anyhow::bail!(
            "发布方未提供安装包 sha256 校验和，已拒绝安装；确认风险后可设置 {ALLOW_UNVERIFIED_ENV}=1 跳过校验"
        );
    }
    let _ = crate::diagnostic_log::append_diagnostic_log(
        "update.perform.start",
        json!({
            "version": release.version,
            "assetName": release.asset_name,
            "assetUrl": url,
            "expectedSha256": expected_sha256,
            "downloadTimeoutSeconds": UPDATE_DOWNLOAD_TIMEOUT.as_secs()
        }),
    );
    let response = match update_http_client()?.get(url).send().await {
        Ok(response) => response,
        Err(error) => {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "update.download.failed",
                json!({ "version": release.version, "assetName": release.asset_name, "error": error.to_string() }),
            );
            return Err(anyhow::anyhow!("下载安装包失败：{error}"));
        }
    };
    let response = match response.error_for_status() {
        Ok(response) => response,
        Err(error) => {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "update.download.bad_status",
                json!({ "version": release.version, "assetName": release.asset_name, "error": error.to_string() }),
            );
            return Err(anyhow::anyhow!("下载安装包失败：{error}"));
        }
    };
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "update.download.body_failed",
                json!({ "version": release.version, "assetName": release.asset_name, "error": error.to_string() }),
            );
            return Err(anyhow::anyhow!("读取安装包失败：{error}"));
        }
    };
    let _ = crate::diagnostic_log::append_diagnostic_log(
        "update.download.completed",
        json!({
            "version": release.version,
            "assetName": release.asset_name,
            "bytes": bytes.len()
        }),
    );
    let installer_path = match download_asset_to(release, &bytes, download_dir) {
        Ok(path) => path,
        Err(error) => {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "update.write.failed",
                json!({
                    "version": release.version,
                    "assetName": release.asset_name,
                    "downloadDir": download_dir.to_string_lossy(),
                    "bytes": bytes.len(),
                    "error": error.to_string()
                }),
            );
            return Err(error);
        }
    };
    let _ = crate::diagnostic_log::append_diagnostic_log(
        "update.write.completed",
        json!({
            "version": release.version,
            "assetName": release.asset_name,
            "installerPath": installer_path.to_string_lossy(),
            "bytes": bytes.len()
        }),
    );
    match expected_sha256 {
        Some(expected) => {
            if let Err(error) = verify_asset_sha256(&installer_path, &expected) {
                // 校验失败必须让文件不可用：删掉落盘的安装包，不启动安装程序。
                let removed = std::fs::remove_file(&installer_path).is_ok();
                let _ = crate::diagnostic_log::append_diagnostic_log(
                    "update.verify.failed",
                    json!({
                        "version": release.version,
                        "assetName": release.asset_name,
                        "installerPath": installer_path.to_string_lossy(),
                        "removed": removed,
                        "error": error.to_string()
                    }),
                );
                return Err(anyhow::anyhow!(
                    "安装包 sha256 校验未通过，已删除下载文件：{error}"
                ));
            }
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "update.verify.completed",
                json!({
                    "version": release.version,
                    "assetName": release.asset_name,
                    "installerPath": installer_path.to_string_lossy(),
                    "sha256": expected
                }),
            );
        }
        None => {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "update.verify.skipped_by_escape_switch",
                json!({
                    "version": release.version,
                    "assetName": release.asset_name,
                    "escapeSwitch": ALLOW_UNVERIFIED_ENV
                }),
            );
        }
    }
    Ok(installer_path)
}

/// 降级保护：目标版本不高于当前版本时拒绝安装。
fn enforce_upgrade_target(
    release: &Release,
    current_version: &str,
    policy: UpdatePolicy,
) -> anyhow::Result<()> {
    let newer = is_newer_version(&release.version, current_version).map_err(|error| {
        anyhow::anyhow!(
            "无法比较目标版本 {} 与当前版本 {current_version}：{error}，已拒绝安装",
            release.version
        )
    })?;
    if !newer {
        if policy.allow_downgrade {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "update.downgrade.allowed",
                json!({
                    "version": release.version,
                    "currentVersion": current_version,
                    "escapeSwitch": ALLOW_DOWNGRADE_ENV
                }),
            );
            return Ok(());
        }
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "update.downgrade.rejected",
            json!({ "version": release.version, "currentVersion": current_version }),
        );
        anyhow::bail!(
            "目标版本 {} 不高于当前版本 {current_version}，已拒绝安装；如确需降级可设置 {ALLOW_DOWNGRADE_ENV}=1",
            release.version
        );
    }
    Ok(())
}

/// 尽力取得本次安装的期望 sha256（已归一化）。取不到返回 `None`，由调用方按失败关闭处理。
///
/// 来源顺序：Release 自带的 `asset_sha256` → Release 自带的 `SHA256SUMS.txt` →
/// 由产物 URL 推出的同目录 `SHA256SUMS.txt`（同 tag，最贴近本次安装的产物）→
/// 重新拉取 latest.json（管理器前端不会转发 sha256 字段，这里是版本匹配时的兜底）。
async fn resolve_expected_sha256(release: &Release, latest_json_url: &str) -> Option<String> {
    if let Some(value) = release.asset_sha256.as_deref().and_then(normalize_sha256) {
        return Some(value);
    }
    let client = match update_http_client() {
        Ok(client) => client,
        Err(error) => {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "update.verify.metadata_unavailable",
                json!({ "version": release.version, "reason": error.to_string() }),
            );
            return None;
        }
    };
    let declared_sums_url = release.sha256sums_url.clone().or_else(|| {
        release
            .asset_url
            .as_deref()
            .and_then(|url| sibling_asset_url(url, SHA256SUMS_ASSET_NAME))
    });
    if let Some(url) = declared_sums_url.as_deref() {
        if let Some(found) = fetch_sha256sums(&client, url, release.asset_name.as_deref()).await {
            return Some(found);
        }
    }
    let payload = match fetch_latest_payload(&client, latest_json_url).await {
        Ok(payload) => payload,
        Err(error) => {
            let _ = crate::diagnostic_log::append_diagnostic_log(
                "update.verify.metadata_unavailable",
                json!({ "version": release.version, "reason": error.to_string() }),
            );
            return None;
        }
    };
    // 只信任同一版本的元数据，避免误用其它 release 的校验和。
    let same_version = payload
        .get("version")
        .or_else(|| payload.get("tag_name"))
        .and_then(Value::as_str)
        .is_some_and(|value| same_release_version(value, &release.version));
    if !same_version {
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "update.verify.metadata_version_mismatch",
            json!({ "version": release.version }),
        );
        return None;
    }
    let assets = payload
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(asset_from_latest_json_entry)
        .collect::<Vec<_>>();
    if let Some(name) = release.asset_name.as_deref() {
        if let Some(found) = assets
            .iter()
            .find(|asset| asset.name == name)
            .and_then(|asset| asset.sha256.clone())
        {
            return Some(found);
        }
    }
    let sums_url = find_asset_url(&assets, SHA256SUMS_ASSET_NAME)?;
    fetch_sha256sums(&client, &sums_url, release.asset_name.as_deref()).await
}

/// 把产物下载地址换成同目录下的另一个文件名（release 产物都放在同一层）。
pub fn sibling_asset_url(asset_url: &str, file_name: &str) -> Option<String> {
    let trimmed = asset_url.trim();
    if trimmed.is_empty() || file_name.trim().is_empty() {
        return None;
    }
    let (prefix, _) = trimmed.rsplit_once('/')?;
    if prefix.is_empty() {
        return None;
    }
    Some(format!("{prefix}/{file_name}"))
}

/// 仅供测试：用可替换的 latest.json 地址跑一遍校验和解析。
#[doc(hidden)]
pub async fn resolve_expected_sha256_for_tests(
    release: &Release,
    latest_json_url: &str,
) -> Option<String> {
    resolve_expected_sha256(release, latest_json_url).await
}

fn same_release_version(left: &str, right: &str) -> bool {
    match (parse_version_tag(left), parse_version_tag(right)) {
        (Ok(left), Ok(right)) => {
            let len = left.len().max(right.len());
            let mut left = left;
            let mut right = right;
            left.resize(len, 0);
            right.resize(len, 0);
            left == right
        }
        _ => left.trim().eq_ignore_ascii_case(right.trim()),
    }
}

async fn fetch_latest_payload(client: &reqwest::Client, url: &str) -> anyhow::Result<Value> {
    Ok(client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?)
}

async fn fetch_sha256sums(
    client: &reqwest::Client,
    url: &str,
    file_name: Option<&str>,
) -> Option<String> {
    let file_name = file_name?;
    let text = match client.get(url).send().await {
        Ok(response) => match response.error_for_status() {
            Ok(response) => match response.text().await {
                Ok(text) => text,
                Err(error) => {
                    log_sums_unavailable(url, &error.to_string());
                    return None;
                }
            },
            Err(error) => {
                log_sums_unavailable(url, &error.to_string());
                return None;
            }
        },
        Err(error) => {
            log_sums_unavailable(url, &error.to_string());
            return None;
        }
    };
    let found = parse_sha256sums(&text, file_name);
    if found.is_none() {
        let _ = crate::diagnostic_log::append_diagnostic_log(
            "update.verify.sums_missing_entry",
            json!({ "sumsUrl": url, "assetName": file_name }),
        );
    }
    found
}

fn log_sums_unavailable(url: &str, reason: &str) {
    let _ = crate::diagnostic_log::append_diagnostic_log(
        "update.verify.sums_unavailable",
        json!({ "sumsUrl": url, "error": reason }),
    );
}

fn update_http_client() -> anyhow::Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .user_agent(format!("Codex3N/{}", crate::version::VERSION))
        .connect_timeout(UPDATE_CONNECT_TIMEOUT)
        .timeout(UPDATE_DOWNLOAD_TIMEOUT)
        .build()?)
}

pub fn download_asset_to(
    release: &Release,
    bytes: &[u8],
    download_dir: &Path,
) -> anyhow::Result<PathBuf> {
    let name = release
        .asset_name
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("没有可下载的 Release asset"))?;
    let safe = safe_asset_name(name)?;
    std::fs::create_dir_all(download_dir)?;
    let path = download_dir.join(safe);
    std::fs::write(&path, bytes)?;
    Ok(path)
}

pub fn safe_asset_name(name: &str) -> anyhow::Result<String> {
    if name.trim().is_empty() {
        anyhow::bail!("非法 Release asset 文件名: {name}");
    }
    let path = Path::new(name);
    if path.components().count() != 1 {
        anyhow::bail!("非法 Release asset 文件名: {name}");
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow::anyhow!("非法 Release asset 文件名: {name}"))?;
    if file_name == "." || file_name == ".." {
        anyhow::bail!("非法 Release asset 文件名: {name}");
    }
    Ok(file_name.to_string())
}

/// 归一化 sha256：去掉可选的 `sha256:` 前缀、去空白、转小写，并要求恰好 64 位 hex。
pub fn normalize_sha256(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let digits = match trimmed.split_once(':') {
        Some((algorithm, rest)) if algorithm.trim().eq_ignore_ascii_case("sha256") => rest.trim(),
        Some(_) => return None,
        None => trimmed,
    };
    let normalized = digits.to_ascii_lowercase();
    if normalized.len() != 64 || !normalized.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    Some(normalized)
}

/// 从 `SHA256SUMS.txt` 文本里取 `file_name` 的 sha256。
///
/// 支持三种写法：BSD 风格 `<hex>  <文件名>`、GNU 风格 `<hex> *<文件名>`，
/// 以及 BSD `sha256` 工具的 `SHA256 (<文件名>) = <hex>`。
pub fn parse_sha256sums(text: &str, file_name: &str) -> Option<String> {
    let target = file_name.trim();
    if target.is_empty() {
        return None;
    }
    let target_base = base_name(target);
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(hash) = parse_bsd_tool_line(line, target, target_base) {
            return Some(hash);
        }
        let Some((hash_part, rest)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let Some(hash) = normalize_sha256(hash_part) else {
            continue;
        };
        let name = rest.trim_start().trim_start_matches('*').trim();
        if name == target || base_name(name) == target_base {
            return Some(hash);
        }
    }
    None
}

/// BSD `sha256` 工具输出：`SHA256 (<文件名>) = <hex>`。
fn parse_bsd_tool_line(line: &str, target: &str, target_base: &str) -> Option<String> {
    let rest = line
        .strip_prefix("SHA256")
        .or_else(|| line.strip_prefix("sha256"))?
        .trim_start();
    let rest = rest.strip_prefix('(')?;
    let (name, rest) = rest.split_once(')')?;
    let hash = rest.trim_start().strip_prefix('=')?.trim();
    let name = name.trim();
    if name == target || base_name(name) == target_base {
        return normalize_sha256(hash);
    }
    None
}

fn base_name(name: &str) -> &str {
    Path::new(name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(name)
}

/// 流式计算文件 sha256（小写 hex），分块读取，不把整份安装包载入内存。
pub fn sha256_file(path: &Path) -> anyhow::Result<String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| anyhow::anyhow!("读取安装包失败 {}：{error}", path.to_string_lossy()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; SHA256_READ_BUFFER_BYTES];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            anyhow::anyhow!("读取安装包失败 {}：{error}", path.to_string_lossy())
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 比对安装包 sha256；不匹配时报错信息同时给出 expected 与 actual。
pub fn verify_asset_sha256(path: &Path, expected: &str) -> anyhow::Result<()> {
    let expected = normalize_sha256(expected)
        .ok_or_else(|| anyhow::anyhow!("sha256 校验和格式非法：{expected}"))?;
    let actual = sha256_file(path)?;
    if actual != expected {
        anyhow::bail!(
            "sha256 不匹配（expected {expected}，actual {actual}，文件 {}）",
            path.to_string_lossy()
        );
    }
    Ok(())
}

fn platform_asset_rank(name: &str) -> u8 {
    // 0 = exact match (current OS + native arch)
    // 1 = same OS, other arch (acceptable fallback, e.g. x86_64 on arm64 or vice versa)
    // 2 = wrong platform
    if cfg!(target_os = "macos") {
        if !is_macos_installer_asset(name) {
            return 2;
        }
        if is_macos_native_arch_asset(name) {
            return 0;
        }
        return 1;
    }
    if cfg!(windows) && is_windows_installer_asset(name) {
        return 0;
    }
    2
}

fn is_macos_native_arch_asset(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let native_arch_token = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        _ => return true, // unknown arch — accept anything
    };
    // Modern filename shape: `...-macos-x64.dmg` or `...-macos-arm64.dmg`
    if lower.contains(&format!("-{native_arch_token}.")) {
        return true;
    }
    // Old filename shape: `CodexPlusPlus_1.0.9_x64.dmg`
    if lower.contains(&format!("_{native_arch_token}.")) {
        return true;
    }
    // Newer but alternative shape: `..._x64.dmg` (no `macos-` token)
    let other_token = if native_arch_token == "x64" {
        "arm64"
    } else {
        "x64"
    };
    if lower.contains(&format!("_{other_token}.")) || lower.contains(&format!("-{other_token}.")) {
        return false;
    }
    // No arch token at all — assume it matches the current arch.
    true
}

fn is_windows_installer_asset(name: &str) -> bool {
    is_supported_product_asset(name)
        && (name.ends_with(".msi")
            || name.ends_with("-setup.exe")
            || name.ends_with("_setup.exe")
            || name.ends_with("setup.exe")
            || name.ends_with("installer.exe"))
}

fn is_macos_installer_asset(name: &str) -> bool {
    // Loose shape check; arch preference is handled by platform_asset_rank
    // via is_macos_native_arch_asset.
    is_supported_product_asset(name) && name.ends_with(".dmg")
}

fn is_supported_product_asset(name: &str) -> bool {
    name.contains("codex3n") || (name.contains("codex") && name.contains("plus"))
}

pub fn launch_installer(path: &Path) -> anyhow::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new(path)
            .creation_flags(crate::windows_integration::CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|error| anyhow::anyhow!("启动安装包失败：{error}"))
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| anyhow::anyhow!("打开 DMG 失败：{error}"))
    }

    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        let _ = path;
        anyhow::bail!("当前平台不支持启动安装包")
    }
}
