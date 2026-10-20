use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

use super::tree::CachedLine;

const CACHE_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_ENTRIES: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    session: String,
    app: String,
    window: String,
}

#[derive(Debug, Clone)]
pub struct CachedState {
    pub lines: Vec<CachedLine>,
    pub generation: u64,
    pub truncated: bool,
}

struct Entry {
    state: CachedState,
    stored_at: Instant,
    last_used: Instant,
}

#[derive(Default)]
pub struct DiffCache {
    entries: HashMap<CacheKey, Entry>,
    order: VecDeque<CacheKey>,
}

impl DiffCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&mut self, session: &str, app: &str, window: &str) -> Option<CachedState> {
        self.evict_expired();
        let key = CacheKey {
            session: session.to_owned(),
            app: app.to_owned(),
            window: window.to_owned(),
        };
        let entry = self.entries.get_mut(&key)?;
        entry.last_used = Instant::now();
        let state = entry.state.clone();
        self.order.retain(|candidate| candidate != &key);
        self.order.push_back(key);
        Some(state)
    }

    pub fn put(&mut self, session: &str, app: &str, window: &str, state: CachedState) {
        self.evict_expired();
        let key = CacheKey {
            session: session.to_owned(),
            app: app.to_owned(),
            window: window.to_owned(),
        };
        let now = Instant::now();
        self.entries.insert(
            key.clone(),
            Entry {
                state,
                stored_at: now,
                last_used: now,
            },
        );
        self.order.retain(|candidate| candidate != &key);
        self.order.push_back(key);
        while self.entries.len() > MAX_ENTRIES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.entries.remove(&oldest);
        }
    }

    pub fn reset_session(&mut self, session: &str) -> bool {
        let before = self.entries.len();
        self.entries
            .retain(|key, _| key.session.as_str() != session);
        self.order.retain(|key| key.session.as_str() != session);
        self.entries.len() != before
    }

    fn evict_expired(&mut self) {
        let now = Instant::now();
        let expired: Vec<CacheKey> = self
            .entries
            .iter()
            .filter(|(_, entry)| {
                now.duration_since(entry.stored_at) >= CACHE_TTL
                    || now.duration_since(entry.last_used) >= CACHE_TTL
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            self.entries.remove(&key);
        }
        let entries = &self.entries;
        self.order.retain(|key| entries.contains_key(key));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(key: &str) -> CachedLine {
        CachedLine {
            key: key.into(),
            plain: key.into(),
            rendered: key.into(),
        }
    }

    #[test]
    fn reset_only_removes_the_requested_session() {
        let mut cache = DiffCache::new();
        cache.put(
            "a",
            "app",
            "window",
            CachedState {
                lines: vec![line("one")],
                generation: 1,
                truncated: false,
            },
        );
        cache.put(
            "b",
            "app",
            "window",
            CachedState {
                lines: vec![line("two")],
                generation: 1,
                truncated: false,
            },
        );
        assert!(cache.reset_session("a"));
        assert!(cache.get("a", "app", "window").is_none());
        assert!(cache.get("b", "app", "window").is_some());
        assert!(!cache.reset_session("missing"));
    }

    #[test]
    fn cache_is_bounded() {
        let mut cache = DiffCache::new();
        for index in 0..(MAX_ENTRIES + 4) {
            cache.put(
                "session",
                "app",
                &format!("window-{index}"),
                CachedState {
                    lines: vec![line("one")],
                    generation: 1,
                    truncated: false,
                },
            );
        }
        assert_eq!(cache.entries.len(), MAX_ENTRIES);
        assert!(cache.get("session", "app", "window-0").is_none());
        assert!(
            cache
                .get("session", "app", &format!("window-{}", MAX_ENTRIES + 3))
                .is_some()
        );
    }
}
