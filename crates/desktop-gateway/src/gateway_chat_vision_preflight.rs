//! Chat vision preflight owner.
//!
//! Owns the pre-loop decision for user-attached images: send inline, arm a
//! fallback, delegate to the vision role, or return an early refusal. The
//! post-loop image rejection recovery is owned by `gateway_chat_vision_recovery`.

use super::*;

pub(crate) struct ChatVisionPreflightInput<'a> {
    pub(crate) http: &'a reqwest::Client,
    pub(crate) base_url: &'a str,
    pub(crate) model: &'a str,
    pub(crate) messages: &'a mut [serde_json::Value],
    pub(crate) prompt: &'a str,
}

pub(crate) enum ChatVisionPreflight {
    Continue {
        fallback_armed: bool,
    },
    EarlyResponse {
        text: String,
        effective_model: String,
    },
}

pub(crate) struct ChatVisionFallbackSeed {
    pub(crate) loop_state: local_first_engine::LoopState,
    pub(crate) config: local_first_engine::TurnConfig,
    pub(crate) user_message: String,
    pub(crate) memory_answer: String,
    pub(crate) last_model_error: Option<String>,
    pub(crate) browse_sources: Vec<String>,
    pub(crate) trace_dir: Option<std::path::PathBuf>,
}

pub(crate) struct ChatVisionFallbackSeedInput<'a> {
    pub(crate) fallback_armed: bool,
    pub(crate) loop_state: &'a local_first_engine::LoopState,
    pub(crate) config: &'a local_first_engine::TurnConfig,
    pub(crate) user_message: &'a str,
    pub(crate) memory_answer: &'a str,
    pub(crate) last_model_error: &'a Option<String>,
    pub(crate) browse_sources: &'a [String],
    pub(crate) trace_dir: &'a Option<std::path::PathBuf>,
}

pub(crate) fn snapshot_chat_vision_fallback_seed(
    input: ChatVisionFallbackSeedInput<'_>,
) -> Option<ChatVisionFallbackSeed> {
    input.fallback_armed.then(|| ChatVisionFallbackSeed {
        loop_state: input.loop_state.clone(),
        config: input.config.clone(),
        user_message: input.user_message.to_string(),
        memory_answer: input.memory_answer.to_string(),
        last_model_error: input.last_model_error.clone(),
        browse_sources: input.browse_sources.to_vec(),
        trace_dir: input.trace_dir.clone(),
    })
}

pub(crate) async fn prepare_chat_vision_preflight(
    input: ChatVisionPreflightInput<'_>,
) -> ChatVisionPreflight {
    if !vision::messages_have_image(input.messages) {
        return ChatVisionPreflight::Continue {
            fallback_armed: false,
        };
    }

    match vision::plan_attachments(
        model_vision_support(input.base_url, input.model),
        has_vision_model(),
    ) {
        vision::AttachmentPlan::Refuse => ChatVisionPreflight::EarlyResponse {
            text: vision::no_vision_model_message(input.model),
            effective_model: "vision".to_string(),
        },
        vision::AttachmentPlan::Delegate => {
            let readers = vision_model_candidates();
            let images = vision::collect_image_urls(input.messages);
            let descriptions =
                vision::describe_images(input.http, &readers, &images, input.prompt).await;
            vision::replace_images_with_descriptions(input.messages, &descriptions);
            ChatVisionPreflight::Continue {
                fallback_armed: false,
            }
        }
        vision::AttachmentPlan::InlineWithFallback => ChatVisionPreflight::Continue {
            fallback_armed: true,
        },
        vision::AttachmentPlan::Inline => ChatVisionPreflight::Continue {
            fallback_armed: false,
        },
    }
}
