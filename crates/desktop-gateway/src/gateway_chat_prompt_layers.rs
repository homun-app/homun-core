//! Chat prompt layer composition owner.
//!
//! Owns the runtime assembly order for prompt layers derived from already
//! resolved chat context. The individual prompt wording and context discovery
//! stay with their existing owners.

use std::collections::HashSet;

use crate::gateway_artifacts::ArtifactDestination;
use crate::gateway_channels::ContactTurnContext;
use crate::gateway_prompt_instructions::{
    artifact_destination_prompt_block, booking_assumption_choice_instruction,
    choice_clarify_instruction, contact_context_instruction_block,
};
use crate::gateway_skill_runtime::skill_prompt_instructions_block;

pub(crate) struct ChatPromptLayersInput<'a> {
    pub(crate) system: String,
    pub(crate) contact: Option<&'a ContactTurnContext>,
    pub(crate) enabled_skills: &'a [(String, String, String)],
    pub(crate) homuncoder: &'a HashSet<String>,
    pub(crate) is_project: bool,
    pub(crate) choice_resume_slot: Option<String>,
    pub(crate) artifact_destinations: &'a [ArtifactDestination],
}

pub(crate) fn append_chat_prompt_layers(input: ChatPromptLayersInput<'_>) -> String {
    let system = if let Some(cx) = input.contact {
        let block = contact_context_instruction_block(
            &cx.name,
            &cx.tone_of_voice,
            &cx.persona_instructions,
            &cx.relationships,
            cx.perimeter.can_see_contacts,
            cx.perimeter.can_see_calendar,
        );
        format!("{block}\n\n{}", input.system)
    } else {
        input.system
    };
    let system = match skill_prompt_instructions_block(
        input.enabled_skills,
        input.homuncoder,
        input.is_project,
    ) {
        Some(block) => format!("{system}\n\n{block}"),
        None => system,
    };
    let system = format!("{system}\n\n{}", choice_clarify_instruction());
    let system = format!("{system}\n{}", booking_assumption_choice_instruction());
    let system = match input.choice_resume_slot {
        Some(resume) => format!("{system}\n\n{resume}"),
        None => system,
    };
    match artifact_destination_prompt_block(input.artifact_destinations) {
        Some(block) => format!("{system}\n\n{block}"),
        None => system,
    }
}
