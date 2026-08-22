//! Chat vision post-loop recovery owner.
//!
//! Owns the fallback seed mutation after a text-only manager rejects inline
//! images. The agent loop retry remains in `run_agent_rounds`.

use super::*;

pub(crate) struct ChatVisionRecoveryInput<'a> {
    pub(crate) http: &'a reqwest::Client,
    pub(crate) seed: &'a mut ChatVisionFallbackSeed,
    pub(crate) readers: &'a [vision::VisionModel],
    pub(crate) prompt: &'a str,
}

pub(crate) async fn recover_chat_vision_fallback_seed(input: ChatVisionRecoveryInput<'_>) {
    let images = vision::collect_image_urls(&input.seed.loop_state.messages);
    let descriptions =
        vision::describe_images(input.http, input.readers, &images, input.prompt).await;
    vision::replace_images_with_descriptions(&mut input.seed.loop_state.messages, &descriptions);
}
