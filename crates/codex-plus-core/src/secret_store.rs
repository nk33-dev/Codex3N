//! 本地设置文件里的 API Key 静态加密（落盘加密，内存明文）。
//!
//! 加解密只发生在**落盘边界**：进程内存里始终是明文，调用方（管理器、launcher）
//! 不需要任何改动，见 `crate::settings` 的 `SettingsStore::load` / `save`。
//!
//! 密文格式：
//!
//! ```text
//! enc:v1:<base64url-nopad(nonce(12) || ciphertext || tag(16))>
//! ```
//!
//! 算法 AES-256-GCM。每次加密都用新的随机 nonce，所以同一明文两次加密的结果不同；
//! 前缀里的 `v1` 是版本位，将来换算法时用来区分新旧密文。GCM 自带认证标签，
//! 密文被改动（哪怕一个字节）解密就会失败。
//!
//! 32 字节主密钥交给系统凭据库保管，进程内只取一次：
//!
//! - **Windows**：DPAPI 用户作用域（`CryptProtectData` + `CRYPTPROTECT_UI_FORBIDDEN`）
//!   保护后写进设置目录旁的 `secret.key`，只有当前用户能解开；
//! - **macOS**：Keychain 通用密码项，service = `dev.nk33.Codex3N`，
//!   account = `settings-master-key`；
//! - **其他平台**：没有可用的系统凭据库，`master_key` 直接报错，由 `settings.rs`
//!   回落成明文存储并写一条诊断日志（保存永远不因此失败）。
//!
//! 逃生开关 `CODEX_PLUS_SETTINGS_NO_ENCRYPT`（非空且不是 `0`/`false` 即视为开启，
//! 与 `CODEX_PLUS_UPDATE_*` 系列一致）会让 `encrypt_secret` 直接返回明文，
//! 也就是整体退回明文存储；已经写成密文的字段在关闭开关后仍能正常读回。

use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use aes_gcm::aead::{Aead, AeadCore};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use anyhow::{Context, bail};
use base64::Engine;

/// 密文前缀 + 格式版本。
const ENCRYPTED_PREFIX: &str = "enc:v1:";
/// 主密钥长度（AES-256）。
const MASTER_KEY_LEN: usize = 32;
/// GCM 随机数（nonce）长度。
const NONCE_LEN: usize = 12;
/// GCM 认证标签长度。
const TAG_LEN: usize = 16;
/// 关闭落盘加密的逃生开关。
const NO_ENCRYPT_ENV: &str = "CODEX_PLUS_SETTINGS_NO_ENCRYPT";

/// 值是不是本模块写出的密文。
pub fn is_encrypted(value: &str) -> bool {
    value.starts_with(ENCRYPTED_PREFIX)
}

/// 加密一个密钥明文。
///
/// 空串原样返回（没有东西要保护）；已经是密文的值原样返回（`update` 的读-改-写
/// 可能把密文再送进来，绝不能二次加密）；逃生开关打开时也原样返回。
pub fn encrypt_secret(plaintext: &str) -> anyhow::Result<String> {
    if plaintext.is_empty() || is_encrypted(plaintext) || encryption_disabled() {
        return Ok(plaintext.to_string());
    }
    encrypt_with_key(&master_key()?, plaintext)
}

/// 解密一个密钥值。明文（老格式）原样返回，保持向后兼容。
pub fn decrypt_secret(value: &str) -> anyhow::Result<String> {
    if !is_encrypted(value) {
        return Ok(value.to_string());
    }
    decrypt_with_key(&master_key()?, value)
}

/// 用指定密钥加密（供测试直接验证密码学逻辑，不碰凭据库）。
pub(crate) fn encrypt_with_key(
    key: &[u8; MASTER_KEY_LEN],
    plaintext: &str,
) -> anyhow::Result<String> {
    let cipher = Aes256Gcm::new_from_slice(key).context("创建设置加密器失败")?;
    let nonce = Aes256Gcm::generate_nonce(aes_gcm::aead::OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext.as_bytes())
        .map_err(|_| anyhow::anyhow!("加密设置密钥失败"))?;
    let mut payload = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    payload.extend_from_slice(&nonce);
    payload.extend_from_slice(&ciphertext);
    Ok(format!(
        "{ENCRYPTED_PREFIX}{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload)
    ))
}

/// 用指定密钥解密（供测试直接验证密码学逻辑，不碰凭据库）。
///
/// 所有错误信息都不包含密文内容，避免密文顺着诊断日志或界面外泄。
pub(crate) fn decrypt_with_key(key: &[u8; MASTER_KEY_LEN], value: &str) -> anyhow::Result<String> {
    let payload = value
        .strip_prefix(ENCRYPTED_PREFIX)
        .context("不是本程序写入的密文格式")?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .map_err(|_| anyhow::anyhow!("密文不是合法的 base64url 编码"))?;
    if bytes.len() < NONCE_LEN + TAG_LEN {
        bail!("密文长度不足，可能已被截断");
    }
    let (nonce, ciphertext) = bytes.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new_from_slice(key).context("创建设置解密器失败")?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| anyhow::anyhow!("设置密钥解密失败（密文被改动或主密钥已变化）"))?;
    String::from_utf8(plaintext).context("解密结果不是有效的 UTF-8")
}

/// 逃生开关是否打开。语义与 `update.rs` 的 `env_flag_enabled` 保持一致。
fn encryption_disabled() -> bool {
    std::env::var(NO_ENCRYPT_ENV).is_ok_and(|value| {
        let value = value.trim();
        !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false")
    })
}

/// 32 字节主密钥的进程内缓存。
///
/// 取一次就固定下来：中途换密钥会让「刚用 A 加密、稍后用 B 解密」变成静默的数据
/// 不一致。失败也缓存，避免每次保存都去戳一次系统凭据库。
#[derive(Default)]
struct MasterKeyState {
    key: Option<[u8; MASTER_KEY_LEN]>,
    error: Option<String>,
}

static MASTER_KEY: OnceLock<Mutex<MasterKeyState>> = OnceLock::new();

#[cfg(test)]
static MASTER_KEY_TEST_GUARD: OnceLock<Mutex<()>> = OnceLock::new();

/// 测试注入的主密钥，固定值：所有需要密文的测试共用同一把，避免进程级缓存被
/// 不同测试来回改写。
#[cfg(test)]
pub(crate) const TEST_MASTER_KEY: [u8; MASTER_KEY_LEN] = [0x3f; MASTER_KEY_LEN];

fn initial_master_key_state() -> MasterKeyState {
    MasterKeyState {
        key: None,
        error: test_default_master_key_error(),
    }
}

/// 单元测试默认不读真实凭据库（不碰用户的 DPAPI / Keychain），除非测试显式注入
/// 密钥：需要密文的测试用 `install_test_master_key`。集成测试（`tests/`）编译时
/// 没有 `cfg(test)`，走的仍然是真实平台实现。
#[cfg(test)]
fn test_default_master_key_error() -> Option<String> {
    Some("单元测试未注入主密钥，按凭据库不可用处理".to_string())
}

#[cfg(not(test))]
fn test_default_master_key_error() -> Option<String> {
    None
}

fn master_key_state() -> MutexGuard<'static, MasterKeyState> {
    MASTER_KEY
        .get_or_init(|| Mutex::new(initial_master_key_state()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 取主密钥：进程内只向凭据库要一次，失败也缓存。
fn master_key() -> anyhow::Result<[u8; MASTER_KEY_LEN]> {
    let mut state = master_key_state();
    if let Some(key) = state.key {
        return Ok(key);
    }
    if let Some(error) = &state.error {
        bail!("{error}");
    }
    match platform_master_key() {
        Ok(key) => {
            state.key = Some(key);
            Ok(key)
        }
        Err(error) => {
            let message = format!("{error:#}");
            state.error = Some(message.clone());
            Err(anyhow::anyhow!(message))
        }
    }
}

/// 注入测试主密钥并返回串行锁；guard 要持有到测试结束。
///
/// 主密钥是进程级缓存，同一时刻只能由一个测试决定它的取值，否则「写的时候有
/// 密钥、读的时候没有」会让互不相关的测试随机失败。
#[cfg(test)]
pub(crate) fn install_test_master_key() -> MutexGuard<'static, ()> {
    let guard = MASTER_KEY_TEST_GUARD
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    set_master_key_for_tests(Some(TEST_MASTER_KEY));
    guard
}

/// 覆盖进程主密钥。
///
/// `Some(key)` 注入测试密钥；`None` 模拟「本机凭据库不可用」，此时 `encrypt_secret`
/// 返回错误、`decrypt_secret` 解不开任何密文，由调用方按失败语义处理。
#[cfg(test)]
pub(crate) fn set_master_key_for_tests(key: Option<[u8; MASTER_KEY_LEN]>) {
    let mut state = master_key_state();
    *state = MasterKeyState {
        key,
        error: key.is_none().then(|| "测试已模拟凭据库不可用".to_string()),
    };
}

#[cfg(any(windows, target_os = "macos"))]
fn random_key() -> anyhow::Result<[u8; MASTER_KEY_LEN]> {
    let key = Aes256Gcm::generate_key(aes_gcm::aead::OsRng);
    let mut bytes = [0u8; MASTER_KEY_LEN];
    bytes.copy_from_slice(&key);
    Ok(bytes)
}

#[cfg(any(windows, target_os = "macos"))]
fn key_from_bytes(bytes: &[u8]) -> anyhow::Result<[u8; MASTER_KEY_LEN]> {
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("主密钥长度必须是 {MASTER_KEY_LEN} 字节"))
}

#[cfg(windows)]
fn platform_master_key() -> anyhow::Result<[u8; MASTER_KEY_LEN]> {
    windows_dpapi::load_or_create_master_key()
}

#[cfg(target_os = "macos")]
fn platform_master_key() -> anyhow::Result<[u8; MASTER_KEY_LEN]> {
    macos_keychain::load_or_create_master_key()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_master_key() -> anyhow::Result<[u8; MASTER_KEY_LEN]> {
    bail!("当前平台没有可用的系统凭据库，无法加密 settings.json 里的 API Key")
}

/// 测试用的主密钥文件路径覆盖。集成测试（`tests/`）用临时设置目录跑真实的
/// DPAPI 路径，如果不覆盖，主密钥会落进用户真实的应用状态目录。
static SECRET_KEY_PATH_OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 覆盖主密钥文件路径；传 `None` 恢复默认推导。风格对齐
/// `crate::paths::set_settings_path_for_tests`，只在测试里使用。
pub fn set_secret_key_path_for_tests(path: Option<PathBuf>) {
    let mut override_path = SECRET_KEY_PATH_OVERRIDE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *override_path = path;
}

/// 主密钥文件与 `settings.json` 同级（`secret.key`）。
///
/// 默认按 `paths::default_settings_path()` 推导：测试里替换设置路径
/// （`paths::set_settings_path_for_tests`）时密钥文件跟着一起走。集成测试如果用
/// `SettingsStore::new(临时路径)` 而没改全局设置路径，要显式调
/// `set_secret_key_path_for_tests`，否则会写到真实目录。
#[cfg(windows)]
fn secret_key_path() -> PathBuf {
    const SECRET_KEY_FILE: &str = "secret.key";
    if let Some(path) = SECRET_KEY_PATH_OVERRIDE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
    {
        return path;
    }
    match crate::paths::default_settings_path().parent() {
        Some(parent) => parent.join(SECRET_KEY_FILE),
        None => PathBuf::from(SECRET_KEY_FILE),
    }
}

/// Windows：用 DPAPI（用户作用域）保护主密钥，密文写进设置目录旁的 `secret.key`。
#[cfg(windows)]
mod windows_dpapi {
    use std::fs;
    use std::io::Write as _;
    use std::path::Path;
    use std::time::Duration;

    use anyhow::{Context, bail};
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };

    use super::{MASTER_KEY_LEN, random_key, secret_key_path};

    /// 读写 `secret.key` 时等待另一个进程写完的重试次数与间隔。
    const RETRY_ATTEMPTS: usize = 50;
    const RETRY_INTERVAL: Duration = Duration::from_millis(20);

    pub(super) fn load_or_create_master_key() -> anyhow::Result<[u8; MASTER_KEY_LEN]> {
        let path = secret_key_path();
        match read_existing_key(&path)? {
            ExistingKey::Found(key) => return Ok(key),
            ExistingKey::EmptyPlaceholder => {
                // `create_new` 之后、写入之前的崩溃会留下 0 字节文件：它不可能承载
                // 任何密钥，直接补写，免得用户永久卡在「无法加密」的状态。
                let key = random_key()?;
                fs::write(&path, protect(&key)?)
                    .with_context(|| format!("补写主密钥文件失败：{}", path.display()))?;
                return match read_existing_key(&path)? {
                    ExistingKey::Found(stored) => Ok(stored),
                    _ => Ok(key),
                };
            }
            ExistingKey::Missing => {}
        }

        let key = random_key()?;
        let protected = protect(&key)?;
        if create_key_file(&path, &protected)? {
            return Ok(key);
        }
        // 另一个进程抢先创建了，必须以磁盘上的那份为准：否则两个进程各用一把密钥，
        // 先写入的密文后面就永远解不开了。
        match read_existing_key(&path)? {
            ExistingKey::Found(key) => Ok(key),
            _ => bail!(
                "主密钥文件被并发创建但读不到可用密钥，未做任何改写：{}",
                path.display()
            ),
        }
    }

    enum ExistingKey {
        Found([u8; MASTER_KEY_LEN]),
        /// 文件存在但一直是空的（`create_new` 后崩溃留下的残骸）。
        EmptyPlaceholder,
        Missing,
    }

    /// 读出并解开已有的 `secret.key`。
    ///
    /// 刚被别的进程 `create_new` 出来还没写完的文件会解锁失败，所以按固定间隔重试；
    /// 重试期间**只读**，绝不改写或删除磁盘上的文件（代码回退不等于数据回退）。
    fn read_existing_key(path: &Path) -> anyhow::Result<ExistingKey> {
        for attempt in 0..RETRY_ATTEMPTS {
            match fs::read(path) {
                Ok(bytes) if bytes.is_empty() => {}
                Ok(bytes) => match unprotect(&bytes) {
                    Ok(plaintext) => {
                        return Ok(ExistingKey::Found(super::key_from_bytes(&plaintext)?));
                    }
                    Err(error) => {
                        if attempt + 1 == RETRY_ATTEMPTS {
                            return Err(error).with_context(|| {
                                format!(
                                    "解开主密钥文件失败（文件保持原样，未做任何改写）：{}",
                                    path.display()
                                )
                            });
                        }
                    }
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(ExistingKey::Missing);
                }
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("读取主密钥文件失败：{}", path.display()));
                }
            }
            std::thread::sleep(RETRY_INTERVAL);
        }
        Ok(ExistingKey::EmptyPlaceholder)
    }

    /// 用 `create_new` 原子地抢占主密钥文件；返回 false 表示已被别的进程创建。
    fn create_key_file(path: &Path, protected: &[u8]) -> anyhow::Result<bool> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("创建主密钥目录失败：{}", parent.display()))?;
        }
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(mut file) => {
                file.write_all(protected)
                    .and_then(|()| file.sync_all())
                    .with_context(|| format!("写入主密钥文件失败：{}", path.display()))?;
                restrict_permissions(path);
                Ok(true)
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => {
                Err(error).with_context(|| format!("创建主密钥文件失败：{}", path.display()))
            }
        }
    }

    /// 尽力把文件属性设成只读。DPAPI 已经保证只有当前用户能解开，这一步只是多加
    /// 一道门槛，失败不影响功能（将来需要换密钥时要先清掉只读属性）。
    fn restrict_permissions(path: &Path) {
        if let Ok(metadata) = fs::metadata(path) {
            let mut permissions = metadata.permissions();
            permissions.set_readonly(true);
            let _ = fs::set_permissions(path, permissions);
        }
    }

    fn protect(plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB {
                cbData: plaintext.len() as u32,
                pbData: plaintext.as_ptr() as *mut u8,
            };
            let mut output = CRYPT_INTEGER_BLOB::default();
            CryptProtectData(
                &input,
                windows::core::PCWSTR::null(),
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .context("DPAPI 加密主密钥失败")?;
            take_blob(output)
        }
    }

    fn unprotect(protected: &[u8]) -> anyhow::Result<Vec<u8>> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB {
                cbData: protected.len() as u32,
                pbData: protected.as_ptr() as *mut u8,
            };
            let mut output = CRYPT_INTEGER_BLOB::default();
            CryptUnprotectData(
                &input,
                None,
                None,
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
            .context("DPAPI 解密主密钥失败")?;
            take_blob(output)
        }
    }

    /// 复制出 DPAPI 的输出缓冲区并把它还给系统（DPAPI 用 `LocalAlloc` 分配）。
    fn take_blob(blob: CRYPT_INTEGER_BLOB) -> anyhow::Result<Vec<u8>> {
        if blob.pbData.is_null() || blob.cbData == 0 {
            bail!("DPAPI 返回了空数据");
        }
        let bytes =
            unsafe { std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec() };
        unsafe {
            let _ = LocalFree(HLOCAL(blob.pbData as *mut core::ffi::c_void));
        }
        Ok(bytes)
    }
}

/// macOS：主密钥存 Keychain 通用密码项，首次访问时生成并写入，之后读回。
#[cfg(target_os = "macos")]
mod macos_keychain {
    use anyhow::Context;
    use security_framework::passwords::{PasswordOptions, generic_password, set_generic_password};

    use super::MASTER_KEY_LEN;

    /// Keychain 通用密码项的 service / account。
    ///
    /// 改这两个值等于换主密钥，老密文会解不开，必须连同迁移一起改。
    const SERVICE: &str = "dev.nk33.Codex3N";
    const ACCOUNT: &str = "settings-master-key";
    /// `errSecItemNotFound`：Keychain 里还没有对应条目（Security.framework 的稳定
    /// 状态码，文档里就是这个值）。
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    pub(super) fn load_or_create_master_key() -> anyhow::Result<[u8; MASTER_KEY_LEN]> {
        match generic_password(PasswordOptions::new_generic_password(SERVICE, ACCOUNT)) {
            Ok(bytes) => super::key_from_bytes(&bytes)
                .context("Keychain 里的设置主密钥长度不对，可用「钥匙串访问」删掉后重试"),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => create_master_key(),
            Err(error) => Err(error).context("读取 Keychain 里的设置主密钥失败"),
        }
    }

    fn create_master_key() -> anyhow::Result<[u8; MASTER_KEY_LEN]> {
        let key = super::random_key()?;
        // 写不进去就必须报错：否则每次启动都会换一把新密钥，之前加密的内容永远解不开。
        set_generic_password(SERVICE, ACCOUNT, &key).context("写入 Keychain 设置主密钥失败")?;
        Ok(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> [u8; MASTER_KEY_LEN] {
        [byte; MASTER_KEY_LEN]
    }

    #[test]
    fn is_encrypted_matches_only_our_prefix() {
        assert!(is_encrypted("enc:v1:AAAA"));
        assert!(!is_encrypted(""));
        assert!(!is_encrypted("sk-test"));
        assert!(!is_encrypted("enc:"));
        assert!(!is_encrypted("enc:v2:AAAA"));
        assert!(!is_encrypted("enc:v1"));
    }

    #[test]
    fn encrypt_with_key_roundtrips_and_hides_the_plaintext() {
        let encrypted = encrypt_with_key(&key(7), "sk-plain-secret").unwrap();

        assert!(is_encrypted(&encrypted));
        assert!(!encrypted.contains("sk-plain-secret"));
        assert_eq!(
            decrypt_with_key(&key(7), &encrypted).unwrap(),
            "sk-plain-secret"
        );
    }

    #[test]
    fn encrypt_with_key_uses_a_fresh_nonce_each_time() {
        let first = encrypt_with_key(&key(7), "sk-same").unwrap();
        let second = encrypt_with_key(&key(7), "sk-same").unwrap();

        assert_ne!(first, second, "同一明文两次加密必须不同（随机 nonce）");
        assert_eq!(decrypt_with_key(&key(7), &first).unwrap(), "sk-same");
        assert_eq!(decrypt_with_key(&key(7), &second).unwrap(), "sk-same");
    }

    #[test]
    fn decrypt_with_key_rejects_tampered_ciphertext() {
        let encrypted = encrypt_with_key(&key(7), "sk-tamper").unwrap();
        let payload = encrypted.strip_prefix(ENCRYPTED_PREFIX).unwrap();
        let mut bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(payload)
            .unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        let tampered = format!(
            "{ENCRYPTED_PREFIX}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&bytes)
        );

        let error = decrypt_with_key(&key(7), &tampered).unwrap_err();
        assert!(error.to_string().contains("解密失败"));
        assert!(
            !error.to_string().contains(payload),
            "错误信息里不能带密文内容"
        );
    }

    #[test]
    fn decrypt_with_key_rejects_malformed_payloads() {
        // 缺 payload。
        assert!(decrypt_with_key(&key(7), "enc:v1:").is_err());
        // base64url 非法。
        assert!(decrypt_with_key(&key(7), "enc:v1:!!!!").is_err());
        // 长度不足（nonce + tag 之外没有密文）。
        let short = format!(
            "{ENCRYPTED_PREFIX}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode([0u8; NONCE_LEN])
        );
        assert!(decrypt_with_key(&key(7), &short).is_err());
        // 前缀不对。
        assert!(decrypt_with_key(&key(7), "sk-plain").is_err());
    }

    #[test]
    fn decrypt_with_key_rejects_a_different_key() {
        let encrypted = encrypt_with_key(&key(7), "sk-other-key").unwrap();

        assert!(decrypt_with_key(&key(9), &encrypted).is_err());
    }

    #[test]
    fn encrypt_secret_leaves_empty_and_already_encrypted_values_alone() {
        // 这两个分支不碰凭据库：单元测试默认没有主密钥也应当成立。
        assert_eq!(encrypt_secret("").unwrap(), "");
        assert_eq!(encrypt_secret("enc:v1:kept").unwrap(), "enc:v1:kept");
        // 明文老格式在解密方向原样返回。
        assert_eq!(decrypt_secret("sk-legacy").unwrap(), "sk-legacy");
    }

    #[test]
    fn public_api_roundtrips_with_the_injected_master_key() {
        let _guard = install_test_master_key();

        let encrypted = encrypt_secret("sk-injected").unwrap();
        assert!(is_encrypted(&encrypted));
        assert_eq!(decrypt_secret(&encrypted).unwrap(), "sk-injected");
    }

    #[test]
    fn simulated_missing_credential_store_fails_to_encrypt() {
        let _guard = install_test_master_key();

        // 模拟凭据库不可用：加密必须报错（由 settings 落盘边界回落明文），
        // 解密必须解不开，而不是悄悄返回原值。
        set_master_key_for_tests(None);
        assert!(encrypt_secret("sk-unavailable").is_err());
        assert!(decrypt_secret("enc:v1:AAAA").is_err());
        // 立刻把注入的测试密钥放回去，别的测试还在用同一把。
        set_master_key_for_tests(Some(TEST_MASTER_KEY));
        assert_eq!(
            decrypt_secret(&encrypt_secret("sk-back").unwrap()).unwrap(),
            "sk-back"
        );
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn random_key_is_32_bytes_and_not_reused() {
        let first = random_key().unwrap();
        let second = random_key().unwrap();

        assert_eq!(first.len(), MASTER_KEY_LEN);
        assert_ne!(first, second);
    }
}
