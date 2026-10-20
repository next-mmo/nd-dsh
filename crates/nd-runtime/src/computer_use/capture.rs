use std::ffi::c_void;
use std::mem::size_of;
use std::ptr::null_mut;

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{ExtendedColorType, RgbImage};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CreateCompatibleDC, CreateDIBSection,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GetWindowDC, HDC, HGDIOBJ, ReleaseDC, SRCCOPY,
    SelectObject,
};
use windows_sys::Win32::Storage::Xps::PrintWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    IsHungAppWindow, IsIconic, PW_RENDERFULLCONTENT,
};

use super::types::{
    CaptureFailure, CapturedImage, MAX_SCREENSHOT_BYTES, MAX_SCREENSHOT_WIDTH, Rect,
};

const MAX_CAPTURE_PIXELS: i64 = 32_000_000;

struct Dc(HDC);

impl Drop for Dc {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                DeleteDC(self.0);
            }
        }
    }
}

struct Bitmap(HGDIOBJ);

impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            if !self.0.is_null() {
                DeleteObject(self.0);
            }
        }
    }
}

pub fn capture_window(hwnd: isize, rect: &Rect) -> Result<CapturedImage, CaptureFailure> {
    if rect.width <= 0 || rect.height <= 0 {
        return Err(CaptureFailure::Unavailable("inaccessible"));
    }
    if i64::from(rect.width) * i64::from(rect.height) > MAX_CAPTURE_PIXELS {
        return Err(CaptureFailure::Unavailable("too-large"));
    }
    let raw_hwnd = hwnd as HWND;
    unsafe {
        if IsIconic(raw_hwnd) != 0 {
            return Err(CaptureFailure::Unavailable("minimized"));
        }
        if IsHungAppWindow(raw_hwnd) != 0 {
            return Err(CaptureFailure::Unavailable("inaccessible"));
        }
    }

    let bgra =
        unsafe { grab_bgra(raw_hwnd, rect.width, rect.height) }.ok_or(CaptureFailure::Failed)?;
    let rgb = bgra_to_rgb(bgra, rect.width as u32, rect.height as u32)?;
    let (jpeg, width, height) =
        encode_bounded(rgb, rect.width as u32, rect.height as u32).ok_or(CaptureFailure::Failed)?;
    Ok(CapturedImage {
        jpeg,
        width,
        height,
        origin_x: rect.x,
        origin_y: rect.y,
    })
}

unsafe fn grab_bgra(hwnd: HWND, width: i32, height: i32) -> Option<Vec<u8>> {
    unsafe {
        let window_dc = GetWindowDC(hwnd);
        if window_dc.is_null() {
            return None;
        }
        let result = grab_bgra_inner(window_dc, hwnd, width, height);
        ReleaseDC(hwnd, window_dc);
        result
    }
}

unsafe fn grab_bgra_inner(window_dc: HDC, hwnd: HWND, width: i32, height: i32) -> Option<Vec<u8>> {
    unsafe {
        let memory_dc = CreateCompatibleDC(window_dc);
        if memory_dc.is_null() {
            return None;
        }
        let _memory_dc = Dc(memory_dc);

        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };
        let mut bits: *mut c_void = null_mut();
        let dib = CreateDIBSection(window_dc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0);
        if dib.is_null() || bits.is_null() {
            return None;
        }
        let _dib = Bitmap(dib as HGDIOBJ);
        let old = SelectObject(memory_dc, dib as HGDIOBJ);
        if old.is_null() {
            return None;
        }

        let length = (width as usize)
            .checked_mul(height as usize)?
            .checked_mul(4)?;
        let mut bytes;

        let printed = PrintWindow(hwnd, memory_dc, PW_RENDERFULLCONTENT) != 0;
        if printed {
            bytes = std::slice::from_raw_parts(bits as *const u8, length).to_vec();
            if !looks_blank(&bytes) {
                SelectObject(memory_dc, old);
                return Some(bytes);
            }
        }

        let copied = BitBlt(memory_dc, 0, 0, width, height, window_dc, 0, 0, SRCCOPY) != 0;
        if copied {
            bytes = std::slice::from_raw_parts(bits as *const u8, length).to_vec();
            SelectObject(memory_dc, old);
            if !looks_blank(&bytes) {
                return Some(bytes);
            }
        }

        SelectObject(memory_dc, old);
        None
    }
}

fn looks_blank(bgra: &[u8]) -> bool {
    if bgra.len() < 4 {
        return true;
    }
    // PrintWindow commonly fails to all-black or all-white. A legitimate
    // solid-color window (for example a gray editor background) is still a
    // usable screenshot, so only those two failure signatures count as blank.
    let first = [bgra[0], bgra[1], bgra[2]];
    if first != [0, 0, 0] && first != [255, 255, 255] {
        return false;
    }
    let pixel_count = bgra.len() / 4;
    let step = (pixel_count / 512).max(1);
    let mut index = 0;
    while index < pixel_count {
        let offset = index * 4;
        if bgra[offset..offset + 3] != first[..] {
            return false;
        }
        index += step;
    }
    true
}

fn bgra_to_rgb(bgra: Vec<u8>, width: u32, height: u32) -> Result<RgbImage, CaptureFailure> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .ok_or(CaptureFailure::Failed)?;
    if expected == 0 || bgra.len() != expected * 4 {
        return Err(CaptureFailure::Failed);
    }
    let mut rgb = Vec::with_capacity(expected * 3);
    for pixel in bgra.as_chunks::<4>().0 {
        rgb.push(pixel[2]);
        rgb.push(pixel[1]);
        rgb.push(pixel[0]);
    }
    RgbImage::from_raw(width, height, rgb).ok_or(CaptureFailure::Failed)
}

fn encode_bounded(
    mut image: RgbImage,
    mut width: u32,
    mut height: u32,
) -> Option<(Vec<u8>, u32, u32)> {
    if width > MAX_SCREENSHOT_WIDTH {
        let scaled_height =
            (u64::from(height) * u64::from(MAX_SCREENSHOT_WIDTH) / u64::from(width)).max(1) as u32;
        image = image::imageops::resize(
            &image,
            MAX_SCREENSHOT_WIDTH,
            scaled_height,
            FilterType::Triangle,
        );
        width = MAX_SCREENSHOT_WIDTH;
        height = scaled_height;
    }
    loop {
        for quality in [75, 65, 55, 45, 35] {
            let mut encoded = Vec::new();
            let mut encoder = JpegEncoder::new_with_quality(&mut encoded, quality);
            encoder
                .encode(image.as_raw(), width, height, ExtendedColorType::Rgb8)
                .ok()?;
            if encoded.len() <= MAX_SCREENSHOT_BYTES {
                return Some((encoded, width, height));
            }
        }
        if width <= 320 || height <= 200 {
            return None;
        }
        width = ((width as f32 * 0.75).round() as u32).max(320);
        height = ((height as f32 * 0.75).round() as u32).max(200);
        image = image::imageops::resize(&image, width, height, FilterType::Triangle);
    }
}

#[cfg(test)]
mod tests {
    use super::looks_blank;

    fn frame(r: u8, g: u8, b: u8) -> Vec<u8> {
        [b, g, r, 255].repeat(16)
    }

    #[test]
    fn blank_detection_only_covers_failed_capture_colors() {
        assert!(looks_blank(&[]));
        assert!(looks_blank(&frame(0, 0, 0)));
        assert!(looks_blank(&frame(255, 255, 255)));
        assert!(!looks_blank(&frame(64, 64, 64)));
        assert!(!looks_blank(&frame(12, 34, 56)));
    }

    #[test]
    fn blank_detection_rejects_mixed_pixels() {
        let mut pixels = frame(0, 0, 0);
        pixels[4] = 1;
        assert!(!looks_blank(&pixels));
    }
}
