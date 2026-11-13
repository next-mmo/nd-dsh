//! Keyboard injection for the Phone Keyboard extension: a paired phone types
//! into the focused Windows app. Text goes through `SendInput` with
//! `KEYEVENTF_UNICODE` so Khmer (U+1780–U+17FF) and every other BMP/astral
//! character arrive as real Unicode, not scan-code approximations. Named keys
//! (Enter, Backspace, arrows…) are virtual-key presses. Injection lives here
//! once, in the sidecar; the desktop never synthesizes input itself.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

/// One WS message from the phone is capped at 2,000 chars by the desktop
/// service; this leaves headroom while keeping a single `SendInput` batch
/// bounded (2 UTF-16 units per char, down+up per unit).
const MAX_TEXT_CHARS: usize = 4_096;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputTextParams {
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputTextResult {
    pub sent: bool,
    pub units: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InputKeyParams {
    pub key: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputKeyResult {
    pub sent: bool,
}

/// Named keys the phone page may send. Returns the virtual key and whether it
/// is an extended key (navigation cluster needs `KEYEVENTF_EXTENDEDKEY`).
pub fn key_vk(name: &str) -> Option<(u16, bool)> {
    let (vk, extended) = match name {
        "enter" => (0x0Du16, false),
        "backspace" => (0x08, false),
        "tab" => (0x09, false),
        "escape" => (0x1B, false),
        "delete" => (0x2E, true),
        "home" => (0x24, true),
        "end" => (0x23, true),
        "left" => (0x25, true),
        "up" => (0x26, true),
        "right" => (0x27, true),
        "down" => (0x28, true),
        _ => return None,
    };
    Some((vk, extended))
}

pub fn validate_text(text: &str) -> Result<()> {
    if text.is_empty() {
        bail!("input.text requires non-empty text");
    }
    if text.chars().count() > MAX_TEXT_CHARS {
        bail!("input.text exceeds {MAX_TEXT_CHARS} characters");
    }
    Ok(())
}

pub fn text_units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

pub fn send_text(params: InputTextParams) -> Result<InputTextResult> {
    validate_text(&params.text)?;
    let units = text_units(&params.text);
    inject_units(&units)?;
    Ok(InputTextResult { sent: true, units: units.len() })
}

pub fn send_key(params: InputKeyParams) -> Result<InputKeyResult> {
    let (vk, extended) = key_vk(&params.key)
        .ok_or_else(|| anyhow::anyhow!("unknown input key: {}", params.key))?;
    press_key(vk, extended)?;
    Ok(InputKeyResult { sent: true })
}

#[cfg(windows)]
fn inject_units(units: &[u16]) -> Result<()> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, SendInput,
    };

    let mut inputs: Vec<INPUT> = Vec::with_capacity(units.len() * 2);
    for &unit in units {
        for flags in [KEYEVENTF_UNICODE, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP] {
            inputs.push(INPUT {
                r#type: INPUT_KEYBOARD,
                Anonymous: INPUT_0 {
                    ki: KEYBDINPUT { wVk: 0, wScan: unit, dwFlags: flags, time: 0, dwExtraInfo: 0 },
                },
            });
        }
    }
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if sent as usize != inputs.len() {
        bail!("SendInput inserted {sent} of {} events", inputs.len());
    }
    Ok(())
}

#[cfg(windows)]
fn press_key(vk: u16, extended: bool) -> Result<()> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
        SendInput,
    };

    let base = if extended { KEYEVENTF_EXTENDEDKEY } else { 0 };
    let inputs = [
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: base, time: 0, dwExtraInfo: 0 },
            },
        },
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: base | KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        },
    ];
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            std::mem::size_of::<INPUT>() as i32,
        )
    };
    if sent != inputs.len() as u32 {
        bail!("SendInput inserted {sent} of {} events", inputs.len());
    }
    Ok(())
}

#[cfg(not(windows))]
fn inject_units(_units: &[u16]) -> Result<()> {
    bail!("input.text is implemented for Windows only")
}

#[cfg(not(windows))]
fn press_key(_vk: u16, _extended: bool) -> Result<()> {
    bail!("input.key is implemented for Windows only")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_named_key_and_rejects_unknown() {
        for name in [
            "enter", "backspace", "tab", "escape", "delete", "home", "end", "left", "up", "right",
            "down",
        ] {
            assert!(key_vk(name).is_some(), "{name} must map");
        }
        assert_eq!(key_vk("enter"), Some((0x0D, false)));
        assert_eq!(key_vk("left"), Some((0x25, true)));
        assert!(key_vk("ctrl+c").is_none());
        assert!(key_vk("").is_none());
    }

    #[test]
    fn encodes_khmer_and_astral_text_as_utf16() {
        assert_eq!(text_units("AB"), vec![0x41, 0x42]);
        // Khmer "សួស្តី" is BMP: one unit per char.
        let khmer = "សួស្តី";
        assert_eq!(text_units(khmer).len(), khmer.chars().count());
        // Astral emoji become a surrogate pair.
        assert_eq!(text_units("😀"), vec![0xD83D, 0xDE00]);
    }

    #[test]
    fn validates_text_bounds() {
        assert!(validate_text("").is_err());
        assert!(validate_text("ok").is_ok());
        let long = "k".repeat(MAX_TEXT_CHARS + 1);
        assert!(validate_text(&long).is_err());
        let edge = "k".repeat(MAX_TEXT_CHARS);
        assert!(validate_text(&edge).is_ok());
    }
}