use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptGuardVerdict {
    Allow,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptGuardResult {
    pub verdict: PromptGuardVerdict,
    pub reasons: Vec<String>,
}

pub fn guard_prompt(prompt: &str) -> PromptGuardResult {
    let normalized = normalize_prompt_for_guard(prompt);
    let mut reasons = Vec::new();

    if normalized.contains("ignore previous instructions")
        || normalized.contains("disregard previous instructions")
        || normalized.contains("forget previous instructions")
        || normalized.contains("you are now")
        || normalized.contains("developer mode")
    {
        reasons.push("instruction_override".to_string());
    }
    if normalized.contains("reveal the system prompt")
        || normalized.contains("show the system prompt")
        || normalized.contains("print the system prompt")
        || normalized.contains("developer instructions")
    {
        reasons.push("prompt_exfiltration".to_string());
    }
    if normalized.contains("api key")
        || normalized.contains("access token")
        || normalized.contains("password")
        || normalized.contains("secret")
    {
        reasons.push("secret_exfiltration".to_string());
    }

    PromptGuardResult {
        verdict: if reasons.is_empty() {
            PromptGuardVerdict::Allow
        } else {
            PromptGuardVerdict::Block
        },
        reasons,
    }
}

fn normalize_prompt_for_guard(prompt: &str) -> String {
    prompt
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch.is_ascii_whitespace() {
                ch.to_ascii_lowercase()
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
