use crate::protocol::AppSnapshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderDisclosure {
    Local,
    Remote,
    Unknown,
}

#[derive(Debug, Clone, Copy)]
pub struct DisclosurePolicy {
    pub disclose_screenshots_to_remote: bool,
}

pub fn project_snapshot(
    snapshot: &AppSnapshot,
    provider: ProviderDisclosure,
    policy: DisclosurePolicy,
) -> AppSnapshot {
    let mut projected = snapshot.clone();
    for element in &mut projected.elements {
        if element.sensitive {
            element.value = None;
            element.actions.clear();
            continue;
        }
        if let Some(value) = &element.value {
            if provider != ProviderDisclosure::Local || looks_private(value) {
                element.value = Some("[redacted]".to_string());
            } else if value.chars().count() > 512 {
                element.value = Some(value.chars().take(512).collect());
            }
        }
    }
    if provider != ProviderDisclosure::Local && !policy.disclose_screenshots_to_remote {
        projected.screenshot_ref = None;
    }
    projected
}

fn looks_private(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    value.contains('@')
        || lower.contains("bearer ")
        || lower.contains("token=")
        || lower.contains("password")
        || value.starts_with("/Users/")
        || value
            .chars()
            .filter(|character| character.is_ascii_digit())
            .count()
            >= 8
}
