//! Outbound HTTP execution for ND API Studio.
//!
//! The sandboxed extension web view has no network of its own, so API Studio
//! sends requests through nd-core. Keeping the transfer here gives one place
//! for scheme, header, size, redirect, timeout, and cancellation policy.
//! Local-first API work means loopback services are a primary target, so the
//! rule is "http and https to any host, nothing else" rather than a private-IP
//! deny list that would break the main use case.

use crate::deadline::Interrupt;
use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use nd_protocol::errors::{CODE_INVALID_PARAMS, CODE_METHOD_FAILED, coded};
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const ALLOWED_METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const MAX_URL_CHARS: usize = 4096;
const MAX_HEADERS: usize = 100;
const MAX_HEADER_BYTES: usize = 32 * 1024;
const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;
const MIN_TIMEOUT_MS: u64 = 250;
const MAX_TIMEOUT_MS: u64 = 120_000;
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MIN_RESPONSE_BYTES: usize = 1024;
const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_RESPONSE_BYTES: usize = 100_000;
const MAX_REDIRECTS: usize = 10;
const READ_CHUNK_BYTES: usize = 16 * 1024;
// The response crosses the nd.webview/1 bridge, which drops frames over
// 262,144 characters. Headers are capped so the body cap stays reachable.
const MAX_RESPONSE_HEADERS: usize = 100;
const MAX_RESPONSE_HEADER_BYTES: usize = 16 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ApiHttpHeader {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiHttpRequestParams {
    pub url: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub headers: Vec<ApiHttpHeader>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default = "default_timeout_ms")]
    pub timeout_ms: u64,
    #[serde(default = "default_max_response_bytes")]
    pub max_response_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiHttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<ApiHttpHeader>,
    pub body: String,
    /// `utf8` or `base64`; the bridge never receives raw bytes.
    pub body_encoding: &'static str,
    /// Bytes received, after the response cap was applied.
    pub bytes: usize,
    pub truncated: bool,
    pub duration_ms: u64,
    pub final_url: String,
}

fn default_method() -> String {
    "GET".into()
}

fn default_timeout_ms() -> u64 {
    DEFAULT_TIMEOUT_MS
}

fn default_max_response_bytes() -> usize {
    DEFAULT_RESPONSE_BYTES
}

/// The client is pooled across requests. Policies that never vary live on the
/// client; the per-chunk timeout lives on each request.
fn shared_client() -> Result<Client> {
    static CLIENT: Mutex<Option<Client>> = Mutex::new(None);
    let mut guard = CLIENT
        .lock()
        .map_err(|_| anyhow::anyhow!("HTTP client lock poisoned"))?;
    if let Some(client) = guard.as_ref() {
        return Ok(client.clone());
    }
    let client = Client::builder()
        .redirect(Policy::limited(MAX_REDIRECTS))
        .connect_timeout(Duration::from_secs(10))
        // Desktop API work is direct by default. Honouring ambient HTTP_PROXY
        // would silently route localhost debugging through a corporate proxy.
        .no_proxy()
        .build()
        .context("create HTTP client")?;
    *guard = Some(client.clone());
    Ok(client)
}

pub fn execute(params: ApiHttpRequestParams, interrupt: &Interrupt) -> Result<ApiHttpResponse> {
    let method = params.method.trim().to_ascii_uppercase();
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(coded(
            CODE_INVALID_PARAMS,
            format!(
                "Unsupported HTTP method {method}; use {}",
                ALLOWED_METHODS.join(", ")
            ),
        ));
    }

    let raw_url = params.url.trim();
    if raw_url.is_empty() {
        return Err(coded(CODE_INVALID_PARAMS, "URL is required"));
    }
    if raw_url.chars().count() > MAX_URL_CHARS {
        return Err(coded(
            CODE_INVALID_PARAMS,
            format!("URL must be at most {MAX_URL_CHARS} characters"),
        ));
    }
    let url = reqwest::Url::parse(raw_url)
        .map_err(|error| coded(CODE_INVALID_PARAMS, format!("Invalid URL: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(coded(
            CODE_INVALID_PARAMS,
            "Only http and https URLs are supported",
        ));
    }
    if url.host_str().is_none() {
        return Err(coded(CODE_INVALID_PARAMS, "URL must include a host"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(coded(
            CODE_INVALID_PARAMS,
            "Put credentials in the Auth tab, not in the URL",
        ));
    }

    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&params.timeout_ms) {
        return Err(coded(
            CODE_INVALID_PARAMS,
            format!("timeoutMs must be between {MIN_TIMEOUT_MS} and {MAX_TIMEOUT_MS} milliseconds"),
        ));
    }
    if !(MIN_RESPONSE_BYTES..=MAX_RESPONSE_BYTES).contains(&params.max_response_bytes) {
        return Err(coded(
            CODE_INVALID_PARAMS,
            format!(
                "maxResponseBytes must be between {MIN_RESPONSE_BYTES} and {MAX_RESPONSE_BYTES}"
            ),
        ));
    }

    let body = params.body.unwrap_or_default();
    if body.len() > MAX_BODY_BYTES {
        return Err(coded(
            CODE_INVALID_PARAMS,
            format!("Request body must be at most {MAX_BODY_BYTES} bytes"),
        ));
    }

    if params.headers.len() > MAX_HEADERS {
        return Err(coded(
            CODE_INVALID_PARAMS,
            format!("At most {MAX_HEADERS} request headers are supported"),
        ));
    }
    let mut headers = HeaderMap::with_capacity(params.headers.len());
    let mut header_bytes = 0usize;
    for header in &params.headers {
        let name = HeaderName::from_bytes(header.name.as_bytes()).map_err(|error| {
            coded(
                CODE_INVALID_PARAMS,
                format!("Invalid header name {:?}: {error}", header.name),
            )
        })?;
        let value = HeaderValue::from_str(&header.value).map_err(|error| {
            coded(
                CODE_INVALID_PARAMS,
                format!("Invalid value for header {:?}: {error}", header.name),
            )
        })?;
        if header_bytes + header.name.len() + header.value.len() > MAX_HEADER_BYTES {
            return Err(coded(
                CODE_INVALID_PARAMS,
                format!("Request headers must be at most {MAX_HEADER_BYTES} bytes"),
            ));
        }
        header_bytes += header.name.len() + header.value.len();
        headers.append(name, value);
    }

    interrupt.check("apiStudio.request")?;
    let timeout = Duration::from_millis(params.timeout_ms);
    let client = shared_client()?;
    let http_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|error| coded(CODE_INVALID_PARAMS, format!("Invalid HTTP method: {error}")))?;
    let mut request = client
        .request(http_method, url)
        .headers(headers)
        .timeout(timeout);
    if !body.is_empty() {
        request = request.body(body);
    }

    let started = Instant::now();
    let response = request
        .send()
        .map_err(|error| coded(CODE_METHOD_FAILED, format!("HTTP request failed: {error}")))?;

    let status = response.status();
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut response_headers = Vec::new();
    let mut response_header_bytes = 0usize;
    for (name, value) in response.headers().iter() {
        if response_headers.len() >= MAX_RESPONSE_HEADERS {
            break;
        }
        let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
        let size = name.as_str().len() + value.len();
        if response_header_bytes + size > MAX_RESPONSE_HEADER_BYTES {
            break;
        }
        response_header_bytes += size;
        response_headers.push(ApiHttpHeader {
            name: name.as_str().to_string(),
            value,
        });
    }

    let mut bytes = Vec::new();
    let mut reader = response.take((params.max_response_bytes + 1) as u64);
    let mut chunk = [0u8; READ_CHUNK_BYTES];
    loop {
        interrupt.check("apiStudio.request")?;
        let read = reader.read(&mut chunk).map_err(|error| {
            coded(
                CODE_METHOD_FAILED,
                format!("Reading response failed: {error}"),
            )
        })?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    let truncated = bytes.len() > params.max_response_bytes;
    if truncated {
        bytes.truncate(params.max_response_bytes);
    }
    let (body, body_encoding) = encode_body(&bytes, &content_type, truncated);

    Ok(ApiHttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or_default().to_string(),
        headers: response_headers,
        body,
        body_encoding,
        bytes: bytes.len(),
        truncated,
        duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        final_url,
    })
}

fn encode_body(bytes: &[u8], content_type: &str, truncated: bool) -> (String, &'static str) {
    if !content_type.is_empty() && !looks_textual(content_type) {
        return (BASE64.encode(bytes), "base64");
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_string(), "utf8"),
        // A truncated multibyte character at the cap is not binary data.
        Err(error) if truncated && error.error_len().is_none() => (
            String::from_utf8_lossy(&bytes[..error.valid_up_to()]).into_owned(),
            "utf8",
        ),
        Err(_) => (BASE64.encode(bytes), "base64"),
    }
}

fn looks_textual(content_type: &str) -> bool {
    content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("javascript")
        || content_type.contains("x-www-form-urlencoded")
        || content_type.contains("yaml")
        || content_type.contains("graphql")
        || content_type.contains("csv")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    fn params(url: String) -> ApiHttpRequestParams {
        ApiHttpRequestParams {
            url,
            method: "GET".into(),
            headers: vec![],
            body: None,
            timeout_ms: 5_000,
            max_response_bytes: 10_000,
        }
    }

    fn serve_once(
        status_line: &str,
        headers: &str,
        body: &[u8],
        capture: Option<mpsc::Sender<Vec<u8>>>,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        let status_line = status_line.to_string();
        let headers = headers.to_string();
        let body = body.to_vec();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept test client");
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .expect("read timeout");
            let mut request = Vec::new();
            let mut chunk = [0u8; 4096];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut chunk).expect("read request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            let header_end = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map_or(request.len(), |index| index + 4);
            let content_length = String::from_utf8_lossy(&request[..header_end])
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            while request.len() < header_end + content_length {
                let read = stream.read(&mut chunk).expect("read request body");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&chunk[..read]);
            }
            if let Some(capture) = capture {
                let _ = capture.send(request);
            }
            let response = format!(
                "HTTP/1.1 {status_line}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response head");
            stream.write_all(&body).expect("write response body");
        });
        format!("http://{address}/")
    }

    #[test]
    fn executes_get_and_reports_status_headers_and_body() {
        let url = serve_once(
            "200 OK",
            "Content-Type: application/json\r\nX-Test: yes\r\n",
            br#"{"ok":true}"#,
            None,
        );
        let response = execute(params(url), &Interrupt::never()).expect("execute GET");
        assert_eq!(response.status, 200);
        assert_eq!(response.status_text, "OK");
        assert_eq!(response.body, r#"{"ok":true}"#);
        assert_eq!(response.body_encoding, "utf8");
        assert!(!response.truncated);
        assert!(
            response.headers.iter().any(|header| {
                header.name.eq_ignore_ascii_case("x-test") && header.value == "yes"
            })
        );
    }

    #[test]
    fn sends_method_headers_and_body() {
        let (sender, receiver) = mpsc::channel();
        let url = serve_once(
            "201 Created",
            "Content-Type: application/json\r\n",
            b"{}",
            Some(sender),
        );
        let mut request = params(url);
        request.method = "post".into();
        request.headers = vec![
            ApiHttpHeader {
                name: "content-type".into(),
                value: "application/json".into(),
            },
            ApiHttpHeader {
                name: "x-custom".into(),
                value: "value".into(),
            },
        ];
        request.body = Some(r#"{"a":1}"#.into());
        let response = execute(request, &Interrupt::never()).expect("execute POST");
        assert_eq!(response.status, 201);

        let captured =
            String::from_utf8_lossy(&receiver.recv().expect("captured request")).to_string();
        assert!(captured.starts_with("POST / HTTP/1.1"), "{captured}");
        assert!(
            captured.to_ascii_lowercase().contains("x-custom: value"),
            "{captured}"
        );
        assert!(captured.ends_with(r#"{"a":1}"#), "{captured}");
    }

    #[test]
    fn truncates_responses_at_the_requested_cap() {
        let url = serve_once(
            "200 OK",
            "Content-Type: text/plain\r\n",
            &vec![b'a'; 2_000],
            None,
        );
        let mut request = params(url);
        request.max_response_bytes = 1_024;
        let response = execute(request, &Interrupt::never()).expect("execute capped GET");
        assert!(response.truncated);
        assert_eq!(response.bytes, 1_024);
        assert_eq!(response.body.len(), 1_024);
    }

    #[test]
    fn base64_encodes_binary_responses() {
        let url = serve_once(
            "200 OK",
            "Content-Type: application/octet-stream\r\n",
            &[0xff, 0x00, 0x01],
            None,
        );
        let response = execute(params(url), &Interrupt::never()).expect("execute binary GET");
        assert_eq!(response.body_encoding, "base64");
        assert_eq!(response.body, "/wAB");
    }

    #[test]
    fn rejects_unsupported_targets_and_unsafe_headers() {
        let mut file = params("file:///etc/passwd".into());
        assert_eq!(
            nd_protocol::errors::code_of(&execute(file, &Interrupt::never()).unwrap_err()),
            CODE_INVALID_PARAMS
        );

        file = params("http://user:secret@127.0.0.1/".into());
        assert!(execute(file, &Interrupt::never()).is_err());

        let mut method = params("http://127.0.0.1/".into());
        method.method = "TRACE".into();
        assert!(execute(method, &Interrupt::never()).is_err());

        let mut header = params("http://127.0.0.1/".into());
        header.headers = vec![ApiHttpHeader {
            name: "x-test".into(),
            value: "value\r\nInjected: yes".into(),
        }];
        assert!(execute(header, &Interrupt::never()).is_err());

        let mut cap = params("http://127.0.0.1/".into());
        cap.max_response_bytes = 10;
        assert!(execute(cap, &Interrupt::never()).is_err());

        let mut body = params("http://127.0.0.1/".into());
        body.body = Some("x".repeat(MAX_BODY_BYTES + 1));
        assert!(execute(body, &Interrupt::never()).is_err());
    }
}
