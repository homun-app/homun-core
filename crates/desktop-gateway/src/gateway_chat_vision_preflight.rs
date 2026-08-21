//! Chat vision preflight owner.
//!
//! Owns the pre-loop decision for user-attached images: send inline, arm a
//! fallback, delegate to the vision role, or return an early refusal. The
//! post-loop image rejection recovery remains in `run_agent_rounds`.

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
