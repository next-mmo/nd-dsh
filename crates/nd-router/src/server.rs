use crate::http;
use crate::state::RouterState;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

/// Loopback HTTP serving handle for ND Router.
///
/// The sidecar is otherwise synchronous; the router owns a small multi-thread
/// tokio runtime so chat streaming never blocks nd-core's dispatcher.
pub struct RouterServer {
    pub endpoint: String,
    pub key: String,
    pub port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    runtime: Option<tokio::runtime::Runtime>,
}

impl RouterServer {
    pub fn start(state: Arc<RouterState>, preferred_port: u16) -> anyhow::Result<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        let listener = runtime.block_on(async move {
            let mut last_error = None;
            for offset in 0..10u16 {
                let port = preferred_port.saturating_add(offset);
                if port == 0 {
                    break;
                }
                match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                    Ok(listener) => return Ok(listener),
                    Err(error) => last_error = Some(error),
                }
            }
            match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
                Ok(listener) => Ok(listener),
                Err(error) => Err(match last_error {
                    Some(previous) => anyhow::anyhow!("ND Router could not bind loopback: {error} (preferred port: {previous})"),
                    None => anyhow::anyhow!("ND Router could not bind loopback: {error}"),
                }),
            }
        })?;
        let port = listener.local_addr()?.port();
        let (shutdown, receiver) = oneshot::channel();
        let app = http::app(Arc::clone(&state));
        runtime.spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = receiver.await;
                })
                .await;
        });
        Ok(Self {
            endpoint: format!("http://127.0.0.1:{port}"),
            key: state.key().to_owned(),
            port,
            shutdown: Some(shutdown),
            runtime: Some(runtime),
        })
    }

    /// Run an async control operation (provider test) from the sync sidecar.
    pub fn block_on<F: Future>(&self, future: F) -> F::Output {
        self.runtime
            .as_ref()
            .expect("router runtime is running")
            .block_on(future)
    }

    pub fn stop(&mut self) {
        if let Some(sender) = self.shutdown.take() {
            let _ = sender.send(());
        }
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_timeout(Duration::from_secs(2));
        }
    }
}

impl Drop for RouterServer {
    fn drop(&mut self) {
        self.stop();
    }
}
