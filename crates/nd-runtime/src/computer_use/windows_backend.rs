use std::collections::HashMap;
use std::ffi::c_void;
use std::mem::size_of;
use std::path::Path;

use anyhow::{Result, bail};
use windows::Win32::Foundation::HWND as WinHwnd;
use windows::Win32::Graphics::Dwm::{DWMWA_CLOAKED, DwmGetWindowAttribute};
use windows::Win32::System::Com::{
    CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomation2, IUIAutomationElement, IUIAutomationTogglePattern,
    IUIAutomationTreeWalker, IUIAutomationValuePattern, UIA_TogglePatternId, UIA_ValuePatternId,
};
use windows::core::{BSTR, Interface};
use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GWL_EXSTYLE, GetClassNameW, GetForegroundWindow, GetWindowLongW, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
    IsWindowVisible, WS_EX_TOOLWINDOW,
};

use super::types::{
    AppsListResult, MAX_APPS, MAX_TREE_DEPTH, MAX_TREE_NODES, MAX_WINDOWS_PER_APP, Rect, Selection,
    UiNode, WindowEntry,
};
use crate::deadline::Interrupt;

const SKIP_CLASSES: &[&str] = &[
    "Shell_TrayWnd",
    "Progman",
    "WorkerW",
    "Windows.UI.Core.CoreWindow",
    "ApplicationFrameWindow",
    "MSCTFIME UI",
    "IME",
    "Default IME",
    "GDI+ Window",
];

struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

#[derive(Debug)]
struct Candidate {
    hwnd: isize,
    pid: u32,
    app_id: String,
    display_name: String,
    title: Option<String>,
    rect: Rect,
    focused: bool,
    minimized: bool,
}

pub fn list_apps() -> Result<AppsListResult> {
    let candidates = enumerate_windows()?;
    let mut apps: Vec<super::types::AppEntry> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut truncated = false;

    for candidate in candidates {
        let window = WindowEntry {
            id: window_id(candidate.pid, candidate.hwnd),
            title: candidate.title.clone(),
            width: candidate.rect.width,
            height: candidate.rect.height,
            focused: candidate.focused,
            minimized: candidate.minimized,
        };
        if let Some(&app_index) = index.get(&candidate.app_id) {
            if apps[app_index].windows.len() >= MAX_WINDOWS_PER_APP {
                truncated = true;
                continue;
            }
            apps[app_index].windows.push(window);
            continue;
        }
        if apps.len() >= MAX_APPS {
            truncated = true;
            continue;
        }
        index.insert(candidate.app_id.clone(), apps.len());
        apps.push(super::types::AppEntry {
            id: candidate.app_id,
            display_name: candidate.display_name,
            windows: vec![window],
            is_running: true,
        });
    }

    Ok(AppsListResult { apps, truncated })
}

pub fn select_window(app: &str, window_id: Option<&str>) -> Result<Selection> {
    let candidates = enumerate_windows()?;
    if let Some(window_id) = window_id {
        let (pid, hwnd) = parse_window_id(window_id)?;
        let candidate = candidates
            .into_iter()
            .find(|candidate| candidate.pid == pid && candidate.hwnd == hwnd)
            .ok_or_else(|| anyhow::anyhow!("that window is no longer available"))?;
        let wanted = normalize_app(app);
        if candidate.app_id != wanted && !candidate.display_name.eq_ignore_ascii_case(app.trim()) {
            bail!("that window does not belong to the requested app");
        }
        return Ok(to_selection(candidate));
    }

    let wanted = normalize_app(app);
    let mut matches: Vec<Candidate> = candidates
        .into_iter()
        .filter(|candidate| {
            candidate.app_id == wanted || candidate.display_name.eq_ignore_ascii_case(app.trim())
        })
        .collect();
    if matches.is_empty() {
        bail!("app is not running or has no targetable window: {app}");
    }
    let position = matches
        .iter()
        .position(|candidate| candidate.focused)
        .unwrap_or(0);
    Ok(to_selection(matches.swap_remove(position)))
}

pub fn read_tree(
    hwnd: isize,
    window_rect: Rect,
    interrupt: &Interrupt,
) -> Result<(Vec<UiNode>, bool)> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok()? };
    let _apartment = Apartment;

    unsafe {
        let automation: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_ALL)?;
        if let Ok(automation2) = automation.cast::<IUIAutomation2>() {
            let _ = automation2.SetConnectionTimeout(1_500);
            let _ = automation2.SetTransactionTimeout(3_000);
        }
        let root = automation.ElementFromHandle(WinHwnd(hwnd as *mut c_void))?;

        let control_walker = automation.ControlViewWalker()?;
        let control = walk_tree(&control_walker, &root, window_rect, interrupt)?;
        if control.0.len() > 1 || !control.1 {
            let raw_walker = automation.RawViewWalker()?;
            let raw = walk_tree(&raw_walker, &root, window_rect, interrupt)?;
            if raw.0.len() > control.0.len() {
                return Ok(raw);
            }
        }
        Ok(control)
    }
}

fn walk_tree(
    walker: &IUIAutomationTreeWalker,
    root: &IUIAutomationElement,
    window_rect: Rect,
    interrupt: &Interrupt,
) -> Result<(Vec<UiNode>, bool)> {
    let mut nodes: Vec<UiNode> = Vec::new();
    let mut truncated = false;
    let mut stack: Vec<(IUIAutomationElement, usize, Option<usize>, usize)> =
        vec![(root.clone(), 0, None, 0)];

    while let Some((element, depth, parent, ordinal)) = stack.pop() {
        interrupt.check("computer.app.state")?;
        if nodes.len() >= MAX_TREE_NODES {
            truncated = true;
            break;
        }
        let index = nodes.len();
        nodes.push(read_node(&element, depth, parent, ordinal, window_rect));

        if depth + 1 >= MAX_TREE_DEPTH {
            if unsafe { walker.GetFirstChildElement(&element) }.is_ok() {
                truncated = true;
            }
            continue;
        }

        let mut children = Vec::new();
        let mut child = unsafe { walker.GetFirstChildElement(&element) }.ok();
        let mut child_ordinal = 0usize;
        while let Some(current) = child {
            children.push((current.clone(), depth + 1, Some(index), child_ordinal));
            child_ordinal += 1;
            if nodes.len() + children.len() >= MAX_TREE_NODES {
                truncated = true;
                break;
            }
            child = unsafe { walker.GetNextSiblingElement(&current) }.ok();
        }
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }

    Ok((nodes, truncated))
}

fn read_node(
    element: &IUIAutomationElement,
    depth: usize,
    parent: Option<usize>,
    ordinal: usize,
    window_rect: Rect,
) -> UiNode {
    let role = control_type_name(
        unsafe { element.CurrentControlType() }
            .map(|value| value.0)
            .unwrap_or(0),
    );
    let name = bstr(unsafe { element.CurrentName() });
    let automation_id = bstr(unsafe { element.CurrentAutomationId() });
    let class_name = bstr(unsafe { element.CurrentClassName() });
    let enabled = unsafe { element.CurrentIsEnabled() }
        .map(|value| value.as_bool())
        .unwrap_or(true);
    let offscreen = unsafe { element.CurrentIsOffscreen() }
        .map(|value| value.as_bool())
        .unwrap_or(false);
    let focused = unsafe { element.CurrentHasKeyboardFocus() }
        .map(|value| value.as_bool())
        .unwrap_or(false);
    let password = unsafe { element.CurrentIsPassword() }
        .map(|value| value.as_bool())
        .unwrap_or(false);
    let bounds = unsafe { element.CurrentBoundingRectangle() }
        .ok()
        .map(|rect| Rect {
            x: rect.left - window_rect.x,
            y: rect.top - window_rect.y,
            width: rect.right - rect.left,
            height: rect.bottom - rect.top,
        })
        .filter(|rect| rect.width > 0 && rect.height > 0);

    let mut value = None;
    let mut toggle = None;
    if !password {
        if let Ok(pattern) =
            unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
        {
            value = bstr(unsafe { pattern.CurrentValue() });
        }
        if let Ok(pattern) = unsafe {
            element.GetCurrentPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
        } {
            toggle = unsafe { pattern.CurrentToggleState() }.ok().map(|state| {
                match state.0 {
                    1 => "on",
                    2 => "indeterminate",
                    _ => "off",
                }
                .to_string()
            });
        }
    }

    UiNode {
        parent,
        depth,
        ordinal,
        role,
        name: limit(name.unwrap_or_default(), 2_000),
        automation_id: automation_id.map(|value| limit(value, 256)),
        class_name: class_name.map(|value| limit(value, 256)),
        value: value.map(|value| limit(value, 4_000)),
        toggle,
        enabled,
        offscreen,
        focused,
        password,
        bounds,
    }
}

fn enumerate_windows() -> Result<Vec<Candidate>> {
    let mut handles: Vec<HWND> = Vec::new();
    unsafe {
        let _ = EnumWindows(
            Some(collect_window),
            &mut handles as *mut Vec<HWND> as LPARAM,
        );
    }

    let foreground = unsafe { GetForegroundWindow() };
    let own_pid = std::process::id();
    let mut candidates = Vec::new();

    for hwnd in handles {
        unsafe {
            if IsWindow(hwnd) == 0 || IsWindowVisible(hwnd) == 0 {
                continue;
            }
        }
        let class = class_name(hwnd);
        if SKIP_CLASSES.contains(&class.as_str()) {
            continue;
        }
        if unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 } & WS_EX_TOOLWINDOW != 0 {
            continue;
        }
        if is_cloaked(hwnd) {
            continue;
        }

        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if pid == 0 || pid == own_pid {
            continue;
        }

        let Some(rect) = window_rect(hwnd) else {
            continue;
        };
        if rect.width <= 0 || rect.height <= 0 {
            continue;
        }

        let path = process_path(pid);
        let (display_name, app_id) = match path
            .as_deref()
            .and_then(|path| Path::new(path).file_stem())
            .and_then(|stem| stem.to_str())
            .filter(|stem| !stem.trim().is_empty())
        {
            Some(stem) => (stem.to_string(), format!("win32:{}", sanitize(stem))),
            None => {
                let fallback = if class.is_empty() {
                    "unknown".to_string()
                } else {
                    class.clone()
                };
                (fallback.clone(), format!("win32:{}", sanitize(&fallback)))
            }
        };

        candidates.push(Candidate {
            hwnd: hwnd as isize,
            pid,
            app_id,
            display_name,
            title: window_title(hwnd),
            rect,
            focused: hwnd == foreground,
            minimized: unsafe { IsIconic(hwnd) != 0 },
        });
    }

    Ok(candidates)
}

unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> i32 {
    let handles = unsafe { &mut *(lparam as *mut Vec<HWND>) };
    if handles.len() >= 4_000 {
        return 0;
    }
    handles.push(hwnd);
    1
}

fn to_selection(candidate: Candidate) -> Selection {
    Selection {
        app_id: candidate.app_id,
        display_name: candidate.display_name,
        window: WindowEntry {
            id: window_id(candidate.pid, candidate.hwnd),
            title: candidate.title,
            width: candidate.rect.width,
            height: candidate.rect.height,
            focused: candidate.focused,
            minimized: candidate.minimized,
        },
        hwnd: candidate.hwnd,
        rect: candidate.rect,
    }
}

fn window_id(pid: u32, hwnd: isize) -> String {
    format!("win32:{pid}:{hwnd:x}")
}

fn parse_window_id(window_id: &str) -> Result<(u32, isize)> {
    let rest = window_id
        .strip_prefix("win32:")
        .ok_or_else(|| anyhow::anyhow!("windowId must start with win32:"))?;
    let (pid, hwnd) = rest
        .split_once(':')
        .ok_or_else(|| anyhow::anyhow!("windowId is malformed"))?;
    let pid = pid
        .parse::<u32>()
        .map_err(|_| anyhow::anyhow!("windowId process id is malformed"))?;
    let hwnd = isize::from_str_radix(hwnd, 16)
        .map_err(|_| anyhow::anyhow!("windowId handle is malformed"))?;
    Ok((pid, hwnd))
}

fn normalize_app(app: &str) -> String {
    let app = app.trim();
    let app = app.strip_suffix(".exe").unwrap_or(app);
    if let Some(rest) = app.strip_prefix("win32:") {
        return format!("win32:{}", sanitize(rest));
    }
    format!("win32:{}", sanitize(app))
}

fn sanitize(value: &str) -> String {
    let mut out = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-') {
            out.push(character.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').to_string()
}

fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if length <= 0 {
        return String::new();
    }
    String::from_utf16_lossy(&buffer[..length as usize])
}

fn window_title(hwnd: HWND) -> Option<String> {
    let length = unsafe { GetWindowTextLengthW(hwnd) };
    if length <= 0 {
        return None;
    }
    let mut buffer = vec![0u16; length as usize + 1];
    let copied = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
    if copied <= 0 {
        return None;
    }
    let title = String::from_utf16_lossy(&buffer[..copied as usize])
        .trim()
        .to_string();
    (!title.is_empty()).then_some(limit(title, 512))
}

fn window_rect(hwnd: HWND) -> Option<Rect> {
    let mut rect: RECT = unsafe { std::mem::zeroed() };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return None;
    }
    Some(Rect {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    })
}

fn process_path(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return None;
        }
        let mut buffer = [0u16; 1_024];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size) != 0;
        let _ = CloseHandle(handle);
        if !ok || size == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }
}

fn is_cloaked(hwnd: HWND) -> bool {
    let mut cloaked = 0u32;
    let result = unsafe {
        DwmGetWindowAttribute(
            WinHwnd(hwnd),
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut c_void,
            size_of::<u32>() as u32,
        )
    };
    result.is_ok() && cloaked != 0
}

fn bstr(value: windows::core::Result<BSTR>) -> Option<String> {
    value.ok().map(|value| value.to_string())
}

fn control_type_name(id: i32) -> String {
    match id {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => "Control",
    }
    .to_string()
}

fn limit(value: String, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value;
    }
    let mut truncated: String = value.chars().take(max_chars).collect();
    truncated.push('…');
    truncated
}
