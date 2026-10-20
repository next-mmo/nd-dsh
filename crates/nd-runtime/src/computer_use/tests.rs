use super::*;
use crate::deadline::Interrupt;

#[test]
#[ignore = "requires a live Windows desktop"]
fn lists_running_apps_live() {
    let apps = ComputerUse::new().list_apps().expect("list apps");
    assert!(!apps.apps.is_empty(), "no targetable windows were found");
    for app in apps.apps.iter().take(10) {
        eprintln!(
            "{} ({}) windows={} running={}",
            app.display_name,
            app.id,
            app.windows.len(),
            app.is_running
        );
    }
}

#[test]
#[ignore = "requires the ChatGPT desktop app to be running"]
fn reads_chatgpt_state_live() {
    let computer = ComputerUse::new();
    let result = computer
        .app_state(
            AppStateParams {
                app: "chatgpt".into(),
                window_id: None,
                session_id: "live-test".into(),
                include_screenshot: Some(true),
                include_text: Some(true),
                disable_diff: Some(true),
            },
            &Interrupt::never(),
        )
        .expect("read ChatGPT state");
    assert!(result.accessibility.is_some());
    assert!(!result.accessibility.unwrap().tree.is_empty());
    assert!(result.screenshots.len() <= 1);
    eprintln!(
        "window={:?} nodes={} screenshot={}",
        result.window.title,
        result.stats.nodes,
        result.screenshots.len()
    );
}
