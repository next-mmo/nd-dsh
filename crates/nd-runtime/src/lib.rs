//! System-heavy ND runtime services.
//!
//! Product/company semantics stay outside this crate. The composition binary
//! wires these services to the Rust-owned nd-protocol contract.

pub mod artifacts;
pub mod cache;
pub mod clipboard;
pub mod deadline;
pub mod decision;
pub mod dispatcher;
pub mod effect_journal;
pub mod evidence;
pub mod git;
pub mod media;
pub mod metrics;
pub mod process;
pub mod revision;
pub mod scheduler;
pub mod search;
pub mod session_journal;
pub mod snapshot;
pub mod terminal;
pub mod vault;
#[cfg(windows)]
pub mod windows_job;
pub mod workspace;

// Compatibility shims keep the extracted modules internally unchanged while
// making nd-protocol the only owner of wire/error vocabulary.
pub mod protocol {
    pub use nd_protocol::*;
}
pub mod errors {
    pub use nd_protocol::errors::*;
}
