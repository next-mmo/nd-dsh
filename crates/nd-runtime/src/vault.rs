//! Local password vault: encrypted-at-rest credential storage.
//!
//! The vault exists so ND can hold credentials without plaintext files,
//! environment variables, or agent-visible context. One vault file holds every
//! entry, encrypted as a whole with AES-256-GCM under a fresh nonce per write.
//! The key is random, generated on first use, and protected at rest by the OS
//! (Windows DPAPI, user-scoped). The sidecar keeps the decrypted key in memory
//! only, per vault path, for the lifetime of the process.
//!
//! Secrets never appear in list results — only [`VaultEntrySummary`], which
//! carries the fields a launcher row renders. [`VaultRegistry::get`] and the
//! write path are the only places a secret crosses the wire, and the desktop
//! gates both behind the broker's sensitive-action grants.
//!
//! Off-Windows fails closed rather than shipping a weaker key protector; the
//! desktop surfaces a clear "not supported yet" message (same posture as
//! [`crate::media::set_wallpaper`]).

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{Context, Result, bail};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::errors;
use crate::errors::{CODE_INVALID_PARAMS, CODE_METHOD_FAILED};

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 12;
const ENVELOPE_VERSION: u32 = 1;

const MAX_ENTRIES: usize = 500;
const MAX_TITLE_CHARS: usize = 200;
const MAX_USERNAME_CHARS: usize = 320;
const MAX_URL_CHARS: usize = 2_048;
const MAX_NOTES_CHARS: usize = 10_000;
const MAX_SECRET_CHARS: usize = 8_192;
const MAX_QUERY_CHARS: usize = 200;
const MAX_PATH_LENGTH: usize = 4_096;
/// Plaintext budget for one vault write, so a request can never balloon the
/// file (or the base64 envelope inside it) without bound.
const MAX_PLAINTEXT_BYTES: usize = 2 * 1024 * 1024;
const KEY_FILE_SUFFIX: &str = ".key";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub id: String,
    pub title: String,
    pub username: String,
    pub url: String,
    pub notes: String,
    pub secret: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntrySummary {
    pub id: String,
    pub title: String,
    pub username: String,
    pub url: String,
    pub updated_at: u64,
}

impl VaultEntrySummary {
    fn of(entry: &VaultEntry) -> Self {
        Self {
            id: entry.id.clone(),
            title: entry.title.clone(),
            username: entry.username.clone(),
            url: entry.url.clone(),
            updated_at: entry.updated_at,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntryInput {
    pub title: String,
    pub username: String,
    pub url: String,
    pub notes: String,
    pub secret: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultListParams {
    /// Absolute path of the vault file; the desktop owns where it lives.
    pub vault_path: String,
    pub query: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultListResult {
    pub entries: Vec<VaultEntrySummary>,
    pub total: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultIdParams {
    pub vault_path: String,
    pub id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntryResult {
    pub entry: VaultEntry,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultWriteParams {
    pub vault_path: String,
    pub entry: VaultEntryInput,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultUpdateParams {
    pub vault_path: String,
    pub id: String,
    pub entry: VaultEntryInput,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultDeleteResult {
    pub deleted: bool,
}

/// Protects (and recovers) the vault master key at rest. Implemented by the OS
/// key store on each platform; no software fallback ships, because a key that
/// lives next to the ciphertext protects nothing.
pub trait KeyProtector: Send + Sync {
    fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>>;
    fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>>;
}

#[cfg(windows)]
pub fn platform_protector() -> Box<dyn KeyProtector> {
    Box::new(dpapi::DpapiProtector)
}

#[cfg(not(windows))]
pub fn platform_protector() -> Box<dyn KeyProtector> {
    Box::new(UnsupportedProtector)
}

#[cfg(windows)]
mod dpapi {
    use super::KeyProtector;
    use anyhow::{Result, bail};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };

    /// DPAPI with `CRYPTPROTECT_UI_FORBIDDEN`: the sidecar has no window, and
    /// the protection is user-scoped, so unlock happens only when that user is
    /// logged in — no prompt can ever be shown or needed here.
    pub struct DpapiProtector;

    impl KeyProtector for DpapiProtector {
        fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
            let input = blob(plaintext);
            let mut output = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: std::ptr::null_mut(),
            };
            let ok = unsafe {
                CryptProtectData(
                    &input,
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            };
            if ok == 0 {
                let error = std::io::Error::last_os_error();
                bail!("CryptProtectData failed: {error}");
            }
            Ok(take_blob(output))
        }

        fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>> {
            let input = blob(protected);
            let mut output = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: std::ptr::null_mut(),
            };
            let ok = unsafe {
                CryptUnprotectData(
                    &input,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    CRYPTPROTECT_UI_FORBIDDEN,
                    &mut output,
                )
            };
            if ok == 0 {
                let error = std::io::Error::last_os_error();
                bail!("CryptUnprotectData failed: {error}");
            }
            Ok(take_blob(output))
        }
    }

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len().min(u32::MAX as usize) as u32,
            pbData: data.as_ptr().cast_mut(),
        }
    }

    /// DPAPI allocates the output blob with LocalAlloc; the caller owns it.
    fn take_blob(output: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let data =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        unsafe { LocalFree(output.pbData.cast()) };
        data
    }
}

#[cfg(not(windows))]
struct UnsupportedProtector;

#[cfg(not(windows))]
impl KeyProtector for UnsupportedProtector {
    fn protect(&self, _plaintext: &[u8]) -> Result<Vec<u8>> {
        bail!(
            "the vault key protector is implemented for Windows only (DPAPI); macOS Keychain and Linux libsecret are follow-ups"
        )
    }

    fn unprotect(&self, _protected: &[u8]) -> Result<Vec<u8>> {
        bail!(
            "the vault key protector is implemented for Windows only (DPAPI); macOS Keychain and Linux libsecret are follow-ups"
        )
    }
}

/// Per-vault-path operation serialization plus the shared key protector.
///
/// Every mutation is a load-modify-save cycle on one file, so concurrent
/// dispatch workers are serialized per vault path; reads take the same lock to
/// keep the answer consistent with the last completed write.
pub struct VaultRegistry {
    protector: Box<dyn KeyProtector>,
    locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
}

impl VaultRegistry {
    pub fn new(protector: Box<dyn KeyProtector>) -> Self {
        Self {
            protector,
            locks: Mutex::new(HashMap::new()),
        }
    }

    pub fn new_platform() -> Self {
        Self::new(platform_protector())
    }

    fn lock_for(&self, vault_path: &Path) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().expect("vault lock registry poisoned");
        Arc::clone(locks.entry(vault_path.to_path_buf()).or_default())
    }

    pub fn list(&self, params: VaultListParams) -> Result<VaultListResult> {
        let vault_path = validate_vault_path(&params.vault_path)?;
        let query = params.query.unwrap_or_default();
        if query.chars().count() > MAX_QUERY_CHARS {
            bail!(errors::coded(
                CODE_INVALID_PARAMS,
                format!("vault query exceeds {MAX_QUERY_CHARS} characters"),
            ));
        }
        let lock = self.lock_for(&vault_path);
        let _guard = lock.lock().expect("vault lock poisoned");
        let entries = self.load_entries(&vault_path)?;
        let query = query.to_lowercase();
        let matched: Vec<VaultEntrySummary> = entries
            .iter()
            .filter(|entry| {
                query.is_empty()
                    || entry.title.to_lowercase().contains(&query)
                    || entry.username.to_lowercase().contains(&query)
                    || entry.url.to_lowercase().contains(&query)
            })
            .map(VaultEntrySummary::of)
            .collect();
        let total = entries.len();
        Ok(VaultListResult {
            entries: matched,
            total,
        })
    }

    pub fn get(&self, params: VaultIdParams) -> Result<VaultEntryResult> {
        let vault_path = validate_vault_path(&params.vault_path)?;
        validate_entry_id(&params.id)?;
        let lock = self.lock_for(&vault_path);
        let _guard = lock.lock().expect("vault lock poisoned");
        let entries = self.load_entries(&vault_path)?;
        let entry = entries
            .into_iter()
            .find(|entry| entry.id == params.id)
            .ok_or_else(|| errors::not_found("vault entry", &params.id))?;
        Ok(VaultEntryResult { entry })
    }

    pub fn create(&self, params: VaultWriteParams) -> Result<VaultEntryResult> {
        let vault_path = validate_vault_path(&params.vault_path)?;
        validate_input(&params.entry)?;
        let lock = self.lock_for(&vault_path);
        let _guard = lock.lock().expect("vault lock poisoned");
        let mut entries = self.load_entries(&vault_path)?;
        if entries.len() >= MAX_ENTRIES {
            bail!(errors::coded(
                CODE_INVALID_PARAMS,
                format!("vault holds the maximum of {MAX_ENTRIES} entries"),
            ));
        }
        let now = now_ms();
        let entry = VaultEntry {
            id: uuid::Uuid::new_v4().to_string(),
            title: params.entry.title.trim().to_string(),
            username: params.entry.username,
            url: params.entry.url,
            notes: params.entry.notes,
            secret: params.entry.secret,
            created_at: now,
            updated_at: now,
        };
        entries.push(entry.clone());
        self.save_entries(&vault_path, &entries)?;
        Ok(VaultEntryResult { entry })
    }

    pub fn update(&self, params: VaultUpdateParams) -> Result<VaultEntryResult> {
        let vault_path = validate_vault_path(&params.vault_path)?;
        validate_entry_id(&params.id)?;
        validate_input(&params.entry)?;
        let lock = self.lock_for(&vault_path);
        let _guard = lock.lock().expect("vault lock poisoned");
        let mut entries = self.load_entries(&vault_path)?;
        let existing = entries
            .iter_mut()
            .find(|entry| entry.id == params.id)
            .ok_or_else(|| errors::not_found("vault entry", &params.id))?;
        existing.title = params.entry.title.trim().to_string();
        existing.username = params.entry.username;
        existing.url = params.entry.url;
        existing.notes = params.entry.notes;
        existing.secret = params.entry.secret;
        existing.updated_at = now_ms();
        let updated = existing.clone();
        self.save_entries(&vault_path, &entries)?;
        Ok(VaultEntryResult { entry: updated })
    }

    pub fn delete(&self, params: VaultIdParams) -> Result<VaultDeleteResult> {
        let vault_path = validate_vault_path(&params.vault_path)?;
        validate_entry_id(&params.id)?;
        let lock = self.lock_for(&vault_path);
        let _guard = lock.lock().expect("vault lock poisoned");
        let mut entries = self.load_entries(&vault_path)?;
        let original_len = entries.len();
        entries.retain(|entry| entry.id != params.id);
        if entries.len() == original_len {
            return Err(errors::not_found("vault entry", &params.id));
        }
        self.save_entries(&vault_path, &entries)?;
        Ok(VaultDeleteResult { deleted: true })
    }

    fn load_entries(&self, vault_path: &Path) -> Result<Vec<VaultEntry>> {
        let key = self.load_or_create_key(vault_path)?;
        let Ok(bytes) = std::fs::read(vault_path) else {
            // No vault file yet: an empty vault, with the key already staged so
            // the first write is not the first time crypto runs.
            return Ok(Vec::new());
        };
        let envelope: VaultEnvelope = serde_json::from_slice(&bytes)
            .with_context(|| "vault file is not a valid envelope")
            .map_err(|error| errors::coded(CODE_METHOD_FAILED, format!("{error:#}")))?;
        let nonce_vec = decode_component(&envelope.nonce, NONCE_BYTES, "vault nonce")?;
        let nonce: [u8; NONCE_BYTES] = nonce_vec.try_into().expect("checked length");
        let ciphertext = base64_decode(&envelope.ciphertext, "vault ciphertext")?;
        let plaintext = decrypt(&key, &nonce, &ciphertext).map_err(|_| {
            errors::coded(
                CODE_METHOD_FAILED,
                "vault file cannot be decrypted with its key file",
            )
        })?;
        serde_json::from_slice(&plaintext)
            .with_context(|| "vault plaintext is not a valid entry list")
            .map_err(|error| errors::coded(CODE_METHOD_FAILED, format!("{error:#}")))
    }

    fn save_entries(&self, vault_path: &Path, entries: &[VaultEntry]) -> Result<()> {
        let key = self.load_or_create_key(vault_path)?;
        let plaintext = serde_json::to_vec(entries).context("encode vault entries")?;
        if plaintext.len() > MAX_PLAINTEXT_BYTES {
            bail!(errors::coded(
                CODE_INVALID_PARAMS,
                format!("vault exceeds its {MAX_PLAINTEXT_BYTES}-byte budget"),
            ));
        }
        let mut nonce = [0u8; NONCE_BYTES];
        fill_random(&mut nonce);
        let ciphertext = encrypt(&key, &nonce, &plaintext)?;
        let envelope = VaultEnvelope {
            version: ENVELOPE_VERSION,
            nonce: base64_encode(&nonce),
            ciphertext: base64_encode(&ciphertext),
        };
        write_private_file(
            vault_path,
            serde_json::to_vec_pretty(&envelope).context("encode vault envelope")?,
        )
    }

    /// The key file is the vault's root of trust: created once, read after
    /// that, and never silently recreated — a new key would orphan every
    /// existing entry without anyone noticing.
    fn load_or_create_key(&self, vault_path: &Path) -> Result<[u8; KEY_BYTES]> {
        let key_path = key_file_for(vault_path);
        if let Ok(bytes) = std::fs::read(&key_path) {
            let envelope: KeyEnvelope = serde_json::from_slice(&bytes)
                .with_context(|| "vault key file is not a valid envelope")
                .map_err(|error| errors::coded(CODE_METHOD_FAILED, format!("{error:#}")))?;
            let protected = base64_decode(&envelope.protected_key, "vault key blob")?;
            let plaintext = self
                .protector
                .unprotect(&protected)
                .map_err(|error| errors::coded(CODE_METHOD_FAILED, format!("{error:#}")))?;
            return key_from_bytes(plaintext);
        }
        if std::fs::metadata(&key_path).is_ok() {
            bail!(errors::coded(
                CODE_METHOD_FAILED,
                "vault key file is unreadable",
            ));
        }
        let mut key = [0u8; KEY_BYTES];
        fill_random(&mut key);
        let protected = self
            .protector
            .protect(&key)
            .map_err(|error| errors::coded(CODE_METHOD_FAILED, format!("{error:#}")))?;
        let envelope = KeyEnvelope {
            version: ENVELOPE_VERSION,
            protected_key: base64_encode(&protected),
        };
        write_private_file(
            &key_path,
            serde_json::to_vec_pretty(&envelope).context("encode vault key envelope")?,
        )?;
        Ok(key)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultEnvelope {
    version: u32,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyEnvelope {
    version: u32,
    protected_key: String,
}

fn key_file_for(vault_path: &Path) -> PathBuf {
    let mut name = vault_path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    name.push(KEY_FILE_SUFFIX);
    vault_path.with_file_name(name)
}

fn validate_vault_path(raw: &str) -> Result<PathBuf> {
    if raw.is_empty() || raw.chars().count() > MAX_PATH_LENGTH {
        bail!(errors::coded(
            CODE_INVALID_PARAMS,
            "vault path is missing or too long",
        ));
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        bail!(errors::coded(
            CODE_INVALID_PARAMS,
            "vault path must be absolute",
        ));
    }
    Ok(path)
}

fn validate_entry_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 128 || id.chars().any(|c| c.is_control()) {
        bail!(errors::coded(
            CODE_INVALID_PARAMS,
            "vault entry id is missing or malformed",
        ));
    }
    Ok(())
}

fn validate_input(input: &VaultEntryInput) -> Result<()> {
    let title = input.title.trim();
    if title.is_empty() {
        bail!(errors::coded(
            CODE_INVALID_PARAMS,
            "vault entry title is required",
        ));
    }
    field(title, "title", MAX_TITLE_CHARS, false)?;
    field(&input.username, "username", MAX_USERNAME_CHARS, false)?;
    field(&input.url, "url", MAX_URL_CHARS, false)?;
    field(&input.notes, "notes", MAX_NOTES_CHARS, true)?;
    field(&input.secret, "secret", MAX_SECRET_CHARS, true)?;
    Ok(())
}

fn field(value: &str, label: &str, max_chars: usize, multiline: bool) -> Result<()> {
    if value.chars().count() > max_chars {
        bail!(errors::coded(
            CODE_INVALID_PARAMS,
            format!("vault entry {label} exceeds {max_chars} characters"),
        ));
    }
    if value.contains('\0') {
        bail!(errors::coded(
            CODE_INVALID_PARAMS,
            format!("vault entry {label} must not contain NUL"),
        ));
    }
    if !multiline && value.chars().any(|c| c.is_control()) {
        bail!(errors::coded(
            CODE_INVALID_PARAMS,
            format!("vault entry {label} must be a single line"),
        ));
    }
    Ok(())
}

fn key_from_bytes(bytes: Vec<u8>) -> Result<[u8; KEY_BYTES]> {
    let array: [u8; KEY_BYTES] = bytes
        .try_into()
        .map_err(|_| errors::coded(CODE_METHOD_FAILED, "vault key has the wrong length"))?;
    Ok(array)
}

fn encrypt(key: &[u8; KEY_BYTES], nonce: &[u8; NONCE_BYTES], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| anyhow::anyhow!("vault key rejected"))?;
    cipher
        .encrypt(Nonce::from_slice(nonce), plaintext)
        .map_err(|_| anyhow::anyhow!("vault encryption failed"))
}

fn decrypt(
    key: &[u8; KEY_BYTES],
    nonce: &[u8; NONCE_BYTES],
    ciphertext: &[u8],
) -> std::result::Result<Vec<u8>, ()> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ())?;
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| ())
}

fn decode_component(value: &str, expected_len: usize, label: &str) -> Result<Vec<u8>> {
    let bytes = base64_decode(value, label)?;
    if bytes.len() != expected_len {
        bail!(errors::coded(
            CODE_METHOD_FAILED,
            format!("{label} has the wrong length"),
        ));
    }
    Ok(bytes)
}

fn base64_decode(value: &str, label: &str) -> Result<Vec<u8>> {
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .with_context(|| format!("decode {label}"))
        .map_err(|error| errors::coded(CODE_METHOD_FAILED, format!("{error:#}")))
}

fn base64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn fill_random(buffer: &mut [u8]) {
    use rand::RngCore;
    rand::rng().fill_bytes(buffer);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn write_private_file(path: &Path, bytes: Vec<u8>) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create vault directory {}", parent.display()))?;
    }
    let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
    write_private(&temp, &bytes).map_err(|error| {
        errors::coded(
            CODE_METHOD_FAILED,
            format!("write vault file {}: {error}", path.display()),
        )
    })?;
    std::fs::rename(&temp, path).map_err(|error| {
        errors::coded(
            CODE_METHOD_FAILED,
            format!("commit vault file {}: {error}", path.display()),
        )
    })
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A deterministic XOR pad keeps tests platform-independent: the DPAPI
    /// roundtrip itself is covered separately on Windows.
    struct TestProtector;

    const PAD: [u8; KEY_BYTES] = [0xA5u8; KEY_BYTES];

    impl KeyProtector for TestProtector {
        fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
            Ok(plaintext.iter().zip(PAD).map(|(b, p)| b ^ p).collect())
        }

        fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>> {
            Ok(protected.iter().zip(PAD).map(|(b, p)| b ^ p).collect())
        }
    }

    fn registry() -> VaultRegistry {
        VaultRegistry::new(Box::new(TestProtector))
    }

    fn temp_vault(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nd-vault-{label}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("vault.ndvault")
    }

    fn input(title: &str, secret: &str) -> VaultEntryInput {
        VaultEntryInput {
            title: title.to_string(),
            username: "user@example.com".to_string(),
            url: "https://example.com".to_string(),
            notes: String::new(),
            secret: secret.to_string(),
        }
    }

    #[test]
    fn key_file_sits_beside_the_vault() {
        let vault = PathBuf::from("/data/vault.ndvault");
        assert_eq!(
            key_file_for(&vault),
            PathBuf::from("/data/vault.ndvault.key")
        );
    }

    #[test]
    fn create_list_get_update_delete_roundtrip() {
        let registry = registry();
        let vault = temp_vault("roundtrip");

        let created = registry
            .create(VaultWriteParams {
                vault_path: vault.to_string_lossy().into_owned(),
                entry: input("Mail", "s3cret-value"),
            })
            .unwrap()
            .entry;
        assert!(!created.id.is_empty());
        assert!(created.created_at > 0);

        let listed = registry
            .list(VaultListParams {
                vault_path: vault.to_string_lossy().into_owned(),
                query: None,
            })
            .unwrap();
        assert_eq!(listed.total, 1);
        assert_eq!(listed.entries.len(), 1);
        let summary = &listed.entries[0];
        assert_eq!(summary.title, "Mail");
        assert_eq!(summary.id, created.id);

        let fetched = registry
            .get(VaultIdParams {
                vault_path: vault.to_string_lossy().into_owned(),
                id: created.id.clone(),
            })
            .unwrap()
            .entry;
        assert_eq!(fetched.secret, "s3cret-value");

        let updated = registry
            .update(VaultUpdateParams {
                vault_path: vault.to_string_lossy().into_owned(),
                id: created.id.clone(),
                entry: input("Mail renamed", "s3cret-value-2"),
            })
            .unwrap()
            .entry;
        assert_eq!(updated.title, "Mail renamed");
        assert_eq!(updated.secret, "s3cret-value-2");
        assert_eq!(updated.created_at, created.created_at);
        assert!(updated.updated_at >= created.updated_at);

        let deleted = registry
            .delete(VaultIdParams {
                vault_path: vault.to_string_lossy().into_owned(),
                id: created.id.clone(),
            })
            .unwrap();
        assert!(deleted.deleted);
        let error = registry
            .get(VaultIdParams {
                vault_path: vault.to_string_lossy().into_owned(),
                id: created.id,
            })
            .unwrap_err();
        assert_eq!(errors::code_of(&error), errors::CODE_NOT_FOUND);
    }

    #[test]
    fn list_results_never_carry_secrets() {
        let registry = registry();
        let vault = temp_vault("summary");
        let created = registry
            .create(VaultWriteParams {
                vault_path: vault.to_string_lossy().into_owned(),
                entry: input("Mail", "s3cret-value"),
            })
            .unwrap()
            .entry;
        let json = serde_json::to_string(
            &registry
                .list(VaultListParams {
                    vault_path: vault.to_string_lossy().into_owned(),
                    query: None,
                })
                .unwrap(),
        )
        .unwrap();
        assert!(!json.contains("s3cret-value"));
        assert!(json.contains(&created.id));
    }

    #[test]
    fn search_matches_title_username_and_url_case_insensitively() {
        let registry = registry();
        let vault = temp_vault("search");
        for title in ["Mail", "Code Host"] {
            registry
                .create(VaultWriteParams {
                    vault_path: vault.to_string_lossy().into_owned(),
                    entry: input(title, "x"),
                })
                .unwrap();
        }
        let rows = |query: &str| {
            registry
                .list(VaultListParams {
                    vault_path: vault.to_string_lossy().into_owned(),
                    query: Some(query.to_string()),
                })
                .unwrap()
                .entries
                .len()
        };
        assert_eq!(rows("MAIL"), 1);
        assert_eq!(rows("example.com"), 2);
        assert_eq!(rows("nomatch"), 0);
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let registry = registry();
        let vault = temp_vault("tamper");
        registry
            .create(VaultWriteParams {
                vault_path: vault.to_string_lossy().into_owned(),
                entry: input("Mail", "s3cret-value"),
            })
            .unwrap();

        let mut bytes = std::fs::read(&vault).unwrap();
        let text = String::from_utf8(bytes.clone()).unwrap();
        let marker = "\"ciphertext\": \"";
        let start = text.find(marker).unwrap() + marker.len();
        // Flip one character in the middle of the base64 payload.
        let flip = start + 8;
        let flipped = if bytes[flip] == b'A' { b'B' } else { b'A' };
        bytes[flip] = flipped;
        std::fs::write(&vault, bytes).unwrap();
        let _ = text;

        let error = registry
            .list(VaultListParams {
                vault_path: vault.to_string_lossy().into_owned(),
                query: None,
            })
            .unwrap_err();
        assert_eq!(errors::code_of(&error), CODE_METHOD_FAILED);
        assert!(format!("{error:#}").contains("cannot be decrypted"));
    }

    #[test]
    fn wrong_key_cannot_read_the_vault() {
        let vault = temp_vault("wrong-key");
        registry()
            .create(VaultWriteParams {
                vault_path: vault.to_string_lossy().into_owned(),
                entry: input("Mail", "s3cret-value"),
            })
            .unwrap();

        struct OtherProtector;
        impl KeyProtector for OtherProtector {
            fn protect(&self, plaintext: &[u8]) -> Result<Vec<u8>> {
                Ok(plaintext.iter().map(|b| b ^ 0x5A).collect())
            }

            fn unprotect(&self, protected: &[u8]) -> Result<Vec<u8>> {
                Ok(protected.iter().map(|b| b ^ 0x5A).collect())
            }
        }
        let error = VaultRegistry::new(Box::new(OtherProtector))
            .list(VaultListParams {
                vault_path: vault.to_string_lossy().into_owned(),
                query: None,
            })
            .unwrap_err();
        assert_eq!(errors::code_of(&error), CODE_METHOD_FAILED);
    }

    #[test]
    fn input_validation_rejects_oversize_and_control_fields() {
        let registry = registry();
        let vault = temp_vault("validation");

        let mut long_title = "a".repeat(MAX_TITLE_CHARS + 1);
        let error = registry
            .create(VaultWriteParams {
                vault_path: vault.to_string_lossy().into_owned(),
                entry: VaultEntryInput {
                    title: std::mem::take(&mut long_title),
                    username: String::new(),
                    url: String::new(),
                    notes: String::new(),
                    secret: String::new(),
                },
            })
            .unwrap_err();
        assert_eq!(errors::code_of(&error), CODE_INVALID_PARAMS);

        let error = registry
            .create(VaultWriteParams {
                vault_path: vault.to_string_lossy().into_owned(),
                entry: VaultEntryInput {
                    title: "bad\nmultiline".to_string(),
                    username: String::new(),
                    url: String::new(),
                    notes: String::new(),
                    secret: String::new(),
                },
            })
            .unwrap_err();
        assert!(format!("{error:#}").contains("single line"));

        let error = registry
            .create(VaultWriteParams {
                vault_path: vault.to_string_lossy().into_owned(),
                entry: VaultEntryInput {
                    title: String::new(),
                    username: String::new(),
                    url: String::new(),
                    notes: String::new(),
                    secret: String::new(),
                },
            })
            .unwrap_err();
        assert!(format!("{error:#}").contains("title"));

        let mut long_secret = "x".repeat(MAX_SECRET_CHARS + 1);
        let error = registry
            .create(VaultWriteParams {
                vault_path: vault.to_string_lossy().into_owned(),
                entry: VaultEntryInput {
                    title: "ok".to_string(),
                    username: String::new(),
                    url: String::new(),
                    notes: String::new(),
                    secret: std::mem::take(&mut long_secret),
                },
            })
            .unwrap_err();
        assert_eq!(errors::code_of(&error), CODE_INVALID_PARAMS);
    }

    #[test]
    fn entry_cap_is_enforced() {
        let registry = registry();
        let vault = temp_vault("cap");
        // Fill the vault directly so the test does not run 500 load/save cycles.
        let now = now_ms();
        let entries: Vec<VaultEntry> = (0..MAX_ENTRIES)
            .map(|index| VaultEntry {
                id: uuid::Uuid::new_v4().to_string(),
                title: format!("entry-{index}"),
                username: String::new(),
                url: String::new(),
                notes: String::new(),
                secret: String::new(),
                created_at: now,
                updated_at: now,
            })
            .collect();
        registry.save_entries(&vault, &entries).unwrap();

        let error = registry
            .create(VaultWriteParams {
                vault_path: vault.to_string_lossy().into_owned(),
                entry: input("one too many", "x"),
            })
            .unwrap_err();
        assert_eq!(errors::code_of(&error), CODE_INVALID_PARAMS);
        assert!(format!("{error:#}").contains("maximum"));
    }

    #[test]
    fn relative_vault_paths_are_rejected() {
        let error = registry()
            .list(VaultListParams {
                vault_path: "relative/vault.ndvault".to_string(),
                query: None,
            })
            .unwrap_err();
        assert_eq!(errors::code_of(&error), CODE_INVALID_PARAMS);
    }

    #[test]
    fn key_survives_across_registries() {
        let vault = temp_vault("persist");
        let first = registry();
        let created = first
            .create(VaultWriteParams {
                vault_path: vault.to_string_lossy().into_owned(),
                entry: input("Mail", "s3cret-value"),
            })
            .unwrap()
            .entry;

        // A fresh registry (simulating a sidecar restart) reads the same key
        // file and decrypts the same vault.
        let second = registry();
        let fetched = second
            .get(VaultIdParams {
                vault_path: vault.to_string_lossy().into_owned(),
                id: created.id.clone(),
            })
            .unwrap()
            .entry;
        assert_eq!(fetched.secret, "s3cret-value");
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_roundtrip_recovers_plaintext() {
        let protector = platform_protector();
        let plaintext: Vec<u8> = (0..64u8).collect();
        let protected = protector.protect(&plaintext).unwrap();
        assert_ne!(protected, plaintext);
        assert_eq!(protector.unprotect(&protected).unwrap(), plaintext);
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_vault_works_end_to_end_on_windows() {
        let registry = VaultRegistry::new_platform();
        let vault = temp_vault("dpapi");
        let created = registry
            .create(VaultWriteParams {
                vault_path: vault.to_string_lossy().into_owned(),
                entry: input("Mail", "s3cret-value"),
            })
            .unwrap()
            .entry;
        let fetched = registry
            .get(VaultIdParams {
                vault_path: vault.to_string_lossy().into_owned(),
                id: created.id,
            })
            .unwrap()
            .entry;
        assert_eq!(fetched.secret, "s3cret-value");
    }
}
