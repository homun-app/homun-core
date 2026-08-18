use base64::Engine as _;

use super::*;

/// Local Ollama OpenAI-compat base for image generation (the last-resort default).
pub(crate) fn default_image_base() -> String {
    let ollama =
        std::env::var("HOMUN_EMBED_BASE").unwrap_or_else(|_| "http://127.0.0.1:11434".to_string());
    format!("{}/v1", ollama.trim_end_matches('/'))
}

/// API key from the `HOMUN_IMAGE_KEY` env, if non-empty.
pub(crate) fn image_env_key() -> Option<String> {
    std::env::var("HOMUN_IMAGE_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/// Image-generation provider config: (base_url, model, api_key). Provider-agnostic and
/// OpenAI-compatible (`{base}/images/generations`), so the SAME path serves LOCAL Ollama
/// (Flux / Z-Image, via MLX) AND cloud diffusion (Gemini "Nano Banana", OpenAI gpt-image,
/// fal, ...).
///
/// Resolution order:
///   1. Manual pin of the `image_generation` role.
///   2. Explicit env override (HOMUN_IMAGE_BASE / _MODEL / _KEY).
///   3. Auto-matched image model from the provider catalog.
///   4. Local Ollama `z-image` default.
pub(crate) fn image_provider_config() -> (String, String, Option<String>) {
    let registry = load_provider_registry();

    if let Some((provider_id, model)) = registry.manual_binding("image_generation")
        && let Some(provider) = registry.get(&provider_id)
    {
        let key = provider_api_key(&provider_id).or_else(image_env_key);
        return (provider.base_url.clone(), model, key);
    }

    let env_base = std::env::var("HOMUN_IMAGE_BASE")
        .ok()
        .filter(|s| !s.trim().is_empty());
    let env_model = std::env::var("HOMUN_IMAGE_MODEL")
        .ok()
        .filter(|s| !s.trim().is_empty());
    if env_base.is_some() || env_model.is_some() {
        return (
            env_base.unwrap_or_else(default_image_base),
            env_model.unwrap_or_else(|| "z-image".to_string()),
            image_env_key(),
        );
    }

    if !registry.eligible_models("image_generation").is_empty()
        && let Some(resolved) = registry.resolve_role("image_generation")
    {
        let key = provider_api_key(&resolved.provider_id).or_else(image_env_key);
        return (resolved.base_url, resolved.model, key);
    }

    (default_image_base(), "z-image".to_string(), None)
}

/// Per-request timeout for image generation. Default 300s for local diffusion cold starts.
pub(crate) fn image_timeout_secs() -> u64 {
    std::env::var("HOMUN_IMAGE_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .filter(|&s| s > 0)
        .unwrap_or(300)
}

pub(crate) fn deck_slide_image_prompt(title: &str, accent: &str) -> String {
    let topics = title
        .split_whitespace()
        .filter_map(|word| {
            let clean = word
                .chars()
                .filter(|ch| ch.is_ascii_alphabetic() || *ch == '-')
                .collect::<String>()
                .trim_matches('-')
                .to_ascii_lowercase();
            if clean.len() < 3 { None } else { Some(clean) }
        })
        .take(5)
        .collect::<Vec<_>>();
    let topic_line = if topics.is_empty() {
        "an abstract product narrative".to_string()
    } else {
        format!("themes: {}", topics.join(", "))
    };

    format!(
        "Editorial, modern, professional slide illustration about {topic_line}. \
Clean minimal composition, {accent} accents, abstract shapes, subtle depth, lots of negative space. \
No typography of any kind: no readable text, words, letters, numbers, captions, labels, UI screenshots or logos. \
Do not render the topic words as visible text."
    )
}

/// Generate a PNG from a text prompt via the configured image provider (local Ollama or
/// cloud). Returns raw PNG bytes. Best-effort across `data[0].b64_json` and `data[0].url`.
pub(crate) async fn generate_image_png(
    http: &reqwest::Client,
    prompt: &str,
    size: &str,
) -> Result<Vec<u8>, String> {
    let (base, model, key) = image_provider_config();
    let endpoint = format!("{}/images/generations", base.trim_end_matches('/'));
    let mut builder = http
        .post(&endpoint)
        .timeout(std::time::Duration::from_secs(image_timeout_secs()))
        .json(&serde_json::json!({
            "model": model,
            "prompt": prompt,
            "n": 1,
            "size": size,
            "response_format": "b64_json",
        }));
    if let Some(key) = key.as_ref() {
        builder = builder.bearer_auth(key);
    }
    let resp = builder
        .send()
        .await
        .map_err(|e| format!("image provider unreachable ({endpoint}): {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!(
            "image provider HTTP {status}: {}. Check the image model is available (e.g. `ollama pull {model}`) or set a cloud provider via HOMUN_IMAGE_BASE/MODEL/KEY.",
            body.chars().take(180).collect::<String>()
        ));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("bad image response: {e}"))?;
    let data = json
        .get("data")
        .and_then(|d| d.as_array())
        .and_then(|a| a.first());
    if let Some(b64) = data
        .and_then(|d| d.get("b64_json"))
        .and_then(|v| v.as_str())
    {
        return base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| format!("image decode failed: {e}"));
    }
    if let Some(url) = data.and_then(|d| d.get("url")).and_then(|v| v.as_str()) {
        let bytes = http
            .get(url)
            .send()
            .await
            .map_err(|e| format!("image url fetch failed: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("image url read failed: {e}"))?;
        return Ok(bytes.to_vec());
    }
    Err("image provider returned no image data".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_image_generation_owner_smoke() {
        let prompt = deck_slide_image_prompt("Local-first AI for PMI 2026", "#14947d");

        assert!(
            !prompt.contains("\"Local-first AI for PMI 2026\""),
            "{prompt}"
        );
        assert!(!prompt.contains("PMI 2026"), "{prompt}");
        assert!(prompt.contains("themes:"), "{prompt}");
        assert!(prompt.contains("local-first"), "{prompt}");
        assert!(prompt.contains("pmi"), "{prompt}");
        assert!(prompt.contains("No typography of any kind"), "{prompt}");
        assert!(
            prompt.contains("Do not render the topic words as visible text"),
            "{prompt}"
        );
    }
}
