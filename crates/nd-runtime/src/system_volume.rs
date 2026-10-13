//! Default-device master volume, independent of any now-playing session.
//! Native handles are resolved for every request so changing output devices
//! never leaves the launcher controlling a stale endpoint.

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum VolumeState {
    Available {
        available: bool,
        level: f32,
        muted: bool,
        can_mute: bool,
    },
    Unavailable {
        available: bool,
        reason: String,
    },
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VolumeUpdate {
    pub level: Option<f32>,
    pub muted: Option<bool>,
}

impl VolumeUpdate {
    fn validate(&self) -> Result<()> {
        if self.level.is_none() && self.muted.is_none() {
            bail!("volume update must contain level or muted");
        }
        if self
            .level
            .is_some_and(|level| !level.is_finite() || !(0.0..=100.0).contains(&level))
        {
            bail!("volume level must be between 0 and 100");
        }
        Ok(())
    }
}

fn unavailable() -> VolumeState {
    VolumeState::Unavailable {
        available: false,
        reason: "System volume is unavailable for this output device".into(),
    }
}

pub fn state() -> VolumeState {
    platform::access(None).unwrap_or_else(|_| unavailable())
}

pub fn set(update: VolumeUpdate) -> Result<VolumeState> {
    // Validate before touching native audio, including on unsupported hosts.
    update.validate()?;
    Ok(platform::access(Some(update)).unwrap_or_else(|_| unavailable()))
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        IMMDeviceEnumerator, MMDeviceEnumerator, eMultimedia, eRender,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
    };

    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    pub(super) fn access(update: Option<VolumeUpdate>) -> Result<VolumeState> {
        // Dispatcher workers are plain Rust threads. Balance COM initialization
        // after the endpoint interfaces drop, even on errors.
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
        let _apartment = Apartment;
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eMultimedia)?;
            let volume: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
            if let Some(update) = update {
                if let Some(level) = update.level {
                    volume.SetMasterVolumeLevelScalar(level / 100.0, std::ptr::null())?;
                }
                if let Some(muted) = update.muted {
                    volume.SetMute(muted, std::ptr::null())?;
                }
            }
            Ok(VolumeState::Available {
                available: true,
                level: volume.GetMasterVolumeLevelScalar()?.clamp(0.0, 1.0) * 100.0,
                muted: volume.GetMute()?.as_bool(),
                can_mute: true,
            })
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::ffi::c_void;
    use std::mem::size_of;

    #[repr(C)]
    struct Address {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[link(name = "CoreAudio", kind = "framework")]
    unsafe extern "C" {
        fn AudioObjectHasProperty(object: u32, address: *const Address) -> u8;
        fn AudioObjectIsPropertySettable(
            object: u32,
            address: *const Address,
            settable: *mut u8,
        ) -> i32;
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: *mut u32,
            data: *mut c_void,
        ) -> i32;
        fn AudioObjectSetPropertyData(
            object: u32,
            address: *const Address,
            qualifier_size: u32,
            qualifier: *const c_void,
            size: u32,
            data: *const c_void,
        ) -> i32;
    }

    const GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    const OUTPUT: u32 = u32::from_be_bytes(*b"outp");
    const VOLUME: u32 = u32::from_be_bytes(*b"volm");
    const MUTE: u32 = u32::from_be_bytes(*b"mute");

    fn read<T: Default>(object: u32, address: &Address) -> Result<T> {
        let mut value = T::default();
        let mut size = size_of::<T>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                object,
                address,
                0,
                std::ptr::null(),
                &mut size,
                (&mut value as *mut T).cast(),
            )
        };
        if status != 0 || size != size_of::<T>() as u32 {
            bail!("CoreAudio property read failed: {status}");
        }
        Ok(value)
    }

    fn write<T>(object: u32, address: &Address, value: T) -> Result<()> {
        let status = unsafe {
            AudioObjectSetPropertyData(
                object,
                address,
                0,
                std::ptr::null(),
                size_of::<T>() as u32,
                (&value as *const T).cast(),
            )
        };
        if status != 0 {
            bail!("CoreAudio property write failed: {status}");
        }
        Ok(())
    }

    fn controls(device: u32, selector: u32) -> Vec<Address> {
        let address = |element| Address {
            selector,
            scope: OUTPUT,
            element,
        };
        let writable = |address: &Address| {
            let mut settable = 0u8;
            unsafe {
                AudioObjectHasProperty(device, address) != 0
                    && AudioObjectIsPropertySettable(device, address, &mut settable) == 0
                    && settable != 0
            }
        };
        let master = address(0);
        if writable(&master) {
            return vec![master];
        }
        // Built-in and USB devices can expose channel controls instead of a
        // master control. Use their declared stereo channels, preserving balance
        // when moving the slider (see access).
        let channels = read::<[u32; 2]>(
            device,
            &Address {
                selector: u32::from_be_bytes(*b"dch2"),
                scope: OUTPUT,
                element: 0,
            },
        )
        .unwrap_or([1, 2]);
        let mut elements = channels
            .into_iter()
            .filter(|channel| *channel != 0)
            .collect::<Vec<_>>();
        elements.sort_unstable();
        elements.dedup();
        elements.into_iter().map(address).filter(writable).collect()
    }

    pub(super) fn access(update: Option<VolumeUpdate>) -> Result<VolumeState> {
        let device = read::<u32>(
            1,
            &Address {
                selector: u32::from_be_bytes(*b"dOut"),
                scope: GLOBAL,
                element: 0,
            },
        )?;
        if device == 0 {
            bail!("no output device");
        }
        let volumes = controls(device, VOLUME);
        if volumes.is_empty() {
            bail!("output device has fixed volume");
        }
        let mutes = controls(device, MUTE);
        let levels = volumes
            .iter()
            .map(|a| read::<f32>(device, a))
            .collect::<Result<Vec<_>>>()?;
        if let Some(update) = update {
            if update.muted.is_some() && mutes.is_empty() {
                bail!("output device has no mute control");
            }
            if let Some(level) = update.level {
                let current = levels.iter().copied().fold(0.0f32, f32::max);
                for (address, old_level) in volumes.iter().zip(levels) {
                    let balance = if current > 0.0 {
                        old_level / current
                    } else {
                        1.0
                    };
                    write(device, address, (level / 100.0 * balance).clamp(0.0, 1.0))?;
                }
            }
            if let Some(muted) = update.muted {
                for address in &mutes {
                    write(device, address, u32::from(muted))?;
                }
            }
        }
        let level = volumes
            .iter()
            .map(|a| read::<f32>(device, a))
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .fold(0.0f32, f32::max)
            .clamp(0.0, 1.0)
            * 100.0;
        let muted = !mutes.is_empty()
            && mutes
                .iter()
                .map(|a| read::<u32>(device, a))
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .all(|value| value != 0);
        Ok(VolumeState::Available {
            available: true,
            level,
            muted,
            can_mute: !mutes.is_empty(),
        })
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use super::*;
    pub(super) fn access(_update: Option<VolumeUpdate>) -> Result<VolumeState> {
        bail!("native system volume is unsupported on this platform")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_state_uses_boolean_availability_and_camel_case() {
        let value = serde_json::to_value(VolumeState::Available {
            available: true,
            level: 42.0,
            muted: false,
            can_mute: true,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"available": true, "level": 42.0, "muted": false, "canMute": true})
        );
        assert_eq!(
            serde_json::to_value(unavailable()).unwrap()["available"],
            false
        );
    }

    #[test]
    fn invalid_updates_never_touch_the_output_device() {
        for level in [f32::NAN, f32::INFINITY, -1.0, 100.1] {
            assert!(
                set(VolumeUpdate {
                    level: Some(level),
                    muted: None
                })
                .is_err()
            );
        }
        assert!(set(VolumeUpdate::default()).is_err());
        assert!(
            serde_json::from_value::<VolumeUpdate>(serde_json::json!({"command": "mute"})).is_err()
        );
        assert!(
            VolumeUpdate {
                level: Some(0.0),
                muted: Some(true)
            }
            .validate()
            .is_ok()
        );
        assert!(
            VolumeUpdate {
                level: Some(100.0),
                muted: None
            }
            .validate()
            .is_ok()
        );
    }
}
