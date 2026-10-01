//! Outbound HTTP for the deterministic data path (design §5.1, §7.1).
//!
//! `http-request` nodes never open a socket from the webview. The engine builds
//! a fully described request that carries **no credential**, hands it to this
//! command together with the connection reference, and Rust does the two things
//! the webview must not do: read the connection secrets out of the OS keychain
//! and apply them to the outbound request.
//!
//! Three invariants shape this module:
//!
//! 1. **Secrets stay in Rust** (Requirement 3.3). Values are read through the
//!    existing chunked keychain path in [`crate::llm`], applied here, and
//!    scrubbed out of every byte that crosses the IPC boundary back to the
//!    webview — response body, response headers and error messages alike. On
//!    desktop this is the only component that knows the values, so it is also
//!    the only place that can keep them out of a run trace.
//! 2. **Connection auth wins** (Requirement 8.5, 8.6). Caller headers land
//!    first, any `Authorization` among them is dropped, and the connection auth
//!    is applied last.
//! 3. **A transport failure is classified, an HTTP status is not a failure**
//!    (Requirement 8.16). Every status — 3xx, 4xx, 5xx — comes back as a
//!    response; only a request that produced no response fails, carrying one of
//!    the six `TransportFailureKind` values from `engine/src/data-host.ts`.

use std::{collections::HashMap, error::Error as StdError, time::Duration, time::Instant};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};

use crate::llm::read_connection_secret;

/// Replacement written over a secret value that would otherwise cross IPC.
/// Mirrors `REDACTED` in `engine/src/redact.ts` so a scrubbed value looks the
/// same wherever it was scrubbed.
const REDACTED: &str = "[redacted]";

/// Shortest value worth scrubbing, mirroring `MIN_SECRET_LEN` in
/// `engine/src/redact.ts`: a shorter "secret" collides with ordinary text far
/// more often than it protects anything.
const MIN_SECRET_LEN: usize = 8;

/// Per-attempt timeout when the caller declares none (Requirement 8.20).
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Accepted timeout range, mirroring the engine's 1 to 300 second bound.
const MIN_TIMEOUT_MS: u64 = 1_000;
const MAX_TIMEOUT_MS: u64 = 300_000;

/// Response byte cap when the caller declares none (Requirement 8.18).
const DEFAULT_MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;

/// `Connection.id` shape, mirroring `CONNECTION_ID_PATTERN` in
/// `engine/src/connections.ts`.
const CONNECTION_ID_PREFIX: &str = "conn-";
const CONNECTION_ID_MAX_SUFFIX: usize = 64;

// ─────────────────────────────────────────────────────────────────────────────
// IPC data transfer objects
// ─────────────────────────────────────────────────────────────────────────────

/// One outbound request, mirroring `DataRequest` in `engine/src/data-host.ts`.
/// Carries no credential: authentication is derived solely from the connection.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRequestDto {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    /// `base64` when `body` carries binary content the host must decode first.
    #[serde(default)]
    pub body_encoding: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub max_response_bytes: Option<u64>,
}

/// The answer to a [`DataRequestDto`], mirroring `DataResponse`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataResponseDto {
    pub status: u16,
    /// Lower-cased header names, including `retry-after` and `link` when the
    /// response carried them (Requirement 8.17).
    pub headers: HashMap<String, String>,
    pub body: String,
    /// True when `maxResponseBytes` clipped the body (Requirement 8.18).
    pub truncated: bool,
    /// Bytes retained, which for a truncated body is the cap.
    pub byte_count: u64,
    pub duration_ms: u64,
}

/// A failure crossing IPC, already scrubbed of every resolved secret.
///
/// `kind` is one of the six `TransportFailureKind` values (`connect`, `dns`,
/// `tls`, `timeout`, `aborted`, `unknown`) when a request produced no response,
/// or [`KIND_CONFIG`] when the call was rejected before any socket was opened —
/// the caller turns the former into a `DataTransportError` and the latter into a
/// plain failure, because an unsent malformed request must not be retried as if
/// the network had hiccupped.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataErrorDto {
    pub kind: String,
    pub message: String,
}

/// Kind reported for a request rejected before any I/O (invalid method or url,
/// a missing secret). Deliberately outside the six transport kinds.
pub const KIND_CONFIG: &str = "config";

/// How the host applies resolved secrets, mirroring `ConnectionAuth` in
/// `engine/src/connections.ts`.
///
/// The two OAuth modes are applied as a bearer token read from the
/// `accessToken` secret: acquisition and single-flight refresh are the
/// `ConnectionStore`'s job (design §7), and the refreshed token is written back
/// to the keychain, so by the time a request goes out the live token is just
/// another connection secret.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode")]
pub enum AuthDto {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "bearer", rename_all = "camelCase")]
    Bearer { secret_key: String },
    #[serde(rename = "basic", rename_all = "camelCase")]
    Basic {
        user_secret_key: String,
        password_secret_key: String,
    },
    #[serde(rename = "header", rename_all = "camelCase")]
    Header {
        header: String,
        secret_key: String,
        #[serde(default)]
        prefix: Option<String>,
    },
    #[serde(rename = "query", rename_all = "camelCase")]
    Query { param: String, secret_key: String },
    #[serde(rename = "oauth2-client-credentials")]
    Oauth2ClientCredentials,
    #[serde(rename = "oauth2-refresh")]
    Oauth2Refresh,
    #[serde(rename = "aws-sigv4")]
    AwsSigV4,
}

/// Secret key holding the live OAuth access token (design §7).
const ACCESS_TOKEN_SECRET_KEY: &str = "accessToken";

// ─────────────────────────────────────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────────────────────────────────────

/// Performs one outbound data request, resolving and applying the connection
/// secrets inside Rust.
///
/// Returns a response for every HTTP status. Fails only when the request
/// produced no response, or when it was rejected before any I/O.
///
/// # Errors
///
/// Returns a [`DataErrorDto`] whose `message` contains no secret value, in
/// whole or as a substring.
#[tauri::command]
pub async fn data_request(
    connection_id: Option<String>,
    secret_keys: Vec<String>,
    auth: Option<AuthDto>,
    request: DataRequestDto,
) -> Result<DataResponseDto, DataErrorDto> {
    let connection_id = connection_id.unwrap_or_default();
    // Complete-or-reject: every declared secret is read before a socket opens,
    // so a request can never go out half-authenticated (Requirement 2.3).
    let secrets = resolve_secrets(&connection_id, &secret_keys)?;
    let values: Vec<String> = secrets.values().cloned().collect();

    match perform(request, auth.as_ref(), &connection_id, &secrets).await {
        Ok(mut response) => {
            response.body = scrub(&response.body, &values);
            for value in response.headers.values_mut() {
                *value = scrub(value, &values);
            }
            Ok(response)
        }
        Err(error) => Err(DataErrorDto {
            kind: error.kind,
            message: scrub(&error.message, &values),
        }),
    }
}

/// Reads every declared secret for a connection out of the OS keychain.
///
/// An empty `connection_id` with no declared keys means "no connection", which
/// is the normal case for an unauthenticated request.
///
/// Shared with [`crate::sql`], so both data commands resolve credentials
/// through exactly one complete-or-reject path.
pub(crate) fn resolve_secrets(
    connection_id: &str,
    secret_keys: &[String],
) -> Result<HashMap<String, String>, DataErrorDto> {
    let mut secrets = HashMap::new();
    if secret_keys.is_empty() {
        return Ok(secrets);
    }
    validate_connection_id(connection_id)?;

    for key in secret_keys {
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let Some(value) = read_connection_secret(connection_id, key).map_err(config_error)? else {
            // Discard everything read so far rather than resolve a subset.
            drop(secrets);
            return Err(config_error(format!(
                "Connection \"{connection_id}\" is missing the secret \"{key}\"."
            )));
        };
        secrets.insert(key.to_owned(), value);
    }
    Ok(secrets)
}

/// Rejects anything that is not a `conn-` prefixed identifier, naming the
/// rejected value (Requirement 2.11).
fn validate_connection_id(connection_id: &str) -> Result<(), DataErrorDto> {
    let suffix = connection_id.strip_prefix(CONNECTION_ID_PREFIX).unwrap_or("");
    let shaped = !suffix.is_empty()
        && suffix.len() <= CONNECTION_ID_MAX_SUFFIX
        && suffix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if shaped {
        Ok(())
    } else {
        Err(config_error(format!(
            "Invalid connection id \"{connection_id}\": expected conn- followed by 1 to {CONNECTION_ID_MAX_SUFFIX} of A-Z a-z 0-9 _ -."
        )))
    }
}

/// Builds and sends the request, enforcing the timeout and the byte cap.
async fn perform(
    request: DataRequestDto,
    auth: Option<&AuthDto>,
    connection_id: &str,
    secrets: &HashMap<String, String>,
) -> Result<DataResponseDto, DataErrorDto> {
    let method = reqwest::Method::from_bytes(request.method.trim().to_uppercase().as_bytes())
        .map_err(|_| config_error(format!("Unsupported HTTP method '{}'.", request.method)))?;

    let mut url = request.url.trim().to_owned();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err(config_error(format!("Unsupported URL '{url}'.")));
    }

    let mut headers = header_map(&request.headers)?;
    if let Some(auth) = auth {
        url = apply_auth(&mut headers, auth, connection_id, secrets, url)?;
    }

    let timeout = Duration::from_millis(effective_timeout_ms(request.timeout_ms));
    let cap = effective_max_response_bytes(request.max_response_bytes);

    let mut builder = reqwest::Client::new()
        .request(method, &url)
        .headers(headers)
        .timeout(timeout);
    if let Some(body) = request.body {
        if request.body_encoding.as_deref() == Some("base64") {
            // Binary bodies (multipart uploads) cross IPC as base64 and leave as bytes.
            let bytes = base64_decode(&body).map_err(|message| DataErrorDto {
                kind: KIND_CONFIG.into(),
                message,
            })?;
            builder = builder.body(bytes);
        } else {
            builder = builder.body(body);
        }
    }

    let started = Instant::now();
    // One total budget covering connect, response and body read: an attempt
    // that has not completed within the timeout is aborted (Requirement 8.20).
    let outcome = tokio::time::timeout(timeout, read_response(builder, cap)).await;
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    let (status, headers, retained, truncated) = match outcome {
        Err(_) => {
            return Err(transport_error(
                "timeout",
                format!(
                    "The request timed out after {} ms before a response completed.",
                    timeout.as_millis()
                ),
            ))
        }
        Ok(result) => result?,
    };

    Ok(DataResponseDto {
        status,
        headers,
        byte_count: retained.len() as u64,
        body: String::from_utf8_lossy(&retained).into_owned(),
        truncated,
        duration_ms,
    })
}

/// Sends the request and reads at most `cap` bytes of the response body.
async fn read_response(
    builder: reqwest::RequestBuilder,
    cap: u64,
) -> Result<(u16, HashMap<String, String>, Vec<u8>, bool), DataErrorDto> {
    let mut response = builder
        .send()
        .await
        .map_err(|error| classify_reqwest(&error))?;
    let status = response.status().as_u16();
    let headers = collect_headers(response.headers());

    let mut retained: Vec<u8> = Vec::new();
    let mut truncated = false;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| classify_reqwest(&error))?
    {
        let room = cap.saturating_sub(retained.len() as u64);
        if room == 0 {
            truncated = true;
            break;
        }
        let room = usize::try_from(room).unwrap_or(usize::MAX);
        if chunk.len() > room {
            retained.extend_from_slice(&chunk[..room]);
            truncated = true;
            break;
        }
        retained.extend_from_slice(&chunk);
    }

    Ok((status, headers, retained, truncated))
}

// ─────────────────────────────────────────────────────────────────────────────
// Headers, auth and limits
// ─────────────────────────────────────────────────────────────────────────────

/// Turns caller headers into a [`HeaderMap`], dropping empty names and any
/// `Authorization` value: that header belongs to the connection alone
/// (Requirement 8.6).
fn header_map(headers: &HashMap<String, String>) -> Result<HeaderMap, DataErrorDto> {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        let name = name.trim();
        if name.is_empty() || name.eq_ignore_ascii_case(AUTHORIZATION.as_str()) {
            continue;
        }
        let header = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| config_error(format!("Invalid header name '{name}'.")))?;
        // The value is never named in the error: it may hold rendered payload.
        let value = HeaderValue::from_str(value)
            .map_err(|_| config_error(format!("Invalid value for header '{name}'.")))?;
        map.insert(header, value);
    }
    Ok(map)
}

/// Applies the connection auth, returning the (possibly amended) url.
///
/// Runs last, replacing rather than appending, so a caller header of the same
/// name cannot survive alongside the connection value (Requirement 8.5).
fn apply_auth(
    headers: &mut HeaderMap,
    auth: &AuthDto,
    connection_id: &str,
    secrets: &HashMap<String, String>,
    url: String,
) -> Result<String, DataErrorDto> {
    match auth {
        AuthDto::None => Ok(url),
        AuthDto::Bearer { secret_key } => {
            let token = secret_of(secrets, connection_id, secret_key)?;
            set_sensitive(headers, AUTHORIZATION.as_str(), &format!("Bearer {token}"))?;
            Ok(url)
        }
        AuthDto::Oauth2ClientCredentials | AuthDto::Oauth2Refresh => {
            let token = secret_of(secrets, connection_id, ACCESS_TOKEN_SECRET_KEY)?;
            set_sensitive(headers, AUTHORIZATION.as_str(), &format!("Bearer {token}"))?;
            Ok(url)
        }
        AuthDto::Basic {
            user_secret_key,
            password_secret_key,
        } => {
            let user = secret_of(secrets, connection_id, user_secret_key)?;
            let password = secret_of(secrets, connection_id, password_secret_key)?;
            let encoded = base64_encode(format!("{user}:{password}").as_bytes());
            set_sensitive(headers, AUTHORIZATION.as_str(), &format!("Basic {encoded}"))?;
            Ok(url)
        }
        AuthDto::Header {
            header,
            secret_key,
            prefix,
        } => {
            let name = header.trim();
            if name.is_empty() {
                return Err(config_error(format!(
                    "Connection \"{connection_id}\" uses header auth but declares no header name."
                )));
            }
            let secret = secret_of(secrets, connection_id, secret_key)?;
            let prefix = prefix.as_deref().unwrap_or("");
            set_sensitive(headers, name, &format!("{prefix}{secret}"))?;
            Ok(url)
        }
        AuthDto::Query { param, secret_key } => {
            let param = param.trim();
            if param.is_empty() {
                return Err(config_error(format!(
                    "Connection \"{connection_id}\" uses query auth but declares no parameter name."
                )));
            }
            let secret = secret_of(secrets, connection_id, secret_key)?;
            Ok(append_query(
                &strip_query_param(&url, param),
                param,
                &secret,
            ))
        }
        AuthDto::AwsSigV4 => Err(config_error(format!(
            "Connection \"{connection_id}\" requires AWS SigV4 signing, which this host cannot apply to an HTTP Request step."
        ))),
    }
}

/// Reads one resolved secret, failing with a message that names the connection
/// and the key but never the value.
fn secret_of(
    secrets: &HashMap<String, String>,
    connection_id: &str,
    secret_key: &str,
) -> Result<String, DataErrorDto> {
    secrets.get(secret_key.trim()).cloned().ok_or_else(|| {
        config_error(format!(
            "Connection \"{connection_id}\" is missing the secret \"{}\".",
            secret_key.trim()
        ))
    })
}

/// Inserts (replacing) a header carrying a credential, marked sensitive so the
/// HTTP stack keeps it out of its own diagnostics.
fn set_sensitive(headers: &mut HeaderMap, name: &str, value: &str) -> Result<(), DataErrorDto> {
    let header = HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| config_error(format!("Invalid header name '{name}'.")))?;
    let mut value = HeaderValue::from_str(value)
        .map_err(|_| config_error(format!("Invalid value for header '{name}'.")))?;
    value.set_sensitive(true);
    headers.insert(header, value);
    Ok(())
}

/// Effective per-attempt timeout: the declared value clamped to 1 to 300
/// seconds, otherwise 30 seconds (Requirement 8.20).
fn effective_timeout_ms(declared: Option<u64>) -> u64 {
    match declared {
        Some(0) | None => DEFAULT_TIMEOUT_MS,
        Some(ms) => ms.clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    }
}

/// Effective response byte cap: the declared value, otherwise 4194304
/// (Requirement 8.18).
fn effective_max_response_bytes(declared: Option<u64>) -> u64 {
    match declared {
        Some(0) | None => DEFAULT_MAX_RESPONSE_BYTES,
        Some(bytes) => bytes,
    }
}

/// Collects response headers under lower-cased names, joining a repeated
/// header (`link`, `set-cookie`) the way a wire reader would (Requirement
/// 8.17). Values that are not valid UTF-8 are skipped.
pub(crate) fn collect_headers(headers: &HeaderMap) -> HashMap<String, String> {
    let mut collected: HashMap<String, String> = HashMap::new();
    for (name, value) in headers {
        let Ok(value) = value.to_str() else { continue };
        let name = name.as_str().to_lowercase();
        collected
            .entry(name)
            .and_modify(|existing| {
                existing.push_str(", ");
                existing.push_str(value);
            })
            .or_insert_with(|| value.to_owned());
    }
    collected
}

// ─────────────────────────────────────────────────────────────────────────────
// Failure classification
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) fn config_error(message: impl Into<String>) -> DataErrorDto {
    DataErrorDto {
        kind: KIND_CONFIG.to_owned(),
        message: message.into(),
    }
}

pub(crate) fn transport_error(kind: &str, message: impl Into<String>) -> DataErrorDto {
    DataErrorDto {
        kind: kind.to_owned(),
        message: message.into(),
    }
}

/// Maps a transport failure onto one of the six `TransportFailureKind` values.
///
/// `connect`, `dns` and `tls` are the kinds the retry classifier treats as
/// "the request provably never reached the server", so they are only reported
/// when the failure happened while establishing the connection.
pub(crate) fn classify_reqwest(error: &reqwest::Error) -> DataErrorDto {
    let chain = error_chain(error);
    let kind = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        if chain.contains("dns") || chain.contains("resolve") || chain.contains("name or service") {
            "dns"
        } else if chain.contains("tls")
            || chain.contains("ssl")
            || chain.contains("certificate")
            || chain.contains("handshake")
        {
            "tls"
        } else {
            "connect"
        }
    } else if chain.contains("cancel") || chain.contains("abort") {
        "aborted"
    } else {
        "unknown"
    };
    transport_error(kind, format!("Request failed ({kind}): {error}"))
}

/// Lower-cased text of an error and every source under it, so the cause of a
/// connect failure can be told apart without depending on reqwest internals.
fn error_chain(error: &reqwest::Error) -> String {
    let mut text = error.to_string();
    let mut source: Option<&(dyn StdError + 'static)> = error.source();
    while let Some(current) = source {
        text.push_str(" | ");
        text.push_str(&current.to_string());
        source = current.source();
    }
    text.to_lowercase()
}

// ─────────────────────────────────────────────────────────────────────────────
// Scrubbing, url and base64 helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Replaces every resolved secret of at least [`MIN_SECRET_LEN`] characters
/// with [`REDACTED`], so no value crossing IPC carries a credential in whole or
/// as a substring (Requirement 3.3).
pub(crate) fn scrub(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_owned();
    for secret in secrets {
        if secret.len() < MIN_SECRET_LEN || !out.contains(secret.as_str()) {
            continue;
        }
        out = out.replace(secret.as_str(), REDACTED);
    }
    out
}

/// Appends one query entry, percent-encoding the key and the value exactly
/// once, and keeping any fragment after the appended entry.
fn append_query(url: &str, key: &str, value: &str) -> String {
    let (head, fragment) = match url.split_once('#') {
        Some((head, fragment)) => (head, Some(fragment)),
        None => (url, None),
    };
    let separator = if !head.contains('?') {
        "?"
    } else if head.ends_with('?') || head.ends_with('&') {
        ""
    } else {
        "&"
    };
    let joined = format!(
        "{head}{separator}{}={}",
        encode_once(key),
        encode_once(value)
    );
    match fragment {
        Some(fragment) => format!("{joined}#{fragment}"),
        None => joined,
    }
}

/// Removes every entry named `key` from the url's query, so a placeholder the
/// caller may have left behind cannot survive next to the real credential.
fn strip_query_param(url: &str, key: &str) -> String {
    let (head, fragment) = match url.split_once('#') {
        Some((head, fragment)) => (head, Some(fragment)),
        None => (url, None),
    };
    let Some((path, query)) = head.split_once('?') else {
        return url.to_owned();
    };
    let kept: Vec<&str> = query
        .split('&')
        .filter(|entry| {
            let name = entry.split_once('=').map_or(*entry, |(name, _)| name);
            name != key && name != encode_once(key)
        })
        .filter(|entry| !entry.is_empty())
        .collect();

    let rebuilt = if kept.is_empty() {
        path.to_owned()
    } else {
        format!("{path}?{}", kept.join("&"))
    };
    match fragment {
        Some(fragment) => format!("{rebuilt}#{fragment}"),
        None => rebuilt,
    }
}

/// Percent-encodes exactly once: an already-encoded `%XX` sequence survives
/// unchanged rather than becoming `%25XX` (Requirement 8.4), mirroring
/// `encodeOnce` in `engine/src/data-http.ts`.
fn encode_once(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'%'
            && index + 2 < bytes.len()
            && bytes[index + 1].is_ascii_hexdigit()
            && bytes[index + 2].is_ascii_hexdigit()
        {
            out.push('%');
            out.push(bytes[index + 1] as char);
            out.push(bytes[index + 2] as char);
            index += 3;
            continue;
        }
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0F) as usize] as char);
        }
        index += 1;
    }
    out
}

/// Standard base64 with padding, for `basic` auth. Kept local so applying auth
/// stays a pure function of (headers, auth, secrets) and needs no new crate.
pub(crate) fn base64_encode(input: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).copied().map_or(0, u32::from);
        let b2 = chunk.get(2).copied().map_or(0, u32::from);
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((triple >> 18) & 0x3F) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3F) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((triple >> 6) & 0x3F) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(triple & 0x3F) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Decodes standard base64 (padding optional, whitespace ignored). The inverse
/// of [`base64_encode`], for `bodyEncoding: "base64"` request bodies.
pub(crate) fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b' ' | b'\n' | b'\r' | b'\t' => continue,
            _ => return Err("Request body is not valid base64.".into()),
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_binary_bodies() {
        let bytes: Vec<u8> = (0u8..=255).collect();
        assert_eq!(base64_decode(&base64_encode(&bytes)).unwrap(), bytes);
        assert_eq!(base64_decode("JVBERg==").unwrap(), b"%PDF");
        assert!(base64_decode("ab$d").is_err());
    }

    fn secrets(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    fn caller_headers(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn connection_auth_wins_over_a_caller_authorization_header() {
        let mut headers =
            header_map(&caller_headers(&[("Authorization", "Bearer caller-token"), ("Accept", "application/json")]))
                .expect("headers build");
        assert!(headers.get(AUTHORIZATION).is_none(), "caller Authorization is dropped");

        let url = apply_auth(
            &mut headers,
            &AuthDto::Bearer {
                secret_key: "apiKey".to_owned(),
            },
            "conn-crm",
            &secrets(&[("apiKey", "s3cret-value-1234")]),
            "https://api.example.com/v1/things".to_owned(),
        )
        .expect("auth applied");

        assert_eq!(url, "https://api.example.com/v1/things");
        assert_eq!(
            headers.get(AUTHORIZATION).map(|v| v.to_str().unwrap_or("")),
            Some("Bearer s3cret-value-1234")
        );
        assert_eq!(headers.get("accept").map(|v| v.to_str().unwrap_or("")), Some("application/json"));
    }

    #[test]
    fn header_auth_applies_the_declared_prefix() {
        let mut headers = HeaderMap::new();
        apply_auth(
            &mut headers,
            &AuthDto::Header {
                header: "X-Api-Key".to_owned(),
                secret_key: "apiKey".to_owned(),
                prefix: Some("Token ".to_owned()),
            },
            "conn-crm",
            &secrets(&[("apiKey", "abcd-1234-efgh")]),
            "https://api.example.com".to_owned(),
        )
        .expect("auth applied");

        assert_eq!(
            headers.get("x-api-key").map(|v| v.to_str().unwrap_or("")),
            Some("Token abcd-1234-efgh")
        );
    }

    #[test]
    fn basic_auth_base64_encodes_the_credential_pair() {
        let mut headers = HeaderMap::new();
        apply_auth(
            &mut headers,
            &AuthDto::Basic {
                user_secret_key: "user".to_owned(),
                password_secret_key: "password".to_owned(),
            },
            "conn-crm",
            &secrets(&[("user", "aladdin"), ("password", "opensesame")]),
            "https://api.example.com".to_owned(),
        )
        .expect("auth applied");

        assert_eq!(
            headers.get(AUTHORIZATION).map(|v| v.to_str().unwrap_or("")),
            Some("Basic YWxhZGRpbjpvcGVuc2VzYW1l")
        );
    }

    #[test]
    fn query_auth_replaces_a_placeholder_and_encodes_the_secret_once() {
        let mut headers = HeaderMap::new();
        let url = apply_auth(
            &mut headers,
            &AuthDto::Query {
                param: "api_key".to_owned(),
                secret_key: "apiKey".to_owned(),
            },
            "conn-crm",
            &secrets(&[("apiKey", "a b%2Fc")]),
            "https://api.example.com/v1?page=2&api_key=placeholder#frag".to_owned(),
        )
        .expect("auth applied");

        assert_eq!(url, "https://api.example.com/v1?page=2&api_key=a%20b%2Fc#frag");
    }

    #[test]
    fn oauth_modes_apply_the_cached_access_token_as_a_bearer() {
        let mut headers = HeaderMap::new();
        apply_auth(
            &mut headers,
            &AuthDto::Oauth2Refresh,
            "conn-xero",
            &secrets(&[(ACCESS_TOKEN_SECRET_KEY, "live-token-value")]),
            "https://api.xero.com".to_owned(),
        )
        .expect("auth applied");

        assert_eq!(
            headers.get(AUTHORIZATION).map(|v| v.to_str().unwrap_or("")),
            Some("Bearer live-token-value")
        );
    }

    #[test]
    fn a_missing_secret_is_rejected_naming_the_connection_and_the_key() {
        let error = apply_auth(
            &mut HeaderMap::new(),
            &AuthDto::Bearer {
                secret_key: "apiKey".to_owned(),
            },
            "conn-crm",
            &secrets(&[]),
            "https://api.example.com".to_owned(),
        )
        .expect_err("resolution must fail");

        assert_eq!(error.kind, KIND_CONFIG);
        assert!(error.message.contains("conn-crm"), "{}", error.message);
        assert!(error.message.contains("apiKey"), "{}", error.message);
    }

    #[test]
    fn sigv4_is_rejected_rather_than_sent_unsigned() {
        let error = apply_auth(
            &mut HeaderMap::new(),
            &AuthDto::AwsSigV4,
            "conn-aws",
            &secrets(&[]),
            "https://execute-api.example.com".to_owned(),
        )
        .expect_err("SigV4 must be rejected");
        assert!(error.message.contains("SigV4"), "{}", error.message);
    }

    #[test]
    fn scrub_removes_every_resolved_secret_in_whole_and_as_a_substring() {
        let values = vec!["s3cret-value-1234".to_owned(), "short".to_owned()];
        let text = "GET https://api.example.com?key=s3cret-value-1234 failed; token s3cret-value-1234 rejected; short";
        let scrubbed = scrub(text, &values);

        assert!(!scrubbed.contains("s3cret-value-1234"), "{scrubbed}");
        assert_eq!(scrubbed.matches(REDACTED).count(), 2);
        // Values under MIN_SECRET_LEN are left alone: masking them would eat
        // ordinary text without protecting anything.
        assert!(scrubbed.contains("short"));
    }

    #[test]
    fn connection_id_shape_is_enforced_before_any_secret_read() {
        assert!(validate_connection_id("conn-crm_1").is_ok());
        for id in ["", "crm", "conn-", "conn-bad id", &format!("conn-{}", "x".repeat(65))] {
            let error = validate_connection_id(id).expect_err("id must be rejected");
            assert_eq!(error.kind, KIND_CONFIG);
            assert!(error.message.contains(id) || id.is_empty(), "{}", error.message);
        }
    }

    #[test]
    fn no_declared_secrets_needs_no_connection() {
        assert!(resolve_secrets("", &[]).expect("unauthenticated request").is_empty());
    }

    #[test]
    fn limits_fall_back_to_the_documented_defaults() {
        assert_eq!(effective_timeout_ms(None), DEFAULT_TIMEOUT_MS);
        assert_eq!(effective_timeout_ms(Some(0)), DEFAULT_TIMEOUT_MS);
        assert_eq!(effective_timeout_ms(Some(500)), MIN_TIMEOUT_MS);
        assert_eq!(effective_timeout_ms(Some(900_000)), MAX_TIMEOUT_MS);
        assert_eq!(effective_timeout_ms(Some(45_000)), 45_000);

        assert_eq!(effective_max_response_bytes(None), DEFAULT_MAX_RESPONSE_BYTES);
        assert_eq!(effective_max_response_bytes(Some(0)), DEFAULT_MAX_RESPONSE_BYTES);
        assert_eq!(effective_max_response_bytes(Some(1_024)), 1_024);
    }

    #[test]
    fn repeated_response_headers_are_lower_cased_and_joined() {
        let mut raw = HeaderMap::new();
        raw.append(HeaderName::from_static("link"), HeaderValue::from_static("<https://a/1>; rel=\"next\""));
        raw.append(HeaderName::from_static("link"), HeaderValue::from_static("<https://a/9>; rel=\"last\""));
        raw.insert(HeaderName::from_static("retry-after"), HeaderValue::from_static("30"));

        let collected = collect_headers(&raw);
        assert_eq!(collected.get("retry-after").map(String::as_str), Some("30"));
        assert_eq!(
            collected.get("link").map(String::as_str),
            Some("<https://a/1>; rel=\"next\", <https://a/9>; rel=\"last\"")
        );
    }

    #[test]
    fn auth_dto_parses_the_engine_wire_shape() {
        let bearer: AuthDto =
            serde_json::from_str(r#"{"mode":"bearer","secretKey":"apiKey"}"#).expect("bearer parses");
        assert!(matches!(bearer, AuthDto::Bearer { .. }));

        let header: AuthDto =
            serde_json::from_str(r#"{"mode":"header","header":"X-Api-Key","secretKey":"apiKey","prefix":"Token "}"#)
                .expect("header parses");
        assert!(matches!(header, AuthDto::Header { .. }));

        let oauth: AuthDto = serde_json::from_str(
            r#"{"mode":"oauth2-client-credentials","tokenUrl":"https://x/t","clientIdSecretKey":"a","clientSecretKey":"b"}"#,
        )
        .expect("oauth parses, ignoring the fields the host owns");
        assert!(matches!(oauth, AuthDto::Oauth2ClientCredentials));
    }
}
