//! Inference provider routing for the local-first assistant.
//!
//! The Rust Core owns the decision of *where* inference runs. A [`ModelRouter`]
//! selects among [`InferenceProvider`]s (local engines and cloud endpoints)
//! under a deny-by-default [`PrivacyPolicy`], and exposes the same
//! `JsonRuntime` contract the Brain, subagents and desktop gateway already use,
//! so routing can be introduced without changing callers.
//!
//! See `docs/decisions/0007-inference-provider-routing.md`.

pub mod anthropic;
mod json_parse;
pub mod json_runtime_provider;
pub mod openai_compat;
pub mod policy;
pub mod provider;
pub mod router;
pub mod streaming;

#[cfg(feature = "local-mistralrs")]
pub mod mistralrs_provider;

pub use anthropic::{AnthropicProvider, parse_anthropic_message};
pub use json_runtime_provider::JsonRuntimeProvider;
pub use openai_compat::{OpenAiCompatProvider, parse_chat_completion};
pub use policy::PrivacyPolicy;
pub use provider::{CapabilityDescriptor, InferenceProvider, Locality, Requirements};
pub use router::ModelRouter;

#[cfg(feature = "local-mistralrs")]
pub use mistralrs_provider::{MistralRsError, MistralRsProvider};
