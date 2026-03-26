//! CAPTCHA types and recovery hints for browser automation.
//!
//! CAPTCHA detection is vision-based: the LLM vision model analyzes
//! screenshots and identifies challenges by visual understanding, not
//! keyword matching. This module provides the type vocabulary and
//! actionable hints that the agent uses to respond.

/// Detected CAPTCHA type on the current page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptchaKind {
    /// PerimeterX / HUMAN Security "press and hold" button.
    HoldToVerify,
    /// Cloudflare Turnstile / browser check challenge page.
    CloudflareTurnstile,
    /// Visual CAPTCHA (hCaptcha, reCAPTCHA) requiring human intervention.
    VisualChallenge,
    /// Rate limit / access denied page.
    Blocked,
}

/// Generate an actionable recovery hint for the agent based on CAPTCHA type.
///
/// Used by the agent loop when the vision model identifies a CAPTCHA
/// in a screenshot. The hint guides the agent toward resolution.
pub fn captcha_hint(kind: CaptchaKind) -> &'static str {
    match kind {
        CaptchaKind::HoldToVerify => {
            "Use hold_click(ref, duration_ms=3000) on the verify button. \
             After release, take a snapshot to check if the challenge was passed."
        }
        CaptchaKind::CloudflareTurnstile => {
            "Wait 5 seconds with wait(seconds=5), then take a snapshot. \
             Turnstile often auto-resolves with proper browser fingerprint."
        }
        CaptchaKind::VisualChallenge => {
            "This site requires manual CAPTCHA solving. \
             Inform the user that they need to complete it in the browser."
        }
        CaptchaKind::Blocked => {
            "The site is rate-limiting or blocking access. \
             Wait at least 30 seconds before retrying."
        }
    }
}
