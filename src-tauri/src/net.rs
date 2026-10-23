// Network helpers shared by the Claude API client, the apps API and Spotify:
// address checks, bounded reads and HTTP clients.
//
// Every answer a server sends is read with a ceiling, so a misbehaving or
// hostile server cannot make the app hold an unbounded amount of memory.

use std::net::IpAddr;
use std::time::Duration;

use reqwest::Url;

use crate::i18n::{t, tf};

/// Ceiling for a JSON answer: an API reply or a model list.
pub const MAX_BODY: usize = 8 * 1024 * 1024;
/// Ceiling for an error body: only its message is shown.
pub const MAX_ERROR_BODY: usize = 64 * 1024;

/// True for an address that is this machine: `localhost`, 127.0.0.0/8, ::1,
/// and the unspecified addresses (0.0.0.0, ::), which connect to this machine.
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => ip.is_loopback() || ip.is_unspecified(),
        Ok(IpAddr::V6(ip)) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || ip.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback())
        }
        Err(_) => false,
    }
}

pub fn is_loopback_url(url: &Url) -> bool {
    url.host_str().is_some_and(is_loopback_host)
}

/// The Messages endpoint for an Anthropic-compatible gateway given in
/// WINOTCH_ANTHROPIC_BASE_URL. A base URL (`https://gw.example.com`,
/// `…/v1`) gets `/v1/messages` added; a full endpoint is kept. The key goes
/// wherever this points, so it must be https — plain http only to this machine.
pub fn anthropic_endpoint(raw: &str) -> Result<Url, String> {
    const VAR: &str = "WINOTCH_ANTHROPIC_BASE_URL";
    let mut url = Url::parse(raw.trim()).map_err(|_| format!("{VAR} is not a valid URL."))?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback_url(&url) => {}
        "http" => return Err(format!("{VAR} must use https:// (plain http only to this computer).")),
        _ => return Err(format!("{VAR} must start with https://.")),
    }
    if !url.username().is_empty() || url.password().is_some() || url.host_str().is_none() {
        return Err(format!("{VAR} must not carry a user name or password."));
    }
    let path = url.path().trim_end_matches('/').to_string();
    let path = if path.ends_with("/v1/messages") {
        path
    } else if path.ends_with("/v1") {
        format!("{path}/messages")
    } else {
        format!("{path}/v1/messages")
    };
    url.set_path(&path);
    url.set_fragment(None);
    Ok(url)
}

/// A client for `url`: requests to this machine skip any system proxy, which
/// would otherwise see (and usually fail) a loopback address.
pub fn client(url: &Url, timeout: Duration) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10).min(timeout))
        .timeout(timeout);
    if is_loopback_url(url) {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|e| e.to_string())
}

/// The body of `response`, refused past `limit` bytes.
pub async fn read_capped(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(t("The server's answer is too large."));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| tf("Network error: {error}", &[("error", &e.to_string())]))? {
        if body.len() + chunk.len() > limit {
            return Err(t("The server's answer is too large."));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// The text of an error body, cut down for a message: `error.message`
/// (OpenAI, Anthropic), a bare `error` string (Ollama), or the first characters.
pub fn error_detail(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
        if let Some(m) = v.pointer("/error/message").and_then(|m| m.as_str()) {
            return m.to_string();
        }
        if let Some(m) = v.get("error").and_then(|m| m.as_str()) {
            return m.to_string();
        }
        if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
            return m.to_string();
        }
        // Gemini answers some errors as a one-element array.
        if let Some(m) = v.pointer("/0/error/message").and_then(|m| m.as_str()) {
            return m.to_string();
        }
    }
    text.trim().chars().take(200).collect()
}

/// Only the host of an address, for the log: never a path, a query or a key.
pub fn host_for_log(url: &Url) -> String {
    match (url.host_str(), url.port()) {
        (Some(h), Some(p)) => format!("{h}:{p}"),
        (Some(h), None) => h.to_string(),
        _ => "?".into(),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn loopback_hosts_are_recognised_and_others_are_not() {
        for host in ["localhost", "LOCALHOST", "app.localhost", "127.0.0.1", "127.8.9.1", "::1", "[::1]", "0.0.0.0", "[::]", "::ffff:127.0.0.1"] {
            assert!(is_loopback_host(host), "{host}");
        }
        for host in ["example.com", "192.168.1.10", "10.0.0.2", "localhost.example.com", "[2001:db8::1]", "128.0.0.1", ""] {
            assert!(!is_loopback_host(host), "{host}");
        }
    }

    #[test]
    fn the_anthropic_gateway_is_taken_as_a_base_url_and_must_be_https() {
        let e = |s: &str| anthropic_endpoint(s).map(|u| u.to_string());
        assert_eq!(e("https://gw.example.com").unwrap(), "https://gw.example.com/v1/messages");
        assert_eq!(e("https://gw.example.com/").unwrap(), "https://gw.example.com/v1/messages");
        assert_eq!(e("https://gw.example.com/anthropic").unwrap(), "https://gw.example.com/anthropic/v1/messages");
        assert_eq!(e("https://gw.example.com/v1").unwrap(), "https://gw.example.com/v1/messages");
        assert_eq!(e("https://gw.example.com/v1/messages/").unwrap(), "https://gw.example.com/v1/messages");
        assert_eq!(e(" http://localhost:4000 ").unwrap(), "http://localhost:4000/v1/messages");
        assert_eq!(e("http://127.0.0.1:4000/v1").unwrap(), "http://127.0.0.1:4000/v1/messages");
        assert!(e("http://gw.example.com").is_err());
        assert!(e("ftp://gw.example.com").is_err());
        assert!(e("https://me:secret@gw.example.com").is_err());
        assert!(e("not a url").is_err());
    }

    #[test]
    fn error_details_come_from_the_usual_places() {
        assert_eq!(error_detail(br#"{"error":{"message":"bad key"}}"#), "bad key");
        assert_eq!(error_detail(br#"{"error":"model 'x' not found"}"#), "model 'x' not found");
        assert_eq!(error_detail(br#"[{"error":{"message":"quota"}}]"#), "quota");
        assert_eq!(error_detail(b"  plain text  "), "plain text");
        assert_eq!(error_detail("x".repeat(500).as_bytes()).len(), 200);
    }

    #[test]
    fn only_the_host_goes_to_the_log() {
        let url = Url::parse("https://gw.example.com:8443/secret/path?key=abc").unwrap();
        assert_eq!(host_for_log(&url), "gw.example.com:8443");
        let url = Url::parse("https://gw.example.com/v1/messages").unwrap();
        assert_eq!(host_for_log(&url), "gw.example.com");
    }

    /// One-shot HTTP server on a free port answering the next request with `body`.
    pub(crate) fn serve_once(status: &str, headers: &str, body: Vec<u8>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let head = format!("HTTP/1.1 {status}\r\n{headers}Connection: close\r\n\r\n");
        std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let mut buf = [0u8; 8192];
            let _ = conn.read(&mut buf);
            let _ = conn.write_all(head.as_bytes());
            let _ = conn.write_all(&body);
        });
        url
    }

    fn block_on<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    #[test]
    fn a_body_past_the_ceiling_is_refused_with_or_without_a_length() {
        let get = |url: String| async move {
            let url = Url::parse(&url).unwrap();
            let response = client(&url, Duration::from_secs(5)).unwrap().get(url).send().await.unwrap();
            read_capped(response, 1000).await
        };
        // Declared length too large.
        let url = serve_once("200 OK", "Content-Length: 5000\r\n", vec![b'x'; 5000]);
        assert!(block_on(get(url)).is_err());
        // No length (read to the end of the connection): stopped while reading.
        let url = serve_once("200 OK", "", vec![b'x'; 5000]);
        assert!(block_on(get(url)).is_err());
        // Under the ceiling: read whole.
        let url = serve_once("200 OK", "Content-Length: 3\r\n", b"abc".to_vec());
        assert_eq!(block_on(get(url)).unwrap(), b"abc");
    }
}
