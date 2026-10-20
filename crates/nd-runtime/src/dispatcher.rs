use anyhow::{Result, bail};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};

type Job = Box<dyn FnOnce() + Send + 'static>;

const HIGH_CAPACITY: usize = 256;
const NORMAL_CAPACITY: usize = 512;
const BACKGROUND_CAPACITY: usize = 256;

#[derive(Debug, Clone, Copy)]
pub enum Priority {
    High,
    Normal,
    Background,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchSnapshot {
    pub worker_count: usize,
    pub active: usize,
    pub queued_high: usize,
    pub queued_normal: usize,
    pub queued_background: usize,
}

struct QueueState {
    high: VecDeque<Job>,
    normal: VecDeque<Job>,
    background: VecDeque<Job>,
    active: usize,
    closed: bool,
}

struct Shared {
    state: Mutex<QueueState>,
    ready: Condvar,
    worker_count: usize,
}

#[derive(Clone)]
pub struct DispatchStats {
    shared: Arc<Shared>,
}

impl DispatchStats {
    pub fn snapshot(&self) -> DispatchSnapshot {
        let state = self
            .shared
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        DispatchSnapshot {
            worker_count: self.shared.worker_count,
            active: state.active,
            queued_high: state.high.len(),
            queued_normal: state.normal.len(),
            queued_background: state.background.len(),
        }
    }
}

pub struct Dispatcher {
    shared: Arc<Shared>,
    workers: Vec<JoinHandle<()>>,
}

impl Default for Dispatcher {
    fn default() -> Self {
        Self::new()
    }
}

impl Dispatcher {
    pub fn new() -> Self {
        let worker_count = std::thread::available_parallelism()
            .map(|value| value.get())
            .unwrap_or(4)
            .clamp(3, 8);
        let shared = Arc::new(Shared {
            state: Mutex::new(QueueState {
                high: VecDeque::new(),
                normal: VecDeque::new(),
                background: VecDeque::new(),
                active: 0,
                closed: false,
            }),
            ready: Condvar::new(),
            worker_count,
        });
        let mut workers = Vec::with_capacity(worker_count);
        // Keep one worker dedicated to foreground control traffic so saturated
        // Git/background work cannot starve input/cancel/health requests.
        workers.push(spawn_worker(Arc::clone(&shared), true));
        for _ in 1..worker_count {
            workers.push(spawn_worker(Arc::clone(&shared), false));
        }
        Self { shared, workers }
    }

    pub fn stats(&self) -> DispatchStats {
        DispatchStats {
            shared: Arc::clone(&self.shared),
        }
    }

    pub fn submit<F>(&self, priority: Priority, job: F) -> Result<()>
    where
        F: FnOnce() + Send + 'static,
    {
        let mut state = self
            .shared
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("dispatcher queue lock poisoned"))?;
        if state.closed {
            bail!("dispatcher is closed");
        }
        let queue = match priority {
            Priority::High => &mut state.high,
            Priority::Normal => &mut state.normal,
            Priority::Background => &mut state.background,
        };
        let capacity = match priority {
            Priority::High => HIGH_CAPACITY,
            Priority::Normal => NORMAL_CAPACITY,
            Priority::Background => BACKGROUND_CAPACITY,
        };
        if queue.len() >= capacity {
            bail!("dispatcher {:?} queue is full", priority);
        }
        queue.push_back(Box::new(job));
        self.shared.ready.notify_all();
        Ok(())
    }

    pub fn shutdown(self) {
        {
            let mut state = self
                .shared
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.closed = true;
            self.shared.ready.notify_all();
        }
        for worker in self.workers {
            let _ = worker.join();
        }
    }
}

fn spawn_worker(shared: Arc<Shared>, foreground_only: bool) -> JoinHandle<()> {
    thread::spawn(move || {
        loop {
            let job = {
                let mut state = shared
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                loop {
                    let next = if foreground_only {
                        state.high.pop_front()
                    } else {
                        state
                            .high
                            .pop_front()
                            .or_else(|| state.normal.pop_front())
                            .or_else(|| state.background.pop_front())
                    };
                    if let Some(job) = next {
                        state.active += 1;
                        break job;
                    }
                    if state.closed {
                        return;
                    }
                    state = shared
                        .ready
                        .wait(state)
                        .unwrap_or_else(|error| error.into_inner());
                }
            };

            job();

            let mut state = shared
                .state
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            state.active = state.active.saturating_sub(1);
            shared.ready.notify_all();
        }
    })
}

pub fn priority_for_method(method: &str) -> Priority {
    match method {
        "core.health"
        | "core.cancel"
        | "metrics.snapshot"
        | "terminal.write"
        | "terminal.resize"
        | "terminal.close"
        | "terminal.state"
        | "terminal.restart"
        | "terminal.appendHistory"
        | "sessionJournal.tail"
        | "process.write"
        | "process.closeStdin"
        | "process.cancel"
        | "scheduler.heartbeat"
        | "scheduler.release"
        | "scheduler.bind"
        | "computer.session.reset" => Priority::High,
        "scheduler.snapshot"
        | "process.snapshot"
        | "workspace.list"
        | "sessionJournal.drop"
        | "sessionJournal.clear" => Priority::Background,
        _ => Priority::Normal,
    }
}
