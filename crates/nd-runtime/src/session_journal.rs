use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

pub const DEFAULT_MAX_EVENTS_PER_SESSION: usize = 10_000;
pub const DEFAULT_MAX_BYTES_PER_SESSION: usize = 8 * 1024 * 1024;
pub const DEFAULT_MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionJournalEnvelope {
    #[serde(rename = "type")]
    pub event_type: String,
    pub seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface_op: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionJournalAppendParams {
    pub session_id: String,
    #[serde(default)]
    pub events: Vec<SessionJournalEnvelope>,
    #[serde(default)]
    pub max_events: Option<usize>,
    #[serde(default)]
    pub max_bytes: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionJournalSessionParams {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionJournalTailParams {
    pub session_id: String,
    #[serde(default = "default_tail_limit")]
    pub max_messages: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionJournalAppendResult {
    pub retained_events: usize,
    pub retained_bytes: usize,
    pub first_seq: Option<u64>,
    pub last_seq: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionJournalTailResult {
    pub events: Vec<SessionJournalEnvelope>,
    pub retained_events: usize,
    pub retained_bytes: usize,
    pub first_seq: Option<u64>,
    pub last_seq: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionJournalStats {
    pub session_count: usize,
    pub retained_event_count: usize,
    pub retained_bytes: usize,
    pub max_events_per_session: usize,
    pub max_bytes_per_session: usize,
}

struct StoredEnvelope {
    envelope: SessionJournalEnvelope,
    bytes: usize,
}

#[derive(Default)]
struct SessionJournal {
    events: VecDeque<StoredEnvelope>,
    bytes: usize,
    last_touched: u64,
}

#[derive(Default)]
struct SessionJournalState {
    sessions: HashMap<String, SessionJournal>,
    next_touch: u64,
}

pub struct SessionJournalStore {
    state: Mutex<SessionJournalState>,
    max_events_per_session: usize,
    max_bytes_per_session: usize,
    max_total_bytes: usize,
}

impl SessionJournalStore {
    pub fn new(max_events_per_session: usize, max_bytes_per_session: usize) -> Self {
        let clamped_bytes = max_bytes_per_session.max(1);
        Self::with_total_limit(
            max_events_per_session,
            clamped_bytes,
            DEFAULT_MAX_TOTAL_BYTES.max(clamped_bytes),
        )
    }

    pub fn with_total_limit(
        max_events_per_session: usize,
        max_bytes_per_session: usize,
        max_total_bytes: usize,
    ) -> Self {
        let clamped_bytes = max_bytes_per_session.max(1);
        Self {
            state: Mutex::new(SessionJournalState::default()),
            max_events_per_session: max_events_per_session.max(1),
            max_bytes_per_session: clamped_bytes,
            max_total_bytes: max_total_bytes.max(clamped_bytes),
        }
    }

    pub fn append(&self, params: SessionJournalAppendParams) -> Result<SessionJournalAppendResult> {
        validate_session_id(&params.session_id)?;
        if params.events.len() > 1024 {
            bail!("session journal append batch is too large");
        }
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("session journal lock poisoned"))?;
        state.next_touch = state.next_touch.wrapping_add(1);
        let touch = state.next_touch;
        let max_events = params
            .max_events
            .unwrap_or(self.max_events_per_session)
            .clamp(1, self.max_events_per_session);
        let max_bytes = params
            .max_bytes
            .unwrap_or(self.max_bytes_per_session)
            .clamp(1, self.max_bytes_per_session);
        let session_id = params.session_id;
        let result = {
            let journal = state.sessions.entry(session_id.clone()).or_default();
            journal.last_touched = touch;
            for envelope in params.events {
                validate_envelope(&envelope)?;
                let encoded_bytes = serde_json::to_vec(&envelope)
                    .map(|value| value.len())
                    .unwrap_or_default();
                journal.bytes = journal.bytes.saturating_add(encoded_bytes);
                journal.events.push_back(StoredEnvelope {
                    envelope,
                    bytes: encoded_bytes,
                });
                trim_journal(journal, max_events, max_bytes);
            }
            SessionJournalAppendResult {
                first_seq: journal.events.front().map(|stored| stored.envelope.seq),
                last_seq: journal.events.back().map(|stored| stored.envelope.seq),
                retained_events: journal.events.len(),
                retained_bytes: journal.bytes,
            }
        };
        evict_inactive_sessions(&mut state.sessions, &session_id, self.max_total_bytes);
        Ok(result)
    }

    pub fn drop_session(&self, params: SessionJournalSessionParams) -> Result<bool> {
        validate_session_id(&params.session_id)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("session journal lock poisoned"))?;
        Ok(state.sessions.remove(&params.session_id).is_some())
    }

    pub fn clear(&self) -> Result<usize> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("session journal lock poisoned"))?;
        let count = state.sessions.len();
        state.sessions.clear();
        Ok(count)
    }

    pub fn tail(&self, params: SessionJournalTailParams) -> Result<SessionJournalTailResult> {
        validate_session_id(&params.session_id)?;
        let limit = params.max_messages.clamp(1, self.max_events_per_session);
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("session journal lock poisoned"))?;
        state.next_touch = state.next_touch.wrapping_add(1);
        let touch = state.next_touch;
        let Some(journal) = state.sessions.get_mut(&params.session_id) else {
            return Ok(SessionJournalTailResult {
                events: Vec::new(),
                retained_events: 0,
                retained_bytes: 0,
                first_seq: None,
                last_seq: None,
            });
        };
        journal.last_touched = touch;
        Ok(tail_result(journal, limit))
    }

    pub fn stats(&self) -> SessionJournalStats {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        SessionJournalStats {
            session_count: state.sessions.len(),
            retained_event_count: state
                .sessions
                .values()
                .map(|journal| journal.events.len())
                .sum(),
            retained_bytes: state.sessions.values().map(|journal| journal.bytes).sum(),
            max_events_per_session: self.max_events_per_session,
            max_bytes_per_session: self.max_bytes_per_session,
        }
    }
}

fn tail_result(journal: &SessionJournal, limit: usize) -> SessionJournalTailResult {
    let skip = journal.events.len().saturating_sub(limit);
    let events = journal
        .events
        .iter()
        .skip(skip)
        .map(|stored| stored.envelope.clone())
        .collect::<Vec<_>>();
    SessionJournalTailResult {
        first_seq: journal.events.front().map(|stored| stored.envelope.seq),
        last_seq: journal.events.back().map(|stored| stored.envelope.seq),
        retained_events: journal.events.len(),
        retained_bytes: journal.bytes,
        events,
    }
}

fn trim_journal(journal: &mut SessionJournal, max_events: usize, max_bytes: usize) {
    while journal.events.len() > max_events || journal.bytes > max_bytes {
        let Some(removed) = journal.events.pop_front() else {
            break;
        };
        journal.bytes = journal.bytes.saturating_sub(removed.bytes);
    }
}

fn evict_inactive_sessions(
    sessions: &mut HashMap<String, SessionJournal>,
    active_session_id: &str,
    max_total_bytes: usize,
) {
    loop {
        if sessions.len() <= 1 {
            break;
        }
        let total_bytes: usize = sessions.values().map(|journal| journal.bytes).sum();
        if total_bytes <= max_total_bytes {
            break;
        }
        let oldest_id = sessions
            .iter()
            .filter(|(id, _)| id.as_str() != active_session_id)
            .min_by_key(|(_, journal)| journal.last_touched)
            .map(|(id, _)| id.clone());
        let Some(oldest_id) = oldest_id else {
            break;
        };
        sessions.remove(&oldest_id);
    }
}

fn validate_session_id(value: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > 256 {
        bail!("invalid session journal id");
    }
    Ok(())
}

fn validate_envelope(envelope: &SessionJournalEnvelope) -> Result<()> {
    if envelope.event_type.trim().is_empty() || envelope.event_type.len() > 256 {
        bail!("invalid session journal event type");
    }
    Ok(())
}

fn default_tail_limit() -> usize {
    50
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope(seq: u64, text: &str) -> SessionJournalEnvelope {
        SessionJournalEnvelope {
            event_type: "assistant/message".into(),
            seq,
            time: Some(seq),
            data: Some(serde_json::json!({ "text": text })),
            surface_op: None,
        }
    }

    #[test]
    fn retains_only_the_newest_event_window() {
        let store = SessionJournalStore::new(3, 1024 * 1024);
        store
            .append(SessionJournalAppendParams {
                session_id: "s1".into(),
                events: (1..=5).map(|seq| envelope(seq, "x")).collect(),
                max_events: None,
                max_bytes: None,
            })
            .unwrap();
        let tail = store
            .tail(SessionJournalTailParams {
                session_id: "s1".into(),
                max_messages: 10,
            })
            .unwrap();
        assert_eq!(
            tail.events
                .iter()
                .map(|event| event.seq)
                .collect::<Vec<_>>(),
            vec![3, 4, 5]
        );
        assert_eq!(tail.first_seq, Some(3));
        assert_eq!(tail.last_seq, Some(5));
    }

    #[test]
    fn retained_bytes_are_bounded() {
        let store = SessionJournalStore::new(100, 256);
        store
            .append(SessionJournalAppendParams {
                session_id: "s1".into(),
                events: (1..=20)
                    .map(|seq| envelope(seq, "0123456789abcdef"))
                    .collect(),
                max_events: None,
                max_bytes: None,
            })
            .unwrap();
        let stats = store.stats();
        assert!(stats.retained_bytes <= 256);
        assert!(stats.retained_event_count < 20);
    }

    #[test]
    fn append_can_apply_a_tighter_owner_retention_policy() {
        let store = SessionJournalStore::new(10_000, 8 * 1024 * 1024);
        store
            .append(SessionJournalAppendParams {
                session_id: "direct".into(),
                events: (1..=40).map(|seq| envelope(seq, "x")).collect(),
                max_events: Some(16),
                max_bytes: Some(1024 * 1024),
            })
            .unwrap();
        let tail = store
            .tail(SessionJournalTailParams {
                session_id: "direct".into(),
                max_messages: 50,
            })
            .unwrap();
        assert_eq!(tail.events.len(), 16);
        assert_eq!(tail.first_seq, Some(25));
        assert_eq!(tail.last_seq, Some(40));
    }

    #[test]
    fn drop_session_removes_only_one_session() {
        let store = SessionJournalStore::new(10, 1024);
        for id in ["a", "b"] {
            store
                .append(SessionJournalAppendParams {
                    session_id: id.into(),
                    events: vec![envelope(1, id)],
                    max_events: None,
                    max_bytes: None,
                })
                .unwrap();
        }
        assert!(
            store
                .drop_session(SessionJournalSessionParams {
                    session_id: "a".into(),
                })
                .unwrap()
        );
        assert_eq!(store.stats().session_count, 1);
        assert_eq!(
            store
                .tail(SessionJournalTailParams {
                    session_id: "b".into(),
                    max_messages: 5,
                })
                .unwrap()
                .events
                .len(),
            1
        );
    }

    #[test]
    fn evicts_least_recently_touched_sessions_when_total_bytes_exceed_cap() {
        let store = SessionJournalStore::with_total_limit(10, 200, 300);
        for id in ["s1", "s2"] {
            store
                .append(SessionJournalAppendParams {
                    session_id: id.into(),
                    events: vec![envelope(1, &"x".repeat(80))],
                    max_events: None,
                    max_bytes: None,
                })
                .unwrap();
        }
        // Touch s1 so s2 becomes the oldest untouched session.
        let _ = store
            .tail(SessionJournalTailParams {
                session_id: "s1".into(),
                max_messages: 5,
            })
            .unwrap();
        store
            .append(SessionJournalAppendParams {
                session_id: "s3".into(),
                events: vec![envelope(1, &"x".repeat(80))],
                max_events: None,
                max_bytes: None,
            })
            .unwrap();
        assert!(store.stats().retained_bytes <= 300);
        assert_eq!(
            store
                .tail(SessionJournalTailParams {
                    session_id: "s2".into(),
                    max_messages: 5,
                })
                .unwrap()
                .events
                .len(),
            0
        );
        assert_eq!(
            store
                .tail(SessionJournalTailParams {
                    session_id: "s1".into(),
                    max_messages: 5,
                })
                .unwrap()
                .events
                .len(),
            1
        );
    }
}
