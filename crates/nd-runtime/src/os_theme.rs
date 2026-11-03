//! Windows light/dark theme, written straight to the per-user `Personalize` key.
//!
//! Windows 11 exposes no user-facing custom schedule for the system theme, so the
//! desktop owns the schedule and this module is only the apply step: an in-process
//! registry write plus the broadcast that makes Explorer repaint immediately. That
//! replaces what would otherwise be a `reg.exe` spawn per change, and it works with
//! no third-party software installed.
//!
//! HKCU only, so no elevation is requested and none is needed.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

/// One of the two themes Windows stores per user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
}

impl ThemeMode {
    /// The `*UseLightTheme` DWORD convention: light is 1, dark is 0.
    fn light_flag(self) -> u32 {
        match self {
            ThemeMode::Light => 1,
            ThemeMode::Dark => 0,
        }
    }

    /// Anything nonzero reads back as light. Windows stores 1 and treats other
    /// values as "not dark" rather than failing, so ND does the same instead of
    /// inventing a third state.
    fn from_light_flag(value: u32) -> Self {
        if value == 0 {
            ThemeMode::Dark
        } else {
            ThemeMode::Light
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum ThemeState {
    Available {
        available: bool,
        apps_theme: ThemeMode,
        system_theme: ThemeMode,
        platform: String,
    },
    Unavailable {
        available: bool,
        reason: String,
        platform: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ThemeSetParams {
    pub theme: ThemeMode,
    /// Which of the two DWORDs to write. Both default to on so a caller that only
    /// says "go dark" gets the whole desktop; targeting neither is an error.
    #[serde(default = "default_target")]
    pub apps: bool,
    #[serde(default = "default_target")]
    pub system: bool,
}

fn default_target() -> bool {
    true
}

impl ThemeSetParams {
    fn validate(&self) -> Result<()> {
        if !self.apps && !self.system {
            bail!("theme update must target apps or system");
        }
        Ok(())
    }
}

fn unavailable(reason: String) -> ThemeState {
    ThemeState::Unavailable {
        available: false,
        reason,
        platform: std::env::consts::OS.into(),
    }
}

/// Reads the current theme. Never fails: a host that cannot answer returns
/// `available: false` with a reason the UI can render, so the extension can show
/// an honest state instead of a dead control.
pub fn get() -> ThemeState {
    match platform::read() {
        Ok((apps, system)) => ThemeState::Available {
            available: true,
            apps_theme: apps,
            system_theme: system,
            platform: std::env::consts::OS.into(),
        },
        Err(reason) => unavailable(reason),
    }
}

pub fn set(params: ThemeSetParams) -> Result<ThemeState> {
    // Validate before touching the registry, including on unsupported hosts, so a
    // malformed request is rejected identically everywhere.
    params.validate()?;
    platform::apply(&params)
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_DWORD, REG_VALUE_TYPE,
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
    };

    const PERSONALIZE_SUBKEY: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    const APPS_VALUE: &str = "AppsUseLightTheme";
    const SYSTEM_VALUE: &str = "SystemUsesLightTheme";

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// RAII guard, so an early `?` can never leak the registry handle.
    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { RegCloseKey(self.0) };
            }
        }
    }

    fn open(sam: u32) -> Result<Key> {
        let subkey = wide(PERSONALIZE_SUBKEY);
        let mut handle: HKEY = std::ptr::null_mut();
        let status =
            unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, sam, &mut handle) };
        if status != ERROR_SUCCESS || handle.is_null() {
            bail!(
                "Windows would not open the theme key (code {status}); it may be locked by an \
                 organization policy"
            );
        }
        Ok(Key(handle))
    }

    fn read_dword(key: HKEY, name: &str) -> Result<u32> {
        let wide_name = wide(name);
        let mut kind: REG_VALUE_TYPE = 0;
        let mut data: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            RegQueryValueExW(
                key,
                wide_name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                (&mut data as *mut u32).cast::<u8>(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            bail!("Windows did not report a theme value for {name} (code {status})");
        }
        if kind != REG_DWORD || size != std::mem::size_of::<u32>() as u32 {
            bail!("the Windows theme value {name} is not a 32-bit DWORD");
        }
        Ok(data)
    }

    fn write_dword(key: HKEY, name: &str, value: u32) -> Result<()> {
        let wide_name = wide(name);
        let status = unsafe {
            RegSetValueExW(
                key,
                wide_name.as_ptr(),
                0,
                REG_DWORD,
                (&value as *const u32).cast::<u8>(),
                std::mem::size_of::<u32>() as u32,
            )
        };
        if status != ERROR_SUCCESS {
            bail!(
                "Windows refused to store the theme value {name} (code {status}); it may be \
                 locked by an organization policy"
            );
        }
        Ok(())
    }

    /// Explorer repaints only for a `WM_SETTINGCHANGE` whose `lParam` names
    /// `ImmersiveColorSet`; a generic broadcast leaves the taskbar stale until the
    /// next sign-in.
    fn broadcast_theme_change() {
        let param = wide("ImmersiveColorSet");
        let mut result: usize = 0;
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                param.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                1000,
                &mut result,
            );
        }
        // The return value is deliberately ignored: individual top-level windows
        // time out even when the theme did apply, and the registry is the source
        // of truth that `read_dword` has just confirmed.
    }

    pub(super) fn read() -> Result<(ThemeMode, ThemeMode), String> {
        let key = open(KEY_QUERY_VALUE).map_err(|error| error.to_string())?;
        let apps = read_dword(key.0, APPS_VALUE).map_err(|error| error.to_string())?;
        let system = read_dword(key.0, SYSTEM_VALUE).map_err(|error| error.to_string())?;
        Ok((
            ThemeMode::from_light_flag(apps),
            ThemeMode::from_light_flag(system),
        ))
    }

    pub(super) fn apply(params: &ThemeSetParams) -> Result<ThemeState> {
        let key = open(KEY_QUERY_VALUE | KEY_SET_VALUE)?;
        let flag = params.theme.light_flag();
        if params.apps {
            write_dword(key.0, APPS_VALUE, flag)?;
        }
        if params.system {
            write_dword(key.0, SYSTEM_VALUE, flag)?;
        }
        // Read back what Windows actually stored rather than echoing the request:
        // a policy or a concurrent writer can leave the key holding something else.
        let apps = read_dword(key.0, APPS_VALUE)?;
        let system = read_dword(key.0, SYSTEM_VALUE)?;
        drop(key);
        broadcast_theme_change();
        Ok(ThemeState::Available {
            available: true,
            apps_theme: ThemeMode::from_light_flag(apps),
            system_theme: ThemeMode::from_light_flag(system),
            platform: std::env::consts::OS.into(),
        })
    }
}

/// A read that reports "unavailable" is honest, but a write that reports success
/// without changing anything is worse than a visible error, so this is a hard
/// failure rather than a silent no-op — the same call `media.rs` makes for
/// `apply_wallpaper`.
#[cfg(not(windows))]
mod platform {
    use super::*;

    pub(super) fn read() -> Result<(ThemeMode, ThemeMode), String> {
        Err("the Windows theme registry is unavailable on this platform".into())
    }

    pub(super) fn apply(_params: &ThemeSetParams) -> Result<ThemeState> {
        bail!("os.theme-set is implemented for Windows only")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(value: serde_json::Value) -> Result<ThemeSetParams> {
        Ok(serde_json::from_value(value)?)
    }

    #[test]
    fn wire_state_uses_boolean_availability_and_camel_case() {
        let value = serde_json::to_value(ThemeState::Available {
            available: true,
            apps_theme: ThemeMode::Dark,
            system_theme: ThemeMode::Light,
            platform: "windows".into(),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "available": true,
                "appsTheme": "dark",
                "systemTheme": "light",
                "platform": "windows"
            })
        );
        assert_eq!(
            serde_json::to_value(unavailable("no key".into())).unwrap()["available"],
            false
        );
    }

    #[test]
    fn light_flag_follows_the_windows_dword_convention() {
        assert_eq!(ThemeMode::Light.light_flag(), 1);
        assert_eq!(ThemeMode::Dark.light_flag(), 0);
        assert_eq!(ThemeMode::from_light_flag(1), ThemeMode::Light);
        assert_eq!(ThemeMode::from_light_flag(0), ThemeMode::Dark);
        assert_eq!(ThemeMode::from_light_flag(7), ThemeMode::Light);
    }

    #[test]
    fn omitted_targets_default_to_both() {
        let both = params(serde_json::json!({"theme": "light"})).unwrap();
        assert!(both.apps && both.system);
        assert!(both.validate().is_ok());

        let apps_only = params(serde_json::json!({"theme": "dark", "system": false})).unwrap();
        assert!(apps_only.apps && !apps_only.system);
        assert!(apps_only.validate().is_ok());
    }

    #[test]
    fn malformed_updates_never_reach_the_platform() {
        // `theme` is required, unknown fields are rejected, and targeting nothing
        // is a validation error rather than a silent success. Each of these must
        // fail identically on every platform, which is why `set` validates first.
        assert!(params(serde_json::json!({})).is_err());
        assert!(params(serde_json::json!({"theme": "sepia"})).is_err());
        assert!(params(serde_json::json!({"theme": "dark", "bogus": 1})).is_err());

        let nothing =
            params(serde_json::json!({"theme": "dark", "apps": false, "system": false})).unwrap();
        assert!(nothing.validate().is_err());
        assert!(set(nothing).is_err());
    }

    #[test]
    fn get_never_fails_and_set_reports_availability() {
        // Whatever the host, `get` yields a renderable state and `set` of a valid
        // request either succeeds or errors loudly — never a silent no-op.
        let state = serde_json::to_value(get()).unwrap();
        assert!(state.get("available").is_some());
        assert!(state.get("platform").is_some());
        if state["available"] == serde_json::json!(false) {
            assert!(state.get("reason").is_some());
        }
        // The success path is deliberately NOT asserted: it would change the
        // developer's real desktop theme on every `cargo test`.
        if cfg!(windows) {
            assert!(get_or_error_is_consistent());
        }
    }

    #[cfg(windows)]
    fn get_or_error_is_consistent() -> bool {
        // On Windows a healthy host reads both DWORDs; a locked host returns a
        // reason. Both are acceptable, but the shape must not be half-populated.
        match get() {
            ThemeState::Available {
                available,
                platform,
                ..
            } => available && platform == "windows",
            ThemeState::Unavailable {
                available, reason, ..
            } => !available && !reason.is_empty(),
        }
    }
}
