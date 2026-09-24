//! `web_fetch`: reads one public web page for the AI assistant.
//!
//! Backs the assistant's `web_fetch` tool and the URL references a user
//! attaches in the chat composer. The URL may come from a model, and a model
//! can be steered by the very pages it reads, so this command is deliberately
//! narrower than `http_request`:
//!
//! - **GET only, no caller headers, no credentials.** Nothing from the
//!   keychain is reachable from here.
//! - **Public addresses only.** Every hop's host is resolved first and refused
//!   when ANY address is loopback, private, link-local, CGNAT, multicast or
//!   otherwise non-global. The connection is then pinned to exactly the
//!   addresses that were checked, so a DNS answer cannot change between the
//!   check and the connect (rebinding).
//! - **Redirects are followed manually** (at most [`MAX_REDIRECTS`]), each hop
//!   re-checked the same way - reqwest's automatic redirect would skip the
//!   guard.
//! - **Readable content only, bounded.** Binary content types are refused and
//!   the body is capped, truncated on a UTF-8 character boundary.

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};

use reqwest::{header, redirect::Policy, Url};
use serde::Serialize;

/// Redirect hops followed before giving up.
const MAX_REDIRECTS: usize = 5;
/// Total budget for the whole fetch, redirects and body read included.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);
/// Body cap when the caller declares none.
const DEFAULT_MAX_BYTES: usize = 1024 * 1024;
/// Accepted body-cap range.
const MIN_MAX_BYTES: usize = 16 * 1024;
const MAX_MAX_BYTES: usize = 4 * 1024 * 1024;
/// Identifies the reader; some sites refuse requests without a User-Agent.
const USER_AGENT: &str = "PhormaAgentStudio/1.0 (+https://phorma.dev) page-reader";
const ACCEPT: &str =
    "text/html,application/xhtml+xml,text/plain;q=0.9,text/markdown;q=0.9,application/json;q=0.8,*/*;q=0.3";

/// One fetched page, mirroring `WebFetchResult` in `web-fetch.service.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResponse {
    pub status: u16,
    /// The URL that produced the body, after redirects.
    pub final_url: String,
    pub content_type: Option<String>,
    pub body: String,
    /// True when the byte cap clipped the body.
    pub truncated: bool,
}

/// Fetches a public web page as text.
///
/// Non-2xx statuses are returned normally so the caller can report them.
///
/// # Errors
///
/// Returns a user-facing message when the URL is invalid or not public, the
/// content is not readable text, redirects loop, or the request fails or
/// times out.
#[tauri::command]
pub async fn web_fetch(url: String, max_bytes: Option<usize>) -> Result<WebFetchResponse, String> {
    let cap = max_bytes
        .unwrap_or(DEFAULT_MAX_BYTES)
        .clamp(MIN_MAX_BYTES, MAX_MAX_BYTES);
    tokio::time::timeout(FETCH_TIMEOUT, fetch(&url, cap))
        .await
        .map_err(|_| format!("Timed out after {} s reading {url}.", FETCH_TIMEOUT.as_secs()))?
}

async fn fetch(raw: &str, cap: usize) -> Result<WebFetchResponse, String> {
    let mut current = parse_web_url(raw)?;
    for _ in 0..=MAX_REDIRECTS {
        let host = current
            .host_str()
            .ok_or_else(|| format!("'{current}' has no host."))?
            .to_owned();
        let port = current.port_or_known_default().unwrap_or(443);
        let addrs = resolve_public(&host, port).await?;

        let mut builder = reqwest::Client::builder()
            .redirect(Policy::none())
            .user_agent(USER_AGENT)
            .timeout(FETCH_TIMEOUT);
        // Pin the connection to the checked addresses (domain names only; an
        // IP literal connects to itself).
        if bare_host(&host).parse::<IpAddr>().is_err() {
            builder = builder.resolve_to_addrs(&host, &addrs);
        }
        let client = builder
            .build()
            .map_err(|error| format!("Could not prepare the request: {error}"))?;

        let mut response = client
            .get(current.clone())
            .header(header::ACCEPT, ACCEPT)
            .send()
            .await
            .map_err(|error| format!("Could not reach {host}: {}", root_cause(&error)))?;

        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| format!("{host} redirected without a Location header."))?;
            let next = current
                .join(location)
                .map_err(|_| format!("{host} redirected to an invalid URL."))?;
            current = parse_web_url(next.as_str())?;
            continue;
        }

        let content_type = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        if let Some(kind) = content_type.as_deref() {
            if !is_readable_content_type(kind) {
                return Err(format!(
                    "{current} is {}, not a readable page.",
                    kind.split(';').next().unwrap_or(kind).trim()
                ));
            }
        }

        let mut bytes: Vec<u8> = Vec::new();
        let mut truncated = false;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("Could not read the page: {}", root_cause(&error)))?
        {
            let room = cap.saturating_sub(bytes.len());
            if chunk.len() > room {
                bytes.extend_from_slice(&chunk[..room]);
                truncated = true;
                break;
            }
            bytes.extend_from_slice(&chunk);
        }

        return Ok(WebFetchResponse {
            status: status.as_u16(),
            final_url: current.to_string(),
            content_type,
            body: decode_body(&bytes, truncated),
            truncated,
        });
    }
    Err(format!("Too many redirects (more than {MAX_REDIRECTS}) reading {raw}."))
}

/// Parses and validates an http(s) URL without credentials.
fn parse_web_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw.trim()).map_err(|_| format!("'{raw}' is not a valid URL."))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("Only http and https pages can be read, not {}.", url.scheme()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs with embedded credentials are not allowed.".to_owned());
    }
    Ok(url)
}

/// Resolves a host and refuses it unless EVERY address is public.
async fn resolve_public(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let bare = bare_host(host);
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return if is_public_ip(ip) {
            Ok(vec![SocketAddr::new(ip, port)])
        } else {
            Err(private_refusal(host))
        };
    }
    let lower = bare.to_ascii_lowercase();
    if lower == "localhost" || lower.ends_with(".localhost") || lower.ends_with(".local") || lower.ends_with(".internal") {
        return Err(private_refusal(host));
    }
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((bare, port))
        .await
        .map_err(|_| format!("Could not resolve {host}."))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("Could not resolve {host}."));
    }
    if addrs.iter().any(|addr| !is_public_ip(addr.ip())) {
        return Err(private_refusal(host));
    }
    Ok(addrs)
}

fn private_refusal(host: &str) -> String {
    format!("{host} is a local or private address; only public web pages can be read.")
}

/// Strips IPv6 literal brackets.
fn bare_host(host: &str) -> &str {
    host.trim_start_matches('[').trim_end_matches(']')
}

/// True for globally routable unicast addresses.
fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || a == 0
        // CGNAT 100.64.0.0/10
        || (a == 100 && (64..=127).contains(&b))
        // IETF protocol assignments 192.0.0.0/24
        || (a == 192 && b == 0 && c == 0)
        // Benchmarking 198.18.0.0/15
        || (a == 198 && (b == 18 || b == 19))
        // Reserved 240.0.0.0/4
        || a >= 240)
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_public_v4(v4);
    }
    let first = ip.segments()[0];
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_multicast()
        // Unique local fc00::/7
        || (first & 0xfe00) == 0xfc00
        // Link-local fe80::/10
        || (first & 0xffc0) == 0xfe80
        // Documentation 2001:db8::/32
        || (first == 0x2001 && ip.segments()[1] == 0x0db8))
}

/// Mirrors `isReadableContentType` in `engine/src/web-fetch.ts`.
fn is_readable_content_type(content_type: &str) -> bool {
    let bare = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    bare.starts_with("text/")
        || matches!(
            bare.as_str(),
            "application/xhtml+xml"
                | "application/json"
                | "application/ld+json"
                | "application/xml"
                | "application/rss+xml"
                | "application/atom+xml"
        )
}

/// Decodes the body as UTF-8, dropping a character the byte cap split.
fn decode_body(bytes: &[u8], truncated: bool) -> String {
    let text = String::from_utf8_lossy(bytes).into_owned();
    if truncated {
        text.trim_end_matches('\u{FFFD}').to_owned()
    } else {
        text
    }
}

/// The innermost error message, which names the real cause (DNS, TLS, ...).
fn root_cause(error: &reqwest::Error) -> String {
    let mut source: &dyn std::error::Error = error;
    while let Some(next) = source.source() {
        source = next;
    }
    source.to_string()
}

/// Truncates `text` to at most `max` bytes without splitting a character.
pub(crate) fn truncate_at_char_boundary(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_non_public_ipv4() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "198.18.0.1",
            "240.0.0.1",
        ] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip} should be refused");
        }
    }

    #[test]
    fn refuses_non_public_ipv6() {
        for ip in ["::1", "::", "fe80::1", "fd00::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"] {
            assert!(!is_public_ip(ip.parse().unwrap()), "{ip} should be refused");
        }
    }

    #[test]
    fn accepts_public_addresses() {
        for ip in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"] {
            assert!(is_public_ip(ip.parse().unwrap()), "{ip} should be allowed");
        }
    }

    #[test]
    fn parses_only_plain_http_urls() {
        assert!(parse_web_url("https://example.com/a").is_ok());
        assert!(parse_web_url("http://example.com").is_ok());
        assert!(parse_web_url("file:///etc/passwd").is_err());
        assert!(parse_web_url("ftp://example.com").is_err());
        assert!(parse_web_url("https://user:pass@example.com").is_err());
        assert!(parse_web_url("not a url").is_err());
    }

    #[test]
    fn refuses_local_host_names_without_resolving() {
        tauri::async_runtime::block_on(async {
            assert!(resolve_public("localhost", 80).await.is_err());
            assert!(resolve_public("printer.local", 80).await.is_err());
            assert!(resolve_public("[::1]", 80).await.is_err());
            assert!(resolve_public("169.254.169.254", 80).await.is_err());
        });
    }

    #[test]
    fn readable_content_types() {
        assert!(is_readable_content_type("text/html; charset=utf-8"));
        assert!(is_readable_content_type("application/json"));
        assert!(!is_readable_content_type("image/png"));
        assert!(!is_readable_content_type("application/pdf"));
    }

    #[test]
    fn truncation_never_splits_a_character() {
        let text = "ab\u{00e9}cd"; // e-acute is 2 bytes at index 2..4
        assert_eq!(truncate_at_char_boundary(text, 3), "ab");
        assert_eq!(truncate_at_char_boundary(text, 4), "ab\u{00e9}");
        assert_eq!(truncate_at_char_boundary(text, 100), text);
    }

    #[test]
    fn decode_drops_a_split_trailing_character() {
        let bytes = "ab\u{00e9}".as_bytes();
        assert_eq!(decode_body(&bytes[..3], true), "ab");
        assert_eq!(decode_body(bytes, false), "ab\u{00e9}");
    }
}
