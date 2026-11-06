//! Native Text-to-Speech (TTS) synthesis for ND Router.
//!
//! Default provider: Microsoft Edge Read Aloud (`edge-tts`), implemented
//! natively in Rust over WebSocket (`wss://speech.platform.bing.com/...`) with
//! `Sec-MS-GEC` clock-window token generation so users do not need Python or
//! external CLI packages installed.

use crate::catalog;
use crate::types::{ProviderRecord, RouterError};
use base64::Engine as _;
use rustls::pki_types::ServerName;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

pub const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
pub const CHROMIUM_FULL_VERSION: &str = "143.0.3650.75";
pub const CHROMIUM_MAJOR_VERSION: &str = "143";
pub const SEC_MS_GEC_VERSION: &str = "2-143.0.3650.75";
pub const DEFAULT_WSS_BASE: &str =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
pub const DEFAULT_VOICE: &str = "en-US-AriaNeural";

const WIN_EPOCH_SECS: u64 = 11_644_473_600;
const MAX_TTS_INPUT_CHARS: usize = 16_000;
const MAX_AUDIO_BYTES: usize = 16 * 1024 * 1024;
const TTS_TIMEOUT_SECS: u64 = 45;

const SHA256_INITIAL: [u32; 8] = [
    0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
];
const SHA256_STATE: [u32; 8] = [
    0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A, 0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2,
];
const SHA256_SCHEDULE: [u32; 14] = [
    0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA, 0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
    0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33, 0xD258B060, 0x72766564,
];
const SHA256_ROUND_CONSTANTS: [u32; 64] = [
    0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
    0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
    0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
    0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
    0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
    0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
    0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
    0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];
const SHA256_ADJUSTMENT: u32 = 0xC9DC06A7;
const SHA256_SIGMA0_ADJUSTMENT: u32 = 0x059C0B80;
const SHA256_SIGMA1_ADJUSTMENT: u32 = 0x000B92C0;

const CS64_COEFFICIENTS: [(u32, u32); 14] = [
    (0xE82E91B1, 0xB32700D0),
    (0x44DE24C6, 0x88DFF51D),
    (0x3BEB65BC, 0x29514038),
    (0xC89C5933, 0xB328CBDF),
    (0x8D1EC211, 0xD405B4D5),
    (0x314EF5D5, 0x26E55F3C),
    (0xE92491B1, 0x607801C6),
    (0xF0A5B9D5, 0x82B2C1FB),
    (0x06064CF3, 0xFA51A3DA),
    (0xDA79FA60, 0x207CC464),
    (0xBED20560, 0x3C3C74F3),
    (0x89F9C9F8, 0xD2D14B61),
    (0x35FA38C6, 0xBB04A2C1),
    (0xCB49E3C6, 0xC5626167),
];
const CS64_FACTOR: u32 = 0x82893933;
const CS64_ADJUSTMENT0: u32 = 0xF2F90B1A;
const CS64_ADJUSTMENT1: u32 = 0x0B1A0000;

#[derive(Clone, Debug)]
pub struct TtsSynthesisResult {
    pub audio: Vec<u8>,
    pub content_type: &'static str,
    pub format_ext: &'static str,
    pub voice: String,
}

fn rol16(value: u32) -> u32 {
    value.rotate_left(16)
}

fn words_le4_even(data: &[u8]) -> Vec<u32> {
    if data.is_empty() {
        return Vec::new();
    }
    let rem = data.len() % 4;
    let pad = if rem == 0 { 0 } else { 4 - rem };
    let mut padded = Vec::with_capacity(data.len() + pad);
    padded.extend_from_slice(data);
    padded.resize(data.len() + pad, 0);
    let mut words: Vec<u32> = padded
        .as_chunks::<4>()
        .0
        .iter()
        .copied()
        .map(u32::from_le_bytes)
        .collect();
    if words.len() % 2 == 1 {
        words.push(0);
    }
    words
}

fn sigma0(value: u32) -> u32 {
    value.rotate_right(7) ^ value.rotate_right(18) ^ (value >> 3)
}

fn sigma1(value: u32) -> u32 {
    value.rotate_right(17) ^ value.rotate_right(19) ^ (value >> 10)
}

fn sha256_rounds(state: [u32; 8], words: &[u32; 64], first_round: usize) -> [u32; 8] {
    let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
    for index in first_round..64 {
        let k = if first_round == 14 && index == 14 {
            SHA256_ADJUSTMENT
        } else {
            SHA256_ROUND_CONSTANTS[index]
        };
        let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
        let ch = g ^ (e & (f ^ g));
        let t1 = h
            .wrapping_add(s1)
            .wrapping_add(ch)
            .wrapping_add(k)
            .wrapping_add(words[index]);
        let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
        let maj = (a & b) | (c & (a | b));
        let t2 = s0.wrapping_add(maj);
        h = g;
        g = f;
        f = e;
        e = d.wrapping_add(t1);
        d = c;
        c = b;
        b = a;
        a = t1.wrapping_add(t2);
    }
    [a, b, c, d, e, f, g, h]
}

fn expand_sha256_schedule(words: &mut [u32; 64], first_word: usize) {
    for index in first_word..64 {
        let s1 = sigma1(words[index - 2]);
        let s0 = sigma0(words[index - 15]);
        words[index] = s1
            .wrapping_add(words[index - 7])
            .wrapping_add(s0)
            .wrapping_add(words[index - 16]);
    }
}

fn sha256_init(data7: &[u8]) -> [u32; 8] {
    let mut words = [0u32; 64];
    words[14] = ((data7[0] as u32) << 16) | ((data7[1] as u32) << 8) | (data7[2] as u32);
    words[15] = u32::from_be_bytes([data7[3], data7[4], data7[5], data7[6]]);
    for index in 16..30 {
        let mut value = SHA256_SCHEDULE[index - 16];
        if index - 2 >= 14 {
            let term = if index == 16 {
                sigma1(words[index - 2]) ^ SHA256_SIGMA1_ADJUSTMENT
            } else {
                sigma1(words[index - 2])
            };
            value = value.wrapping_add(term);
        }
        if index - 7 >= 14 {
            value = value.wrapping_add(words[index - 7]);
        }
        if index - 15 >= 14 {
            let term = if index == 29 {
                sigma0(words[index - 15]) ^ SHA256_SIGMA0_ADJUSTMENT
            } else {
                sigma0(words[index - 15])
            };
            value = value.wrapping_add(term);
        }
        words[index] = value;
    }
    words[30] = sigma1(words[28])
        .wrapping_add(words[23])
        .wrapping_add(sigma0(words[15]))
        .wrapping_add(words[14])
        .wrapping_add(SHA256_ADJUSTMENT)
        .wrapping_sub(SHA256_ROUND_CONSTANTS[14]);
    expand_sha256_schedule(&mut words, 31);
    let working = sha256_rounds(SHA256_STATE, &words, 14);
    std::array::from_fn(|i| SHA256_INITIAL[i].wrapping_add(working[i]))
}

fn sha256_digest(data: &[u8]) -> [u8; 32] {
    let length = 57 + data.len();
    let mut padded = Vec::from(&data[7..]);
    padded.push(0x80);
    let pad_zeros = (55isize - (length as isize)).rem_euclid(64) as usize;
    padded.resize(padded.len() + pad_zeros, 0);
    padded.extend_from_slice(&((length as u64) * 8).to_be_bytes());
    let mut state = sha256_init(&data[..7]);
    for chunk in padded.as_chunks::<64>().0 {
        let mut words = [0u32; 64];
        for (i, &word_bytes) in chunk.as_chunks::<4>().0.iter().enumerate() {
            words[i] = u32::from_be_bytes(word_bytes);
        }
        expand_sha256_schedule(&mut words, 16);
        let working = sha256_rounds(state, &words, 0);
        for i in 0..8 {
            state[i] = state[i].wrapping_add(working[i]);
        }
    }
    let mut out = [0u8; 32];
    for (i, word) in state.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

fn cs64_digest(data: &[u8], digest: &[u8; 32]) -> (u32, u32) {
    let key_a = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]) | 1;
    let key_b = u32::from_le_bytes([digest[4], digest[5], digest[6], digest[7]]) | 1;
    let factors = [
        key_a.wrapping_mul(CS64_FACTOR),
        key_b.wrapping_mul(CS64_FACTOR),
    ];
    let mut terms: Vec<u32> = CS64_COEFFICIENTS
        .iter()
        .enumerate()
        .map(|(i, &(coeff, _))| coeff.wrapping_mul(factors[i % 2]))
        .collect();
    let mut offsets: Vec<u32> = CS64_COEFFICIENTS.iter().map(|&(_, off)| off).collect();
    let mut prefixed = Vec::with_capacity(1 + data.len());
    prefixed.push(0);
    prefixed.extend_from_slice(data);
    for (index, word) in words_le4_even(&prefixed).into_iter().enumerate() {
        let mut term = word.wrapping_mul(if index % 2 == 0 { key_a } else { key_b });
        let mut offset = rol16(word).wrapping_mul(if index % 2 == 0 {
            0xEF0569FB
        } else {
            0xC31713DB
        });
        if index == 0 {
            term = term.wrapping_add(CS64_ADJUSTMENT0.wrapping_mul(factors[0]));
            offset = offset.wrapping_add(CS64_ADJUSTMENT1);
        }
        terms.push(term);
        offsets.push(offset);
    }
    let mut swap_acc = 0u32;
    let mut swap_last = 0u32;
    let mut state = 0u32;
    let mut acc = 0u32;
    for index in (0..terms.len()).step_by(2) {
        let x = terms[index];
        let y = terms[index + 1];
        let t = rol16(offsets[index].wrapping_add(x));
        let q = t.wrapping_mul(0x76F50F34);
        swap_acc = swap_acc.wrapping_add(rol16(q).wrapping_mul(0xC3EFEA97).wrapping_add(q));
        let t = rol16(offsets[index + 1].wrapping_add(y));
        let q = t.wrapping_mul(0x1881CE3C);
        swap_last = rol16(q).wrapping_mul(0x35BD1EC9).wrapping_add(q);
        swap_acc = swap_acc.wrapping_add(swap_last);

        state = state.wrapping_mul(key_a).wrapping_add(x);
        state = rol16(state).wrapping_mul(0xCF98B111);
        state = rol16(state).wrapping_mul(0x87085B9F);
        state = rol16(state).wrapping_mul(0x12CEB96D);
        state = rol16(state).wrapping_mul(0x257E1D83);
        acc = acc.wrapping_add(state);
        let mut t = state.wrapping_mul(key_b).wrapping_add(y);
        t = rol16(t).wrapping_mul(0xA27416F5);
        t = rol16(t).wrapping_mul(0xD38396FF);
        state = rol16(rol16(t).wrapping_mul(0x7C932B89)).wrapping_mul(0xBFA49F69);
        acc = acc.wrapping_add(state);
    }
    (swap_last ^ state, swap_acc ^ acc)
}

/// Compute the v2 `Sec-MS-GEC` token (`<16 hex CS64>-<64 hex SHA256>`) for a
/// given Unix timestamp. Rounds down to the nearest 5-minute (300s) window in
/// Windows filetime ticks (100ns intervals since 1601-01-01).
pub fn generate_sec_ms_gec(unix_secs: u64) -> String {
    let mut ticks = unix_secs.saturating_add(WIN_EPOCH_SECS);
    ticks -= ticks % 300;
    let ticks_100ns = ticks.saturating_mul(10_000_000);
    let to_hash = format!("{ticks_100ns}{TRUSTED_CLIENT_TOKEN}");
    let data = to_hash.as_bytes();
    let digest = sha256_digest(data);
    let (cs_lo, cs_hi) = cs64_digest(data, &digest);
    let mut cs_bytes = [0u8; 8];
    cs_bytes[0..4].copy_from_slice(&cs_lo.to_le_bytes());
    cs_bytes[4..8].copy_from_slice(&cs_hi.to_le_bytes());
    let mut out = String::with_capacity(81);
    for byte in cs_bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02X}");
    }
    out.push('-');
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02X}");
    }
    out
}

fn current_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(1_730_000_000)
}

/// Map OpenAI voice aliases (`alloy`, `nova`, `echo`, etc.) or model hints to
/// an Edge TTS neural voice identifier.
pub fn resolve_voice(voice_hint: Option<&str>, model_hint: Option<&str>) -> String {
    if let Some(resolved) = normalize_voice_candidate(voice_hint) {
        return resolved;
    }
    if let Some(resolved) = normalize_voice_candidate(model_hint) {
        return resolved;
    }
    DEFAULT_VOICE.to_owned()
}

fn normalize_voice_candidate(candidate: Option<&str>) -> Option<String> {
    let raw = candidate?.trim();
    if raw.is_empty() {
        return None;
    }
    let stripped = raw
        .split_once('/')
        .map(|(_, model)| model.trim())
        .unwrap_or(raw);
    match stripped.to_ascii_lowercase().as_str() {
        "" | "default" | "edge-tts" | "tts-1" | "tts-1-hd" | "gpt-4o-mini-tts" => None,
        "alloy" => Some("en-US-AriaNeural".to_owned()),
        "echo" => Some("en-US-GuyNeural".to_owned()),
        "fable" => Some("en-GB-SoniaNeural".to_owned()),
        "onyx" => Some("en-US-ChristopherNeural".to_owned()),
        "nova" => Some("en-US-AvaMultilingualNeural".to_owned()),
        "shimmer" => Some("en-US-JennyNeural".to_owned()),
        "ash" => Some("en-US-AndrewNeural".to_owned()),
        "coral" => Some("en-US-EmmaNeural".to_owned()),
        "sage" => Some("en-US-BrianNeural".to_owned()),
        _ => {
            if stripped.len() <= 128
                && stripped
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
            {
                Some(stripped.to_owned())
            } else {
                None
            }
        }
    }
}

pub fn resolve_output_format(
    response_format: Option<&str>,
) -> (&'static str, &'static str, &'static str) {
    match response_format
        .map(|f| f.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("wav") | Some("pcm") => ("riff-24khz-16bit-mono-pcm", "audio/wav", "wav"),
        Some("opus") | Some("ogg") | Some("webm") => {
            ("webm-24khz-16bit-mono-opus", "audio/webm", "webm")
        }
        _ => ("audio-24khz-48kbitrate-mono-mp3", "audio/mpeg", "mp3"),
    }
}

pub fn speed_to_rate(speed: Option<f64>) -> String {
    let clamped = speed.unwrap_or(1.0).clamp(0.25, 3.0);
    let pct = ((clamped - 1.0) * 100.0).round() as i32;
    if pct >= 0 {
        format!("+{pct}%")
    } else {
        format!("{pct}%")
    }
}

pub fn voice_locale(voice: &str) -> String {
    let parts: Vec<&str> = voice.split('-').collect();
    if parts.len() >= 2 && parts[0].len() == 2 && parts[1].len() == 2 {
        format!("{}-{}", parts[0], parts[1])
    } else {
        "en-US".to_owned()
    }
}

pub fn escape_ssml_text(input: &str) -> String {
    let mut escaped = String::with_capacity(input.len() + 16);
    for ch in input.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            c if c.is_control() && !matches!(c, '\n' | '\r' | '\t') => {}
            c => escaped.push(c),
        }
    }
    escaped
}

pub fn build_ssml(text: &str, voice: &str, rate: &str) -> String {
    let lang = voice_locale(voice);
    let escaped = escape_ssml_text(text);
    format!(
        "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{lang}'><voice name='{voice}'><prosody pitch='+0Hz' rate='{rate}' volume='+0%'>{escaped}</prosody></voice></speak>"
    )
}

pub fn voice_catalog(providers: &[ProviderRecord]) -> Value {
    let builtins = [
        ("en-US-AriaNeural", "Aria (US English)", "en-US", "Female"),
        (
            "en-US-AvaMultilingualNeural",
            "Ava Multilingual (US English)",
            "en-US",
            "Female",
        ),
        ("en-US-GuyNeural", "Guy (US English)", "en-US", "Male"),
        ("en-US-JennyNeural", "Jenny (US English)", "en-US", "Female"),
        ("en-GB-SoniaNeural", "Sonia (UK English)", "en-GB", "Female"),
        (
            "zh-CN-XiaoxiaoNeural",
            "Xiaoxiao (Chinese Mainland)",
            "zh-CN",
            "Female",
        ),
        ("ja-JP-NanamiNeural", "Nanami (Japanese)", "ja-JP", "Female"),
        ("km-KH-SreymomNeural", "Sreymom (Khmer)", "km-KH", "Female"),
        ("km-KH-PisethNeural", "Piseth (Khmer)", "km-KH", "Male"),
    ];
    let mut seen = std::collections::HashSet::new();
    let mut data = Vec::new();
    for (id, label, locale, gender) in builtins {
        seen.insert(id.to_owned());
        data.push(json!({
            "id": id,
            "object": "voice",
            "name": label,
            "locale": locale,
            "gender": gender,
            "provider": catalog::KIND_EDGE_TTS,
        }));
    }
    for provider in providers
        .iter()
        .filter(|provider| provider.is_active && catalog::is_tts_kind(&provider.kind))
    {
        for model in &provider.models {
            if seen.insert(model.clone()) {
                data.push(json!({
                    "id": model,
                    "object": "voice",
                    "name": model,
                    "locale": voice_locale(model),
                    "gender": "Neutral",
                    "provider": provider.id,
                }));
            }
        }
    }
    json!({
        "object": "list",
        "data": data,
    })
}

/// Synthesize speech through Microsoft Edge Read Aloud (`edge-tts`).
pub async fn synthesize_edge_tts(
    provider: &ProviderRecord,
    text: &str,
    voice_hint: Option<&str>,
    model_hint: Option<&str>,
    response_format: Option<&str>,
    speed: Option<f64>,
) -> Result<TtsSynthesisResult, RouterError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(RouterError::bad_request("TTS input text must not be empty"));
    }
    if trimmed.chars().count() > MAX_TTS_INPUT_CHARS {
        return Err(RouterError::bad_request(format!(
            "TTS input text exceeds maximum length of {MAX_TTS_INPUT_CHARS} characters"
        )));
    }
    let voice = resolve_voice(voice_hint, model_hint);
    let (edge_format, content_type, format_ext) = resolve_output_format(response_format);
    let rate = speed_to_rate(speed);
    let ssml = build_ssml(trimmed, &voice, &rate);

    let base_url = std::env::var("ND_EDGE_TTS_WSS_URL")
        .ok()
        .map(|val| val.trim().to_owned())
        .filter(|val| !val.is_empty())
        .or_else(|| {
            let trimmed_base = provider.base_url.trim();
            if trimmed_base.is_empty() {
                None
            } else {
                Some(trimmed_base.to_owned())
            }
        })
        .unwrap_or_else(|| DEFAULT_WSS_BASE.to_owned());

    let audio = tokio::time::timeout(
        Duration::from_secs(TTS_TIMEOUT_SECS),
        run_edge_ws_session(&base_url, edge_format, &ssml),
    )
    .await
    .map_err(|_| RouterError::bad_gateway("Edge TTS synthesis timed out"))??;

    if audio.is_empty() {
        return Err(RouterError::bad_gateway(
            "Edge TTS finished without returning audio bytes",
        ));
    }

    Ok(TtsSynthesisResult {
        audio,
        content_type,
        format_ext,
        voice,
    })
}

async fn run_edge_ws_session(
    base_url: &str,
    edge_format: &str,
    ssml: &str,
) -> Result<Vec<u8>, RouterError> {
    let connection_id = uuid::Uuid::new_v4().simple().to_string();
    let sec_ms_gec = generate_sec_ms_gec(current_unix_secs());
    let separator = if base_url.contains('?') { '&' } else { '?' };
    let full_url = format!(
        "{base_url}{separator}TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={sec_ms_gec}&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}&ConnectionId={connection_id}"
    );
    let parsed = url::Url::parse(&full_url)
        .map_err(|error| RouterError::bad_request(format!("invalid Edge TTS URL: {error}")))?;
    let scheme = parsed.scheme();
    let use_tls = match scheme {
        "wss" | "https" => true,
        "ws" | "http" => false,
        other => {
            return Err(RouterError::bad_request(format!(
                "unsupported Edge TTS scheme: {other}"
            )));
        }
    };
    let host = parsed
        .host_str()
        .ok_or_else(|| RouterError::bad_request("Edge TTS URL is missing host"))?
        .to_owned();
    let port = parsed
        .port_or_known_default()
        .unwrap_or(if use_tls { 443 } else { 80 });
    let path_and_query = match parsed.query() {
        Some(q) => format!("{}?{q}", parsed.path()),
        None => parsed.path().to_owned(),
    };

    let tcp = TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|error| {
            RouterError::bad_gateway(format!("Edge TTS connection failed: {error}"))
        })?;

    if use_tls {
        let mut root_store = rustls::RootCertStore::empty();
        root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let config = rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();
        let connector = TlsConnector::from(Arc::new(config));
        let server_name = ServerName::try_from(host.clone())
            .map_err(|_| RouterError::bad_request("invalid TLS server name for Edge TTS"))?;
        let tls_stream = connector.connect(server_name, tcp).await.map_err(|error| {
            RouterError::bad_gateway(format!("Edge TTS TLS handshake failed: {error}"))
        })?;
        exchange_edge_frames(tls_stream, &host, port, &path_and_query, edge_format, ssml).await
    } else {
        exchange_edge_frames(tcp, &host, port, &path_and_query, edge_format, ssml).await
    }
}

async fn exchange_edge_frames<S>(
    mut stream: S,
    host: &str,
    port: u16,
    path_and_query: &str,
    edge_format: &str,
    ssml: &str,
) -> Result<Vec<u8>, RouterError>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let ws_key = base64::engine::general_purpose::STANDARD.encode(uuid::Uuid::new_v4().as_bytes());
    let muid = uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .to_ascii_uppercase();
    let host_header = if port == 80 || port == 443 {
        host.to_owned()
    } else {
        format!("{host}:{port}")
    };
    let handshake = format!(
        "GET {path_and_query} HTTP/1.1\r\n\
         Host: {host_header}\r\n\
         Upgrade: websocket\r\n\
         Connection: Upgrade\r\n\
         Sec-WebSocket-Key: {ws_key}\r\n\
         Sec-WebSocket-Version: 13\r\n\
         Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold\r\n\
         User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/{CHROMIUM_MAJOR_VERSION}.0.0.0\r\n\
         Accept-Encoding: gzip, deflate, br, zstd\r\n\
         Accept-Language: en-US,en;q=0.9\r\n\
         Cookie: muid={muid};\r\n\
         Pragma: no-cache\r\n\
         Cache-Control: no-cache\r\n\r\n"
    );

    stream
        .write_all(handshake.as_bytes())
        .await
        .map_err(|error| {
            RouterError::bad_gateway(format!("Edge TTS handshake write failed: {error}"))
        })?;
    stream.flush().await.map_err(|error| {
        RouterError::bad_gateway(format!("Edge TTS handshake flush failed: {error}"))
    })?;

    let mut buffer = Vec::with_capacity(4096);
    let header_end = loop {
        if let Some(pos) = find_header_end(&buffer) {
            break pos;
        }
        if buffer.len() > 16 * 1024 {
            return Err(RouterError::bad_gateway(
                "Edge TTS WebSocket upgrade header exceeded limit",
            ));
        }
        let mut temp = [0u8; 1024];
        let read = stream.read(&mut temp).await.map_err(|error| {
            RouterError::bad_gateway(format!("Edge TTS handshake read failed: {error}"))
        })?;
        if read == 0 {
            return Err(RouterError::bad_gateway(
                "Edge TTS server closed connection during WebSocket handshake",
            ));
        }
        buffer.extend_from_slice(&temp[..read]);
    };

    let response_headers = String::from_utf8_lossy(&buffer[..header_end]);
    let status_line = response_headers.lines().next().unwrap_or_default();
    if !status_line.contains(" 101 ") {
        return Err(RouterError::bad_gateway(format!(
            "Edge TTS rejected WebSocket upgrade: {status_line}"
        )));
    }

    let mut reader = BufferedWsStream {
        stream,
        buf: buffer.split_off(header_end),
    };

    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let config_msg = format!(
        "X-Timestamp:Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)\r\n\
         Content-Type:application/json; charset=utf-8\r\n\
         Path:speech.config\r\n\r\n\
         {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":\"true\",\"wordBoundaryEnabled\":\"false\"}},\"outputFormat\":\"{edge_format}\"}}}}}}}}\r\n"
    );
    write_masked_frame(&mut reader.stream, 0x1, config_msg.as_bytes()).await?;

    let ssml_msg = format!(
        "X-RequestId:{request_id}\r\n\
         Content-Type:application/ssml+xml\r\n\
         X-Timestamp:Thu Jan 01 1970 00:00:00 GMT+0000 (Coordinated Universal Time)Z\r\n\
         Path:ssml\r\n\r\n\
         {ssml}"
    );
    write_masked_frame(&mut reader.stream, 0x1, ssml_msg.as_bytes()).await?;

    let mut audio = Vec::new();
    let mut fragmented_opcode = 0u8;
    let mut fragmented_payload = Vec::new();

    loop {
        let (fin, opcode, payload) = match reader.read_frame().await {
            Ok(frame) => frame,
            Err(error) if !audio.is_empty() && error.message.contains("closed") => break,
            Err(error) => return Err(error),
        };

        let (effective_opcode, full_payload) = match opcode {
            0x8 => break,
            0x9 => {
                let _ = write_masked_frame(&mut reader.stream, 0xA, &payload).await;
                continue;
            }
            0xA => continue,
            0x0 => {
                fragmented_payload.extend_from_slice(&payload);
                if !fin {
                    continue;
                }
                let completed = std::mem::take(&mut fragmented_payload);
                (fragmented_opcode, completed)
            }
            op => {
                if !fin {
                    fragmented_opcode = op;
                    fragmented_payload.clear();
                    fragmented_payload.extend_from_slice(&payload);
                    continue;
                }
                (op, payload)
            }
        };

        if effective_opcode == 0x2 {
            if full_payload.len() >= 2 {
                let header_len = u16::from_be_bytes([full_payload[0], full_payload[1]]) as usize;
                if 2 + header_len <= full_payload.len() {
                    let header = String::from_utf8_lossy(&full_payload[2..2 + header_len]);
                    if header.contains("Path:audio") {
                        let chunk = &full_payload[2 + header_len..];
                        if audio.len() + chunk.len() > MAX_AUDIO_BYTES {
                            return Err(RouterError::bad_gateway(
                                "Edge TTS audio stream exceeded maximum byte budget",
                            ));
                        }
                        audio.extend_from_slice(chunk);
                    }
                }
            }
        } else if effective_opcode == 0x1 {
            let text = String::from_utf8_lossy(&full_payload);
            if text.contains("Path:turn.end") {
                break;
            }
        }
    }

    let _ = write_masked_frame(&mut reader.stream, 0x8, &[]).await;
    Ok(audio)
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|pos| pos + 4)
}

async fn write_masked_frame<S: AsyncWrite + Unpin>(
    stream: &mut S,
    opcode: u8,
    payload: &[u8],
) -> Result<(), RouterError> {
    let mut frame = Vec::with_capacity(14 + payload.len());
    frame.push(0x80 | (opcode & 0x0F));
    let len = payload.len();
    if len < 126 {
        frame.push(0x80 | (len as u8));
    } else if len <= u16::MAX as usize {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        frame.push(0x80 | 127);
        frame.extend_from_slice(&(len as u64).to_be_bytes());
    }
    let mask_bytes = uuid::Uuid::new_v4();
    let mask: [u8; 4] = [
        mask_bytes.as_bytes()[0],
        mask_bytes.as_bytes()[1],
        mask_bytes.as_bytes()[2],
        mask_bytes.as_bytes()[3],
    ];
    frame.extend_from_slice(&mask);
    for (index, byte) in payload.iter().enumerate() {
        frame.push(byte ^ mask[index & 3]);
    }
    stream.write_all(&frame).await.map_err(|error| {
        RouterError::bad_gateway(format!("Edge TTS frame write failed: {error}"))
    })?;
    stream.flush().await.map_err(|error| {
        RouterError::bad_gateway(format!("Edge TTS frame flush failed: {error}"))
    })?;
    Ok(())
}

struct BufferedWsStream<S> {
    stream: S,
    buf: Vec<u8>,
}

impl<S: AsyncRead + Unpin> BufferedWsStream<S> {
    async fn read_exact_bytes(&mut self, len: usize) -> Result<Vec<u8>, RouterError> {
        while self.buf.len() < len {
            let mut temp = [0u8; 4096];
            let read = self.stream.read(&mut temp).await.map_err(|error| {
                RouterError::bad_gateway(format!("Edge TTS read error: {error}"))
            })?;
            if read == 0 {
                return Err(RouterError::bad_gateway("Edge TTS stream closed"));
            }
            self.buf.extend_from_slice(&temp[..read]);
        }
        let remainder = self.buf.split_off(len);
        let out = std::mem::replace(&mut self.buf, remainder);
        Ok(out)
    }

    async fn read_frame(&mut self) -> Result<(bool, u8, Vec<u8>), RouterError> {
        let head = self.read_exact_bytes(2).await?;
        let fin = (head[0] & 0x80) != 0;
        let opcode = head[0] & 0x0F;
        let masked = (head[1] & 0x80) != 0;
        let mut len = (head[1] & 0x7F) as usize;
        if len == 126 {
            let ext = self.read_exact_bytes(2).await?;
            len = u16::from_be_bytes([ext[0], ext[1]]) as usize;
        } else if len == 127 {
            let ext = self.read_exact_bytes(8).await?;
            len = u64::from_be_bytes([
                ext[0], ext[1], ext[2], ext[3], ext[4], ext[5], ext[6], ext[7],
            ]) as usize;
        }
        if len > MAX_AUDIO_BYTES {
            return Err(RouterError::bad_gateway(
                "Edge TTS frame exceeded maximum size limit",
            ));
        }
        let mask = if masked {
            Some(self.read_exact_bytes(4).await?)
        } else {
            None
        };
        let mut payload = self.read_exact_bytes(len).await?;
        if let Some(mask) = mask {
            for (index, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[index & 3];
            }
        }
        Ok((fin, opcode, payload))
    }
}
