use std::collections::HashMap;
use std::fmt::Write as _;

use sha2::{Digest, Sha256};

use super::types::UiNode;

const MAX_NAME_CHARS: usize = 160;
const MAX_VALUE_CHARS: usize = 240;
const MAX_META_CHARS: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CachedLine {
    pub key: String,
    pub plain: String,
    pub rendered: String,
}

#[derive(Debug, Clone)]
pub struct TreeSnapshot {
    pub lines: Vec<CachedLine>,
    pub tree_text: String,
    pub focused_element: Option<String>,
    pub truncated_by_text: bool,
}

#[derive(Debug, Clone)]
pub struct DiffOutput {
    pub text: String,
    pub changed: usize,
    pub added: usize,
    pub removed: usize,
}

pub fn snapshot(nodes: &[UiNode], max_chars: usize) -> TreeSnapshot {
    let keys = node_keys(nodes);
    let mut lines = Vec::with_capacity(nodes.len());
    let mut tree_text = String::new();
    let mut truncated_by_text = false;
    let mut focused_element = None;

    for (index, node) in nodes.iter().enumerate() {
        let plain = plain_line(node);
        let rendered = rendered_line(index, node);
        if node.focused && focused_element.is_none() {
            focused_element = Some(rendered.clone());
        }
        if !truncated_by_text {
            let needed = tree_text.chars().count() + rendered.chars().count() + 1;
            if needed > max_chars {
                truncated_by_text = true;
            } else {
                if !tree_text.is_empty() {
                    tree_text.push('\n');
                }
                tree_text.push_str(&rendered);
            }
        }
        lines.push(CachedLine {
            key: keys[index].clone(),
            plain,
            rendered,
        });
    }

    TreeSnapshot {
        lines,
        tree_text,
        focused_element,
        truncated_by_text,
    }
}

pub fn state_id(tree_text: &str) -> String {
    let digest = Sha256::digest(tree_text.as_bytes());
    digest
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub fn diff(previous: &[CachedLine], current: &[CachedLine], generation: u64) -> DiffOutput {
    let previous_by_key: HashMap<&str, &CachedLine> = previous
        .iter()
        .map(|line| (line.key.as_str(), line))
        .collect();
    let current_keys: HashMap<&str, ()> =
        current.iter().map(|line| (line.key.as_str(), ())).collect();

    let mut changed = 0;
    let mut added = 0;
    let mut removed = 0;
    let mut body = String::new();

    for line in current {
        match previous_by_key.get(line.key.as_str()) {
            None => {
                added += 1;
                if !body.is_empty() {
                    body.push('\n');
                }
                body.push_str(&line.rendered);
            }
            Some(old) if old.plain != line.plain => {
                changed += 1;
                if !body.is_empty() {
                    body.push('\n');
                }
                body.push_str(&line.rendered);
            }
            Some(_) => {}
        }
    }

    for old in previous {
        if !current_keys.contains_key(old.key.as_str()) {
            removed += 1;
            if !body.is_empty() {
                body.push('\n');
            }
            let _ = write!(body, "[-] {}", old.plain);
        }
    }

    if changed == 0 && added == 0 && removed == 0 {
        return DiffOutput {
            text: "# no changes".into(),
            changed,
            added,
            removed,
        };
    }

    let header = format!("# diff +{added} -{removed} ~{changed} generation={generation}");
    DiffOutput {
        text: if body.is_empty() {
            header
        } else {
            format!("{header}\n{body}")
        },
        changed,
        added,
        removed,
    }
}

pub fn node_keys(nodes: &[UiNode]) -> Vec<String> {
    let mut keys = Vec::with_capacity(nodes.len());
    for node in nodes {
        let parent = node
            .parent
            .and_then(|parent| keys.get(parent))
            .map(String::as_str)
            .unwrap_or("root");
        let identity = node.automation_id.as_deref().unwrap_or("");
        keys.push(format!(
            "{parent}/{}/{identity}/{}",
            node.role, node.ordinal
        ));
    }
    keys
}

fn plain_line(node: &UiNode) -> String {
    node_line(node, None)
}

fn node_line(node: &UiNode, index: Option<usize>) -> String {
    let mut line = String::new();
    for _ in 0..node.depth {
        line.push_str("  ");
    }
    if let Some(index) = index {
        let _ = write!(line, "[{index}] ");
    }
    line.push_str(&node.role);
    let name = clean(&node.name, MAX_NAME_CHARS);
    if !name.is_empty() {
        let _ = write!(line, " \"{name}\"");
    }
    if let Some(id) = node.automation_id.as_deref() {
        let id = clean(id, MAX_META_CHARS);
        if !id.is_empty() {
            let _ = write!(line, " id=\"{id}\"");
        }
    }
    if let Some(class) = node.class_name.as_deref() {
        let class = clean(class, MAX_META_CHARS);
        if !class.is_empty() {
            let _ = write!(line, " class=\"{class}\"");
        }
    }
    if node.password {
        line.push_str(" value=<redacted>");
    } else if let Some(value) = node.value.as_deref() {
        let value = clean(value, MAX_VALUE_CHARS);
        if !value.is_empty() {
            let _ = write!(line, " value=\"{value}\"");
        }
    }
    if let Some(toggle) = node.toggle.as_deref() {
        let _ = write!(line, " toggle={toggle}");
    }
    if !node.enabled {
        line.push_str(" disabled");
    }
    if node.offscreen {
        line.push_str(" offscreen");
    }
    if node.focused {
        line.push_str(" focused");
    }
    if let Some(bounds) = node.bounds {
        let _ = write!(
            line,
            " {{{},{},{},{}}}",
            bounds.x, bounds.y, bounds.width, bounds.height
        );
    }
    line
}

fn rendered_line(index: usize, node: &UiNode) -> String {
    node_line(node, Some(index))
}

fn clean(value: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (count, character) in value.chars().enumerate() {
        if count >= max_chars {
            out.push('…');
            break;
        }
        match character {
            '\n' | '\r' | '\t' => out.push(' '),
            '"' => out.push('\''),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer_use::types::Rect;

    fn node(parent: Option<usize>, depth: usize, ordinal: usize, role: &str, name: &str) -> UiNode {
        UiNode {
            parent,
            depth,
            ordinal,
            role: role.into(),
            name: name.into(),
            automation_id: None,
            class_name: None,
            value: None,
            toggle: None,
            enabled: true,
            offscreen: false,
            focused: false,
            password: false,
            bounds: Some(Rect {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            }),
        }
    }

    #[test]
    fn renders_preorder_indexes_and_redacts_passwords() {
        let mut nodes = vec![
            node(None, 0, 0, "Window", "Main"),
            node(Some(0), 1, 0, "Edit", "Password"),
            node(Some(0), 1, 1, "Button", "Sign in"),
        ];
        nodes[1].password = true;
        nodes[1].value = Some("secret".into());
        let snapshot = snapshot(&nodes, 10_000);
        assert!(snapshot.tree_text.contains("[0] Window \"Main\""));
        assert!(
            snapshot
                .tree_text
                .contains("[1] Edit \"Password\" value=<redacted>")
        );
        assert!(!snapshot.tree_text.contains("secret"));
        assert_eq!(snapshot.lines.len(), 3);
        assert_eq!(snapshot.lines[1].key, "root/Window//0/Edit//0");
    }

    #[test]
    fn diff_reports_changed_added_removed_and_keeps_indexes() {
        let first = snapshot(
            &[
                node(None, 0, 0, "Window", "Main"),
                node(Some(0), 1, 0, "Button", "One"),
            ],
            10_000,
        );
        let second = snapshot(
            &[
                node(None, 0, 0, "Window", "Main"),
                node(Some(0), 1, 0, "Button", "One"),
                node(Some(0), 1, 1, "Button", "Two"),
            ],
            10_000,
        );
        let diff = diff(&first.lines, &second.lines, 2);
        assert_eq!(diff.added, 1);
        assert_eq!(diff.removed, 0);
        assert!(diff.text.contains("[2] Button \"Two\""));
        assert!(diff.text.starts_with("# diff +1 -0 ~0 generation=2"));
    }

    #[test]
    fn diff_marks_name_changes_as_changed() {
        let first = snapshot(&[node(None, 0, 0, "Button", "One")], 10_000);
        let second = snapshot(&[node(None, 0, 0, "Button", "Two")], 10_000);
        let diff = diff(&first.lines, &second.lines, 2);
        assert_eq!(diff.changed, 1);
        assert_eq!(diff.added, 0);
        assert!(diff.text.contains("~1"));
    }

    #[test]
    fn text_cap_sets_truncated_flag() {
        let snapshot = snapshot(&[node(None, 0, 0, "Window", "Main")], 5);
        assert!(snapshot.truncated_by_text);
        assert!(snapshot.tree_text.is_empty());
    }

    #[test]
    fn no_changes_is_explicit() {
        let snapshot = snapshot(&[node(None, 0, 0, "Window", "Main")], 10_000);
        let diff = diff(&snapshot.lines, &snapshot.lines, 3);
        assert_eq!(diff.text, "# no changes");
        assert_eq!((diff.changed, diff.added, diff.removed), (0, 0, 0));
    }
}
