// Stripping app-only marker blocks before text leaves the desktop UI.
use local_first_desktop_gateway::strip_display_markers;

/// Remove app-only control markers before a message is delivered to a plain-text surface.
pub(crate) fn strip_chat_markers(text: &str) -> String {
    strip_display_markers(text).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gateway_chat_markers_remove_app_only_blocks_for_channels() {
        let text = "‹‹ACT››thinking‹‹/ACT››\nThe answer.\n‹‹PLAN››[]‹‹/PLAN››";
        assert_eq!(strip_chat_markers(text), "The answer.");
        assert_eq!(
            strip_chat_markers("‹‹REASONING››only thinking‹‹/REASONING››"),
            ""
        );
        assert_eq!(strip_chat_markers("just text"), "just text");
    }
}
