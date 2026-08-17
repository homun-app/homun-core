//! Chat audio transcription owner.
//!
//! Owns the `/api/chat/transcribe` route and the contained-computer Whisper
//! bridge used by dictation.

use axum::{Json, extract::State, http::StatusCode};
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::{AppState, GatewayError, sandbox};

#[derive(Debug, Deserialize)]
pub(crate) struct TranscribeRequest {
    /// Base64-encoded audio (any ffmpeg-decodable container, e.g. webm/opus).
    audio_base64: String,
    /// Optional language hint; omitted means Whisper auto-detects.
    #[serde(default)]
    language: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct TranscribeResponse {
    text: String,
    language: Option<String>,
}

fn decode_audio_bytes(audio_base64: &str) -> Result<Vec<u8>, GatewayError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(audio_base64.as_bytes())
        .map_err(|e| GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "bad_audio",
            message: format!("Invalid audio: {e}"),
        })?;
    if bytes.is_empty() {
        return Err(GatewayError {
            status: StatusCode::BAD_REQUEST,
            code: "bad_audio",
            message: "Empty audio.".to_string(),
        });
    }
    Ok(bytes)
}

/// On-device speech-to-text. Decodes the audio and forwards it to the warm
/// faster-whisper server inside the contained computer.
pub(crate) async fn transcribe_audio(
    State(state): State<AppState>,
    Json(request): Json<TranscribeRequest>,
) -> Result<Json<TranscribeResponse>, GatewayError> {
    let bytes = decode_audio_bytes(&request.audio_base64)?;
    tokio::task::spawn_blocking(sandbox::ensure_contained_computer)
        .await
        .map_err(|e| GatewayError {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "sandbox",
            message: e.to_string(),
        })?
        .map_err(|e| GatewayError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "sandbox",
            message: e,
        })?;
    let url = format!("{}/transcribe", sandbox::whisper_base_url());
    let mut builder = state
        .http
        .post(&url)
        .timeout(std::time::Duration::from_secs(300))
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
        .body(bytes);
    if let Some(lang) = request
        .language
        .as_ref()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
    {
        builder = builder.header("X-Language", lang);
    }
    let resp = builder.send().await.map_err(|e| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "transcribe_failed",
        message: format!("STT server unreachable: {e}"),
    })?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(GatewayError {
            status: StatusCode::BAD_GATEWAY,
            code: "transcribe_failed",
            message: format!(
                "STT responded {status}: {}",
                body.chars().take(200).collect::<String>()
            ),
        });
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| GatewayError {
        status: StatusCode::BAD_GATEWAY,
        code: "transcribe_failed",
        message: format!("Invalid STT response: {e}"),
    })?;
    Ok(Json(TranscribeResponse {
        text: body
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .trim()
            .to_string(),
        language: body
            .get("language")
            .and_then(|l| l.as_str())
            .map(String::from),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcription_rejects_invalid_audio_base64() {
        let error = decode_audio_bytes("not base64").unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error.code, "bad_audio");
    }

    #[test]
    fn transcription_rejects_empty_audio() {
        let error = decode_audio_bytes("").unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST);
        assert_eq!(error.code, "bad_audio");
    }

    #[test]
    fn transcription_accepts_non_empty_audio_bytes() {
        assert_eq!(decode_audio_bytes("AQID").unwrap(), vec![1, 2, 3]);
    }
}
