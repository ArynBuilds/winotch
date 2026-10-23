// Claude API client for what runs on the user's own key: the dictation
// clean-up (flow/cleanup.rs), the notes of a call (notes/), « OK Tent »
// (voice/brain.rs) and the model list of the settings. The island's chat talks
// to Claude Code sessions instead (sessions.rs).
//
// Everything happens here rather than in the page: the API key never leaves
// the credential store.
//
// WINOTCH_ANTHROPIC_BASE_URL points these calls at an Anthropic-compatible
// gateway instead (issue #180). Only that variable is read: Claude Code's own
// ANTHROPIC_BASE_URL may name a proxy the user never meant to hand this key to.

use std::sync::OnceLock;
use std::time::Duration;

use reqwest::Url;
use serde::Serialize;
use serde_json::{json, Value};

use crate::i18n::{t, tf};
use crate::{net, secrets};

/// Credential store entry of the Anthropic API key.
pub const KEY: &str = "anthropic-api-key";
const DEFAULT_ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const BASE_URL_VAR: &str = "WINOTCH_ANTHROPIC_BASE_URL";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Server-side fallback: on a policy decline the API retries the same request on
/// a fallback model inside the same call, so the user never hits a dead end.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

pub const DEFAULT_MODEL: &str = "claude-opus-5";

/// A model on the user's account, for the model select of the settings.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

/// The Messages endpoint: Anthropic's, or the gateway in WINOTCH_ANTHROPIC_BASE_URL.
/// Read once; the gateway's host (never the key) goes to the log once.
fn endpoint() -> Result<Url, String> {
    static ENDPOINT: OnceLock<Result<Url, String>> = OnceLock::new();
    ENDPOINT
        .get_or_init(|| {
            let raw = std::env::var(BASE_URL_VAR).ok().filter(|v| !v.trim().is_empty());
            let resolved = match raw {
                None => Ok(Url::parse(DEFAULT_ENDPOINT).expect("valid default endpoint")),
                Some(raw) => net::anthropic_endpoint(&raw),
            };
            match &resolved {
                Ok(url) if url.as_str() != DEFAULT_ENDPOINT => crate::log::line(format!(
                    "claude: requests go to {} ({BASE_URL_VAR})",
                    net::host_for_log(url)
                )),
                Err(err) => crate::log::line(format!("claude: {err}")),
                _ => {}
            }
            resolved
        })
        .clone()
}

/// The model list endpoint next to the Messages one.
fn models_endpoint(messages: &Url) -> Url {
    let mut url = messages.clone();
    let path = url.path().trim_end_matches("/messages").to_string();
    url.set_path(&format!("{path}/models"));
    url.set_query(Some("limit=100"));
    url
}

/// One question, one answer, no history: the dictation clean-up and the notes
/// of a call. The text of the answer, or why there is none.
pub async fn complete(model: &str, system: &str, user: &str, max_tokens: u32, timeout: Duration) -> Result<String, String> {
    let key = secrets::get(KEY).ok_or_else(|| t("API key missing. Open settings."))?;
    let endpoint = endpoint()?;
    let body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{ "role": "user", "content": user }],
    });
    let response = call_with_timeout(&endpoint, &key, &body, timeout).await?;
    let text: String = response["content"]
        .as_array()
        .map(|blocks| blocks.iter().filter_map(|b| b["text"].as_str()).collect())
        .unwrap_or_default();
    if text.trim().is_empty() {
        return Err("empty answer".into());
    }
    Ok(text)
}

/// One turn of « OK Tent »'s conversation with tools: the API's whole answer
/// (content blocks and stop_reason).
pub async fn voice_turn(model: &str, system: &str, messages: &[Value], tools: &[Value]) -> Result<Value, String> {
    let key = secrets::get(KEY).ok_or_else(|| t("API key missing. Open settings."))?;
    let endpoint = endpoint()?;
    let body = json!({
        "model": model,
        "max_tokens": 1024,
        "system": system,
        "messages": messages,
        "tools": tools,
    });
    call_with_timeout(&endpoint, &key, &body, Duration::from_secs(45)).await
}

async fn call_with_timeout(endpoint: &Url, key: &str, body: &Value, timeout: Duration) -> Result<Value, String> {
    let response = net::client(endpoint, timeout)?
        .post(endpoint.clone())
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| tf("Network error: {error}", &[("error", &e.to_string())]))?;

    let status = response.status();
    if !status.is_success() {
        // Surface the API's own message, which is what makes a bad key obvious.
        let body = net::read_capped(response, net::MAX_ERROR_BODY).await.unwrap_or_default();
        return Err(format!("Claude API {status}: {}", net::error_detail(&body)));
    }
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    serde_json::from_slice(&bytes).map_err(|e| tf("Bad API response: {error}", &[("error", &e.to_string())]))
}

/// The models on the user's Anthropic account, newest first, as the API lists them.
pub async fn models(key: &str) -> Result<Vec<ModelInfo>, String> {
    let url = models_endpoint(&endpoint()?);
    let response = net::client(&url, Duration::from_secs(10))?
        .get(url.clone())
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .send()
        .await
        .map_err(|e| tf("Network error: {error}", &[("error", &e.to_string())]))?;
    let status = response.status();
    if !status.is_success() {
        let body = net::read_capped(response, net::MAX_ERROR_BODY).await.unwrap_or_default();
        return Err(format!("Claude API {status}: {}", net::error_detail(&body)));
    }
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    let json: Value = serde_json::from_slice(&bytes).map_err(|_| t("Unexpected API response."))?;
    Ok(parse_models(&json))
}

fn parse_models(json: &Value) -> Vec<ModelInfo> {
    json.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_string();
            let label = m.get("display_name").and_then(Value::as_str).unwrap_or(&id).to_string();
            Some(ModelInfo { id, label })
        })
        .collect()
}

/// Small standalone base64 encoder — not worth another dependency.
/// Used for Stripe's basic auth and Spotify's artwork.
pub(crate) fn base64_for(bytes: &[u8]) -> String {
    base64(bytes)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn the_model_list_sits_next_to_the_messages_endpoint() {
        let url = Url::parse(DEFAULT_ENDPOINT).unwrap();
        assert_eq!(models_endpoint(&url).as_str(), "https://api.anthropic.com/v1/models?limit=100");
        let url = net::anthropic_endpoint("https://gw.example.com/anthropic").unwrap();
        assert_eq!(models_endpoint(&url).as_str(), "https://gw.example.com/anthropic/v1/models?limit=100");
        let list = json!({"data":[{"id":"claude-opus-5","display_name":"Claude Opus 5"},{"id":"claude-x"},{"nope":1}]});
        assert_eq!(
            parse_models(&list),
            vec![
                ModelInfo { id: "claude-opus-5".into(), label: "Claude Opus 5".into() },
                ModelInfo { id: "claude-x".into(), label: "claude-x".into() },
            ]
        );
    }
}
