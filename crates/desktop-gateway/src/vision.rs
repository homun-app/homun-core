//! Vision: the ONE answer to "can this model look at an image?", and everything that follows from it.
//!
//! Two call sites ask that question and, until now, each answered it on its own: the browser loop
//! (inject the screenshot?) trusted Ollama's `/api/show` — which is blind to cloud models and so
//! defaulted to an optimistic `true` — while the chat attachment path asked *nobody* and let the
//! provider reject the turn with a 400. This module is the single source of truth both consult.
//!
//! The question has THREE answers, not two. A model we *know* is text-only is not the same as a
//! model we simply have no information about (a raw cloud endpoint, absent from every catalog), and
//! the two call sites are entitled to treat that uncertainty differently: a screenshot sent to a
//! blind model wastes a round, while a user's uploaded image that dies on a 400 wastes the user's
//! trust. Collapsing the two into a bool is what produced the bug.
//!
//! Everything here is PURE (verdict, policy, message rewriting, error classification). The I/O — the
//! `vision`-role sub-turn that actually describes an image — lives in the gateway, thin, around these.

use serde_json::Value;

/// Whether a model can accept an image part, and how sure we are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VisionSupport {
    /// The provider reports the capability, or the catalog flags the model as vision.
    Yes,
    /// The provider reports NO vision capability, or the catalog says the model is text-only.
    No,
    /// No signal at all: the model is in no catalog and the provider advertises no capabilities.
    Unknown,
}

/// The verdict for a model, from the ONE signal that is allowed to answer: its catalog entry
/// (`ModelEntry.vision`).
///
/// The catalog is the single source by construction (caposaldo #5): entries start from the import-time
/// name heuristic, the user can override them, and `/api/show` AUTO-FILLS them with the provider's own
/// authoritative report the first time a model is probed. So asking the catalog asks everything.
///
/// Notably we do NOT read the `ollama_capabilities` cache here, even though it looks authoritative:
/// it is seeded with `unwrap_or_default()` and inserted unconditionally, so a model that is in no
/// catalog and on no Ollama comes back from it as a confident `vision: false` that nobody ever
/// established. `None` — the model is in no catalog — must stay `Unknown`; laundering it into a `No`
/// is how you end up silently refusing to look at images a model could see perfectly well.
pub fn vision_support(catalog: Option<bool>) -> VisionSupport {
    match catalog {
        Some(true) => VisionSupport::Yes,
        Some(false) => VisionSupport::No,
        None => VisionSupport::Unknown,
    }
}

/// What to do with the images the user attached to THIS turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttachmentPlan {
    /// Send the images inline to the chat model — today's path, and the cheap one (no extra call).
    Inline,
    /// Send them inline, but keep the turn's seed so a provider rejection can be recovered from:
    /// describe the images on the `vision` role and re-run the turn with the text. Used when we
    /// don't KNOW whether the model sees — optimism, with a net.
    InlineWithFallback,
    /// The chat model is known-blind: describe the images in an isolated sub-turn on the `vision`
    /// role model and hand the manager the resulting text as evidence (ADR 0025 shape).
    Delegate,
    /// Nobody can see the images: say so to the user instead of letting the provider 400.
    Refuse,
}

/// Decide how to handle a turn that carries images.
///
/// `chat` is the verdict for the model the user picked for this conversation; `vision_role_available`
/// says whether a `vision`-role model actually resolves (configured, or auto-matched in the catalog).
///
/// Only a *known-blind* model has its images taken away from it. For everyone else we send the image
/// and let the provider be the judge — because a wrong guess in the other direction is SILENT:
/// delegating a genuinely multimodal model would quietly downgrade it to a second-hand description
/// with nobody the wiser. What we can do is not make the user pay for our guess being wrong, so
/// whenever a vision model exists to stand in, the turn keeps its seed and recovers from a rejection
/// instead of surfacing a 400. That net is worth having even when we're confident the model sees:
/// `Yes` is only ever a catalog's opinion, and catalogs are wrong.
pub fn plan_attachments(chat: VisionSupport, vision_role_available: bool) -> AttachmentPlan {
    match (chat, vision_role_available) {
        // Known-blind: don't send what it cannot read.
        (VisionSupport::No, true) => AttachmentPlan::Delegate,
        (VisionSupport::No, false) => AttachmentPlan::Refuse,
        // Everyone else gets the image — with a net if there is one to hang.
        (_, true) => AttachmentPlan::InlineWithFallback,
        (_, false) => AttachmentPlan::Inline,
    }
}

/// Does this OpenAI-compat message carry an `image_url` part?
pub fn message_has_image(message: &Value) -> bool {
    message
        .get("content")
        .and_then(|c| c.as_array())
        .is_some_and(|parts| {
            parts
                .iter()
                .any(|p| p.get("type").and_then(|t| t.as_str()) == Some("image_url"))
        })
}

/// Does the conversation we are about to send carry any image at all? Gates the whole fallback: a 400
/// that merely *mentions* images must not trigger a re-run of a turn that never sent one.
pub fn messages_have_image(messages: &[Value]) -> bool {
    messages.iter().any(message_has_image)
}

/// Is this upstream error the provider telling us it cannot look at the image?
///
/// There is no status code or error code for "I am blind" — every provider says it in prose, in its
/// own words ("this model does not support image input", "No endpoints found that support image
/// input", "Invalid content type. image_url is only supported by…"). So we match on the two things
/// they all have in common: a word for the picture, and a word for the refusal. Deliberately
/// conservative — a body that fails this test just takes the normal error path the user already sees.
pub fn looks_like_image_rejection(body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    let mentions_image = ["image", "vision", "multimodal", "image_url"]
        .iter()
        .any(|needle| lower.contains(needle));
    let mentions_refusal = [
        "not support",
        "unsupported",
        "n't support",
        "only supported",
        "no endpoints found",
        "invalid content type",
        "cannot process",
        "missing data required",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    mentions_image && mentions_refusal
}

/// The `data:` URLs of every image in the conversation, in the order the model would have seen them —
/// the input to the describe sub-turn, and index-aligned with `replace_images_with_descriptions`.
pub fn collect_image_urls(messages: &[Value]) -> Vec<String> {
    messages
        .iter()
        .filter_map(|m| m.get("content")?.as_array())
        .flatten()
        .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("image_url"))
        .filter_map(|p| {
            p.get("image_url")?
                .get("url")?
                .as_str()
                .map(str::to_string)
        })
        .collect()
}

/// The text that stands in for an image the manager cannot see. Named so the manager knows it is
/// reading a description, not looking at the picture — otherwise it will happily claim it "sees" it.
fn described_image_part(index: usize, description: &str) -> Value {
    serde_json::json!({
        "type": "text",
        "text": format!(
            "[Image {} — you cannot see images; a vision model looked at it for you and reported:]\n{}",
            index + 1,
            description.trim()
        ),
    })
}

/// Swap every `image_url` part in the conversation for the vision model's description of it, in order.
///
/// This is what makes the turn survivable on a blind manager: same message, same position, same
/// meaning — only the modality changed. An image with no description (the sub-turn failed for it) is
/// replaced by an honest note rather than silently dropped, so the model never answers as if it had
/// seen something it didn't.
pub fn replace_images_with_descriptions(messages: &mut [Value], descriptions: &[String]) {
    // An image the sub-turn failed on arrives here as an empty string (the slot is KEPT so the
    // remaining descriptions stay aligned with the remaining images). Empty and missing mean the same
    // thing and get the same honest note.
    const UNDESCRIBED: &str =
        "(the vision model could not describe this image — tell the user you were unable to read it)";
    let mut seen = 0usize;
    for message in messages.iter_mut() {
        let Some(parts) = message.get_mut("content").and_then(|c| c.as_array_mut()) else {
            continue;
        };
        for part in parts.iter_mut() {
            if part.get("type").and_then(|t| t.as_str()) != Some("image_url") {
                continue;
            }
            let description = descriptions
                .get(seen)
                .map(String::as_str)
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .unwrap_or(UNDESCRIBED);
            *part = described_image_part(seen, description);
            seen += 1;
        }
    }
}

/// The provider binding for the `vision` role (resolved gateway-side, like every other role).
pub struct VisionModel {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

/// Look at ONE image on the vision model and report what it shows, in service of `goal`.
///
/// This is ADR 0025's recursion in its degenerate form: a sub-turn with no tools and a single round.
/// The goal travels with it for exactly the reason `browse(goal)` carries one — "describe this image"
/// and "what's the total on this receipt?" want very different descriptions, and what comes back here
/// is ALL the manager will ever know about the picture. `None` on any failure: the caller keeps the
/// slot and tells the user it couldn't read that image, rather than answering as if it had.
async fn describe_one_image(
    http: &reqwest::Client,
    vision: &VisionModel,
    image_url: &str,
    goal: &str,
) -> Option<String> {
    let endpoint = format!(
        "{}/chat/completions",
        vision.base_url.trim_end_matches('/')
    );
    let system = "You are the eyes of an assistant that cannot see images. Look at the image and \
report what it actually shows, in service of the request. Transcribe any text verbatim; give the \
numbers, labels, layout and colors that matter. Be concrete and complete — the assistant will answer \
using ONLY your description and can never look for itself. Never speculate beyond what is visible. \
Reply in the language of the request.";
    // Generous ceiling: a reasoning model spends its budget on hidden reasoning BEFORE emitting any
    // content, and a tight cap would silently return an empty description (see `generate_thread_title`).
    let payload = serde_json::json!({
        "model": vision.model,
        "temperature": 0,
        "max_tokens": 1500,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": [
                { "type": "text", "text": format!("The assistant was asked:\n\n{goal}\n\nDescribe this image so it can answer without seeing it.") },
                { "type": "image_url", "image_url": { "url": image_url } },
            ]},
        ],
    });
    let mut builder = http
        .post(&endpoint)
        // Vision on a local model is slow (encode + prefill on a large image); the browser loop's
        // screenshot budget is the closest precedent.
        .timeout(std::time::Duration::from_secs(90));
    if let Some(key) = vision.api_key.as_ref() {
        builder = builder.bearer_auth(key);
    }
    let response = match builder.json(&payload).send().await {
        Ok(response) => response,
        Err(error) => {
            eprintln!("[gateway] vision describe: transport error ({error})");
            return None;
        }
    };
    if !response.status().is_success() {
        let code = response.status();
        let body = response.text().await.unwrap_or_default();
        // Loud on purpose: a misconfigured vision role must never look like "the image was blank".
        eprintln!(
            "[gateway] vision describe: «{}» failed ({code}): {}",
            vision.model,
            body.trim().chars().take(240).collect::<String>()
        );
        return None;
    }
    let body: serde_json::Value = response.json().await.ok()?;
    let text = body
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?
        .as_str()?
        .trim()
        .to_string();
    if text.is_empty() {
        eprintln!(
            "[gateway] vision describe: «{}» returned an empty description",
            vision.model
        );
        return None;
    }
    Some(text)
}

/// Describe every image, index-aligned with the input (a failure keeps its slot as an empty string so
/// the descriptions never shift onto the wrong picture).
///
/// `candidates` is best-first. We walk it until one model actually answers, then STAY on that one for
/// the remaining images — a catalog can promise a model the provider has since retired, and a dead
/// first choice must cost a retry, not the capability. Sticking to the survivor keeps a multi-image
/// turn from paying the dead model's timeout once per picture.
pub async fn describe_images(
    http: &reqwest::Client,
    candidates: &[VisionModel],
    images: &[String],
    goal: &str,
) -> Vec<String> {
    let mut out = Vec::with_capacity(images.len());
    // Index into `candidates` of the model that last worked; everything before it is known-dead.
    let mut working: Option<usize> = None;
    for image in images {
        let start = working.unwrap_or(0);
        let mut description = String::new();
        for (offset, candidate) in candidates.iter().enumerate().skip(start) {
            if let Some(text) = describe_one_image(http, candidate, image, goal).await {
                if working != Some(offset) {
                    // Loud: silently answering from a different model than the configured one would
                    // make a retired role model look like it's still doing the job.
                    eprintln!(
                        "[gateway] vision describe: using «{}» (earlier candidates failed)",
                        candidate.model
                    );
                }
                working = Some(offset);
                description = text;
                break;
            }
        }
        out.push(description);
    }
    out
}

/// The message shown when the turn carries images, the chat model is known-blind, and no `vision`
/// model is configured to stand in for it. An honest dead end beats a provider stack trace.
pub fn no_vision_model_message(model: &str) -> String {
    format!(
        "The model «{model}» cannot read images, and no vision model is configured to read them for it. \
Pick a vision-capable model for this chat, or set one for the Vision role in Settings → Model & Runtime."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalog_answers_for_cloud_models_too() {
        // The regression that started this: a cloud chat model used to fall through to an optimistic
        // "yes" and 400 on the image. Its catalog entry now answers for it.
        assert_eq!(vision_support(Some(false)), VisionSupport::No);
        assert_eq!(vision_support(Some(true)), VisionSupport::Yes);
    }

    #[test]
    fn a_model_in_no_catalog_is_unknown_not_blind() {
        // The `unwrap_or_default()` trap in the capability cache turns "never established" into a
        // confident `false`. Nothing may do that here: no entry means no opinion.
        assert_eq!(vision_support(None), VisionSupport::Unknown);
    }

    #[test]
    fn a_seeing_model_takes_the_images_inline() {
        assert_eq!(
            plan_attachments(VisionSupport::Yes, false),
            AttachmentPlan::Inline
        );
    }

    #[test]
    fn even_a_seeing_model_gets_the_net_when_one_exists() {
        // `Yes` is a catalog's opinion, and catalogs are wrong: if the provider rejects the image
        // anyway, the turn must still be recoverable rather than dying on a 400.
        assert_eq!(
            plan_attachments(VisionSupport::Yes, true),
            AttachmentPlan::InlineWithFallback
        );
    }

    #[test]
    fn a_blind_model_delegates_when_a_vision_model_exists() {
        assert_eq!(
            plan_attachments(VisionSupport::No, true),
            AttachmentPlan::Delegate
        );
    }

    #[test]
    fn a_blind_model_with_nowhere_to_delegate_refuses() {
        assert_eq!(
            plan_attachments(VisionSupport::No, false),
            AttachmentPlan::Refuse
        );
    }

    #[test]
    fn an_unknown_model_is_tried_with_a_net_when_one_exists() {
        // Never downgrade a possibly-multimodal model silently: send the image, and recover if the
        // provider says no.
        assert_eq!(
            plan_attachments(VisionSupport::Unknown, true),
            AttachmentPlan::InlineWithFallback
        );
    }

    #[test]
    fn an_unknown_model_with_no_net_is_still_tried() {
        assert_eq!(
            plan_attachments(VisionSupport::Unknown, false),
            AttachmentPlan::Inline
        );
    }

    #[test]
    fn image_parts_are_detected_in_multimodal_messages_only() {
        let plain = serde_json::json!({ "role": "user", "content": "hello" });
        let multi = serde_json::json!({
            "role": "user",
            "content": [
                { "type": "text", "text": "look" },
                { "type": "image_url", "image_url": { "url": "data:image/png;base64,AAA" } },
            ],
        });
        assert!(!message_has_image(&plain));
        assert!(message_has_image(&multi));
        assert!(messages_have_image(&[plain, multi]));
    }

    #[test]
    fn the_providers_own_words_for_blindness_are_recognized() {
        // Real bodies, as the providers phrase them (the deepseek one is the reported bug).
        assert!(looks_like_image_rejection(
            "this model does not support image input"
        ));
        assert!(looks_like_image_rejection(
            "No endpoints found that support image input"
        ));
        assert!(looks_like_image_rejection(
            "Invalid content type. image_url is only supported by certain models."
        ));
        assert!(looks_like_image_rejection(
            "this model is missing data required for image input"
        ));
    }

    #[test]
    fn unrelated_errors_are_not_mistaken_for_blindness() {
        // These must take the normal error path — retrying them would burn a vision call for nothing.
        assert!(!looks_like_image_rejection(
            "glm-4.6 was retired at 2026-06-16"
        ));
        assert!(!looks_like_image_rejection("rate limit exceeded"));
        assert!(!looks_like_image_rejection(
            "context length exceeded: 40000 > 32768"
        ));
        // Mentions images, but is not a refusal to look at one.
        assert!(!looks_like_image_rejection(
            "image generation quota exhausted"
        ));
    }

    #[test]
    fn descriptions_replace_images_in_place_and_in_order() {
        let mut messages = vec![
            serde_json::json!({ "role": "system", "content": "sys" }),
            serde_json::json!({
                "role": "user",
                "content": [
                    { "type": "text", "text": "describe them" },
                    { "type": "image_url", "image_url": { "url": "data:a" } },
                    { "type": "image_url", "image_url": { "url": "data:b" } },
                ],
            }),
        ];
        replace_images_with_descriptions(
            &mut messages,
            &["a cat".to_string(), "a dog".to_string()],
        );
        let parts = messages[1]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 3, "the text part survives, the images are swapped");
        assert!(parts.iter().all(|p| p["type"] == "text"));
        assert_eq!(parts[0]["text"], "describe them");
        assert!(parts[1]["text"].as_str().unwrap().contains("a cat"));
        assert!(parts[2]["text"].as_str().unwrap().contains("a dog"));
        // The manager must know it is reading, not seeing.
        assert!(parts[1]["text"]
            .as_str()
            .unwrap()
            .contains("you cannot see images"));
    }

    #[test]
    fn an_undescribed_image_says_so_instead_of_vanishing() {
        // A silently dropped image is the worst outcome: the model would answer as if it had looked.
        let mut messages = vec![serde_json::json!({
            "role": "user",
            "content": [
                { "type": "image_url", "image_url": { "url": "data:a" } },
            ],
        })];
        replace_images_with_descriptions(&mut messages, &[]);
        let parts = messages[0]["content"].as_array().unwrap();
        assert_eq!(parts.len(), 1);
        assert!(parts[0]["text"].as_str().unwrap().contains("could not describe"));
    }
}
