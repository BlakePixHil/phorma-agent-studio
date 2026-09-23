//! System One (`TypeSafe` Jev) decision proxy.
//!
//! The engine builds the full decision request (model, state, questions) and
//! hands the JSON body to [`decision_evaluate`]. Rust reads the `TypeSafe` key
//! from the OS keychain, performs the call to the fixed endpoint, and returns
//! the raw status, headers and body - the engine's `decisionResultFromHttp`
//! owns parsing and error classification, so every host behaves identically.
//!
//! Invariants:
//! 1. **The key never crosses IPC.** It is read here, applied as a sensitive
//!    header, and scrubbed out of the body and every error message.
//! 2. **The endpoint is fixed.** The caller supplies only the body, so this
//!    command can never be pointed at another host with the key attached.
//! 3. **An HTTP status is not a failure.** 4xx/5xx come back as a response so
//!    the engine's retry classifier sees `Retry-After`; only a request that
//!    produced no response fails, with a `TransportFailureKind`.

use std::{collections::HashMap, time::Duration};

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde::Serialize;

use crate::data::{classify_reqwest, collect_headers, config_error, scrub, DataErrorDto};
use crate::llm::provider_key;

/// The one `TypeSafe` evaluation endpoint (mirrors `DECISION_API_URL`).
const DECISION_API_URL: &str = "https://api.typesafe.ai/v1/systemone";
/// Keychain id of the `TypeSafe` key (mirrors `DECISION_KEY_ID`).
const DECISION_KEY_ID: &str = "typesafe";
/// Per-request timeout. Jev answers in ~100 ms; 30 s covers queueing.
const TIMEOUT: Duration = Duration::from_secs(30);
/// Request body cap: generously above Jev's 64k-token request budget.
const MAX_BODY_BYTES: usize = 1024 * 1024;
/// Response cap: answers are small; anything larger is not a decision.
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const AGENT: &str = "PhormaAgentStudio/1.0 (https://phorma.dev)";

/// Raw answer handed back to the engine's `decisionResultFromHttp`
/// (status, lower-cased headers, body).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionResponseDto {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// Validates the request body before any key is read or socket opened.
fn validate_body(body: &str) -> Result<(), DataErrorDto> {
    if body.len() > MAX_BODY_BYTES {
        return Err(config_error(format!(
            "The System One request is {} bytes, over the {MAX_BODY_BYTES} byte limit. \
             Narrow the input with a state path.",
            body.len()
        )));
    }
    let parsed: serde_json::Value = serde_json::from_str(body)
        .map_err(|_| config_error("The System One request is not valid JSON."))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| config_error("The System One request must be a JSON object."))?;
    for field in ["model", "state", "questions"] {
        if !object.contains_key(field) {
            return Err(config_error(format!("The System One request has no \"{field}\".")));
        }
    }
    Ok(())
}

/// Evaluates one System One request with the keychain key.
///
/// # Errors
///
/// Returns a [`DataErrorDto`] with kind `config` when the body is invalid or
/// no key is stored, or a transport kind when the request produced no
/// response. No message ever contains the key.
#[tauri::command]
pub async fn decision_evaluate(body: String) -> Result<DecisionResponseDto, DataErrorDto> {
    validate_body(&body)?;
    let key = provider_key(DECISION_KEY_ID)
        .map_err(config_error)?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            config_error(
                "No TypeSafe API key is configured for System One. Add one in Settings → API keys.",
            )
        })?;
    let secrets = vec![key.clone()];

    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(USER_AGENT, HeaderValue::from_static(AGENT));
    let mut auth = HeaderValue::from_str(&format!("Bearer {}", key.trim()))
        .map_err(|_| config_error("The stored TypeSafe API key contains invalid characters."))?;
    auth.set_sensitive(true);
    headers.insert(AUTHORIZATION, auth);

    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|error| config_error(format!("Could not build the HTTP client: {error}")))?;

    let response = client
        .post(DECISION_API_URL)
        .headers(headers)
        .body(body)
        .send()
        .await
        .map_err(|error| {
            let classified = classify_reqwest(&error);
            DataErrorDto {
                kind: classified.kind,
                message: scrub(&classified.message, &secrets),
            }
        })?;

    let status = response.status().as_u16();
    let headers = collect_headers(response.headers());
    let bytes = response.bytes().await.map_err(|error| {
        let classified = classify_reqwest(&error);
        DataErrorDto {
            kind: classified.kind,
            message: scrub(&classified.message, &secrets),
        }
    })?;
    let clipped = &bytes[..bytes.len().min(MAX_RESPONSE_BYTES)];
    let text = String::from_utf8_lossy(clipped);

    Ok(DecisionResponseDto {
        status,
        headers,
        body: scrub(&text, &secrets),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bodies_that_are_not_decision_requests() {
        assert!(validate_body("not json").is_err());
        assert!(validate_body("[]").is_err());
        assert!(validate_body(r#"{"model":"jev-latest","state":"x"}"#).is_err());
        let error = validate_body(r#"{"state":"x","questions":{}}"#).unwrap_err();
        assert_eq!(error.kind, "config");
        assert!(error.message.contains("model"));
    }

    #[test]
    fn accepts_a_well_formed_request() {
        assert!(validate_body(r#"{"model":"jev-latest","state":"x","questions":{}}"#).is_ok());
    }

    #[test]
    fn rejects_oversized_bodies_before_reading_the_key() {
        let big = format!(
            r#"{{"model":"m","state":"{}","questions":{{}}}}"#,
            "a".repeat(MAX_BODY_BYTES)
        );
        let error = validate_body(&big).unwrap_err();
        assert!(error.message.contains("state path"));
    }
}
