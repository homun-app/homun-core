//! Rich response blocks for native UI rendering on capable clients.
//!
//! Tools can return `ResponseBlock` items alongside their text output.
//! Capable clients (Flutter, Web UI) render them as interactive cards;
//! other channels fall back to the markdown in the tool's text output.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ─── Block Types ────────────────────────────────────────────────

/// A rich response block produced by a tool.
/// Tagged by `block_type` for JSON (de)serialization.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "block_type", rename_all = "snake_case")]
pub enum ResponseBlock {
    /// Pick one from N options (trains, flights, restaurants…).
    Choice(ChoiceBlock),
    /// Approve or reject an action (booking, payment…).
    Approval(ApprovalBlock),
    /// Progress or state display (order tracking, task status).
    Status(StatusBlock),
    /// Structured result display (boarding pass, receipt).
    Result(ResultBlock),
    /// Message from an external system (email preview, notification).
    ExternalMessage(ExternalMessageBlock),
}

impl ResponseBlock {
    /// Returns the block type name for logging.
    pub fn block_type_name(&self) -> &'static str {
        match self {
            Self::Choice(_) => "choice",
            Self::Approval(_) => "approval",
            Self::Status(_) => "status",
            Self::Result(_) => "result",
            Self::ExternalMessage(_) => "external_message",
        }
    }
}

// ─── Choice ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChoiceBlock {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub options: Vec<BlockOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlockOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

// ─── Approval ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ApprovalBlock {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub approve_label: String,
    pub deny_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

// ─── Status ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StatusBlock {
    pub id: String,
    pub title: String,
    pub status: BlockStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<KeyValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum BlockStatus {
    Pending,
    Active,
    Completed,
    Failed,
}

// ─── Result ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResultBlock {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<KeyValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

// ─── External Message ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExternalMessageBlock {
    pub id: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    pub preview: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

// ─── Shared ─────────────────────────────────────────────────────

/// A key-value pair for structured display fields.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KeyValue {
    pub label: String,
    pub value: String,
}

// ─── Inbound Block Response ─────────────────────────────────────

/// Sent by the client when a user interacts with a block (taps an option, approves, etc.).
/// Travels as `block_response` alongside the regular message `content`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlockResponse {
    pub block_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

// ─── Fence Block Extraction ─────────────────────────────────────

/// Extract `ResponseBlock` items from ` ```blocks ``` ` fences in LLM output.
/// Returns the cleaned text (fences removed) and any valid blocks found.
/// Invalid JSON or schema mismatches are silently skipped — the markdown
/// stays intact as fallback.
fn extract_fence_blocks(text: &str) -> (String, Vec<ResponseBlock>) {
    let mut blocks = Vec::new();
    let mut cleaned = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(start) = rest.find("```blocks") {
        // Append everything before the fence
        cleaned.push_str(&rest[..start]);

        // Find the closing fence
        let after_open = &rest[start + 9..]; // skip "```blocks"
        let body_start = after_open.find('\n').map(|i| i + 1).unwrap_or(0);
        let body_rest = &after_open[body_start..];

        if let Some(close) = body_rest.find("```") {
            let json_str = body_rest[..close].trim();

            // Try parsing as a single block or an array of blocks
            if let Ok(block) = serde_json::from_str::<ResponseBlock>(json_str) {
                blocks.push(block);
            } else if let Ok(arr) = serde_json::from_str::<Vec<ResponseBlock>>(json_str) {
                blocks.extend(arr);
            } else {
                tracing::debug!(
                    json = json_str,
                    "Failed to parse fence block JSON — keeping as markdown"
                );
                // Keep the fence in the output as-is
                cleaned.push_str(&rest[start..start + 9 + body_start + close + 3]);
            }
            rest = &body_rest[close + 3..];
        } else {
            // No closing fence — keep everything
            cleaned.push_str(&rest[start..]);
            rest = "";
        }
    }

    cleaned.push_str(rest);

    // Trim leading/trailing whitespace caused by fence removal
    let cleaned = cleaned.trim().to_string();
    (cleaned, blocks)
}

// ─── Unified Block Extraction ──────────────────────────────────

/// Extract response blocks from LLM output using a two-stage pipeline:
///
/// 1. **Fence extraction**: parse ` ```blocks ``` ` fences (explicit LLM intent)
/// 2. **Auto-detection fallback**: if no fences found, scan for structured
///    markdown patterns (numbered lists with consistent key-value fields)
///
/// Returns the cleaned text (fences removed) and any blocks found.
pub fn extract_blocks(text: &str) -> (String, Vec<ResponseBlock>) {
    let (cleaned, fence_blocks) = extract_fence_blocks(text);

    if !fence_blocks.is_empty() {
        return (cleaned, fence_blocks);
    }

    // Fallback: auto-detect structured patterns in markdown
    if let Some(auto_blocks) = detect_blocks_from_markdown(text) {
        tracing::debug!(
            count = auto_blocks.len(),
            "Auto-detected blocks from markdown"
        );
        return (text.to_string(), auto_blocks);
    }

    (cleaned, Vec::new())
}

// ─── Markdown Auto-Detection ───────────────────────────────────

/// Attempt to detect structured data in LLM markdown output and convert
/// to response blocks. This is a fallback for models that don't generate
/// ` ```blocks ` fences natively.
///
/// Detects numbered list patterns with consistent key-value fields and
/// converts them to `ChoiceBlock` items.
///
/// Returns `None` if no structured pattern is detected (the output is
/// plain prose or doesn't match known patterns).
fn detect_blocks_from_markdown(text: &str) -> Option<Vec<ResponseBlock>> {
    // Try numbered-heading pattern: "## N. **Title**" or "N. **Title**" or "**N. Title**"
    if let Some(blocks) = detect_numbered_items(text) {
        if !blocks.is_empty() {
            return Some(blocks);
        }
    }
    None
}

/// Detect numbered items with consistent structure.
/// Matches patterns like:
///   ## 1. **Name** — subtitle
///   **Key:** Value
///   **Key:** Value
///
///   ## 2. **Name** — subtitle
///   ...
fn detect_numbered_items(text: &str) -> Option<Vec<ResponseBlock>> {
    let lines: Vec<&str> = text.lines().collect();
    let mut items: Vec<(String, String, Vec<KeyValue>)> = Vec::new(); // (title, subtitle, fields)
    let mut current_title: Option<String> = None;
    let mut current_subtitle = String::new();
    let mut current_fields: Vec<KeyValue> = Vec::new();

    for line in &lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Try to match numbered heading: "## N. **Title**" or "N. **Title**"
        if let Some(heading) = parse_numbered_heading(trimmed) {
            // Save previous item if any
            if let Some(title) = current_title.take() {
                if !current_fields.is_empty() {
                    items.push((title, current_subtitle.clone(), current_fields.clone()));
                }
            }
            current_title = Some(heading.title);
            current_subtitle = heading.subtitle;
            current_fields = Vec::new();
            continue;
        }

        // Try to match key-value: "**Key:** Value" or "**Key**: Value"
        if current_title.is_some() {
            if let Some(kv) = parse_bold_key_value(trimmed) {
                current_fields.push(kv);
            }
        }
    }

    // Don't forget the last item
    if let Some(title) = current_title.take() {
        if !current_fields.is_empty() {
            items.push((title, current_subtitle, current_fields));
        }
    }

    // Need at least 2 items with consistent fields to be considered structured
    if items.len() < 2 {
        return None;
    }

    // Check field consistency: all items should have at least 1 field in common
    let first_labels: std::collections::HashSet<&str> =
        items[0].2.iter().map(|f| f.label.as_str()).collect();
    let has_common_fields = items[1..].iter().all(|item| {
        item.2
            .iter()
            .any(|f| first_labels.contains(f.label.as_str()))
    });

    if !has_common_fields {
        return None;
    }

    // Build a ChoiceBlock from the items
    let options: Vec<BlockOption> = items
        .iter()
        .enumerate()
        .map(|(i, (title, subtitle, fields))| {
            // Build subtitle from key fields (first 2)
            let detail = fields
                .iter()
                .take(2)
                .map(|f| format!("{}: {}", f.label, f.value))
                .collect::<Vec<_>>()
                .join(" · ");
            BlockOption {
                id: format!("item_{}", i + 1),
                label: title.clone(),
                subtitle: if !detail.is_empty() {
                    Some(detail)
                } else if !subtitle.is_empty() {
                    Some(subtitle.clone())
                } else {
                    None
                },
                icon: None,
                metadata: if fields.is_empty() {
                    None
                } else {
                    // Store all fields as metadata for reference
                    Some(serde_json::json!(fields
                        .iter()
                        .map(|f| (f.label.clone(), f.value.clone()))
                        .collect::<std::collections::HashMap<_, _>>()))
                },
            }
        })
        .collect();

    Some(vec![ResponseBlock::Choice(ChoiceBlock {
        id: format!("auto_choice_{}", options.len()),
        title: "Scegli un'opzione".to_string(), // Generic — caller can customize
        subtitle: None,
        options,
    })])
}

struct ParsedHeading {
    title: String,
    subtitle: String,
}

/// Parse numbered heading patterns:
/// - "## 1. **Title** — subtitle"
/// - "## 🍽️ 1. **Title**"
/// - "1. **Title** — subtitle"
/// - "**1. Title**"
fn parse_numbered_heading(line: &str) -> Option<ParsedHeading> {
    // Strip leading #'s and whitespace
    let stripped = line.trim_start_matches('#').trim();

    // Strip leading emoji clusters (one or more emoji chars followed by space)
    let stripped = strip_leading_emoji(stripped);

    // Match: N. **Title** or N. Title (where N is a digit)
    let re_match = stripped
        .chars()
        .next()
        .map(|c| c.is_ascii_digit())
        .unwrap_or(false);

    if !re_match {
        return None;
    }

    // Find the dot after the number
    let dot_pos = stripped.find(". ")?;
    let after_dot = stripped[dot_pos + 2..].trim();

    // Extract title (may be in **bold**)
    let (title, rest) = if let Some(inner) = after_dot.strip_prefix("**") {
        // **Title** — subtitle  or  **Title**
        let end_bold = inner.find("**")?;
        let title = inner[..end_bold].to_string();
        let rest = inner[end_bold + 2..].trim();
        (title, rest)
    } else {
        // Plain title — take until end of line or " — "
        if let Some(dash_pos) = after_dot.find(" — ") {
            (after_dot[..dash_pos].to_string(), &after_dot[dash_pos..])
        } else if let Some(dash_pos) = after_dot.find(" - ") {
            (after_dot[..dash_pos].to_string(), &after_dot[dash_pos..])
        } else {
            (after_dot.to_string(), "")
        }
    };

    // Extract subtitle (after " — " or " - " or "— ")
    let subtitle = rest
        .trim_start_matches(" — ")
        .trim_start_matches(" - ")
        .trim_start_matches("— ")
        .trim_start_matches("- ")
        .trim()
        .to_string();

    Some(ParsedHeading { title, subtitle })
}

/// Parse "**Key:** Value" or "**Key**: Value" patterns.
/// Also handles emoji prefix: "📍 **Location:** ..."
fn parse_bold_key_value(line: &str) -> Option<KeyValue> {
    let stripped = strip_leading_emoji(line);

    if !stripped.starts_with("**") {
        return None;
    }

    // Find closing ** that's followed by : or :
    let inner_start = 2;
    let end_bold = stripped[inner_start..].find("**")?;
    let label_raw = &stripped[inner_start..inner_start + end_bold];

    // The label may end with : or the : may be after **
    let after_bold = stripped[inner_start + end_bold + 2..].trim();
    let (label, value) = if let Some(label) = label_raw.strip_suffix(':') {
        (label.trim().to_string(), after_bold.to_string())
    } else if let Some(value) = after_bold.strip_prefix(':') {
        (label_raw.trim().to_string(), value.trim().to_string())
    } else {
        return None; // No colon found — not a key-value pair
    };

    if label.is_empty() || value.is_empty() {
        return None;
    }

    Some(KeyValue { label, value })
}

/// Strip leading emoji characters (Unicode emoji + variation selectors + ZWJ sequences)
fn strip_leading_emoji(s: &str) -> &str {
    let mut chars = s.char_indices();
    let mut last_emoji_end = 0;

    while let Some((idx, ch)) = chars.next() {
        if is_emoji_like(ch) {
            last_emoji_end = idx + ch.len_utf8();
            // Also consume variation selectors and ZWJ
            while let Some(&(next_idx, next_ch)) = chars.clone().next().as_ref() {
                if next_ch == '\u{FE0F}' || next_ch == '\u{200D}' || is_emoji_like(next_ch) {
                    last_emoji_end = next_idx + next_ch.len_utf8();
                    chars.next();
                } else {
                    break;
                }
            }
        } else if ch == ' ' && last_emoji_end > 0 {
            // Space after emoji — consume it
            last_emoji_end = idx + 1;
            break;
        } else {
            break;
        }
    }

    &s[last_emoji_end..]
}

/// Quick check if a char is likely an emoji (covers common ranges)
fn is_emoji_like(ch: char) -> bool {
    matches!(ch,
        '\u{1F300}'..='\u{1F9FF}' |  // Misc symbols, emoticons, etc
        '\u{2600}'..='\u{26FF}'   |  // Misc symbols
        '\u{2700}'..='\u{27BF}'   |  // Dingbats
        '\u{FE00}'..='\u{FE0F}'   |  // Variation selectors
        '\u{200D}'                |  // ZWJ
        '\u{1F1E0}'..='\u{1F1FF}' |  // Flags
        '\u{E0020}'..='\u{E007F}'    // Tags
    )
}

// ─── Tests ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choice_block_roundtrip() {
        let block = ResponseBlock::Choice(ChoiceBlock {
            id: "blk_1".into(),
            title: "Treni Roma → Milano".into(),
            subtitle: None,
            options: vec![BlockOption {
                id: "opt1".into(),
                label: "14:30 → 17:45".into(),
                subtitle: Some("€49.90".into()),
                icon: None,
                metadata: Some(serde_json::json!({"provider": "trenitalia", "train_id": "TR123"})),
            }],
        });

        let json = serde_json::to_string(&block).unwrap();
        assert!(json.contains("\"block_type\":\"choice\""));
        assert!(json.contains("\"train_id\":\"TR123\""));

        let deserialized: ResponseBlock = serde_json::from_str(&json).unwrap();
        assert_eq!(block, deserialized);
    }

    #[test]
    fn approval_block_roundtrip() {
        let block = ResponseBlock::Approval(ApprovalBlock {
            id: "blk_approve_1".into(),
            title: "Conferma prenotazione".into(),
            description: Some("Frecciarossa 14:30, 1a classe, €49.90".into()),
            approve_label: "Prenota".into(),
            deny_label: "Annulla".into(),
            metadata: None,
        });

        let json = serde_json::to_string(&block).unwrap();
        let deserialized: ResponseBlock = serde_json::from_str(&json).unwrap();
        assert_eq!(block, deserialized);
    }

    #[test]
    fn status_block_roundtrip() {
        let block = ResponseBlock::Status(StatusBlock {
            id: "blk_status_1".into(),
            title: "Prenotazione TR123".into(),
            status: BlockStatus::Active,
            fields: vec![KeyValue {
                label: "Partenza".into(),
                value: "Roma Termini 14:30".into(),
            }],
        });

        let json = serde_json::to_string(&block).unwrap();
        assert!(json.contains("\"status\":\"active\""));
        let deserialized: ResponseBlock = serde_json::from_str(&json).unwrap();
        assert_eq!(block, deserialized);
    }

    #[test]
    fn block_response_roundtrip() {
        let resp = BlockResponse {
            block_id: "blk_1".into(),
            option_id: Some("opt1".into()),
            action: None,
            metadata: Some(serde_json::json!({"train_id": "TR123"})),
        };

        let json = serde_json::to_string(&resp).unwrap();
        let deserialized: BlockResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(resp, deserialized);
    }

    #[test]
    fn extract_fence_single_block() {
        let input = "Ecco i treni:\n```blocks\n{\"block_type\":\"choice\",\"id\":\"b1\",\"title\":\"Treni\",\"options\":[{\"id\":\"o1\",\"label\":\"IC 724\"}]}\n```\nQuale preferisci?";
        let (cleaned, blocks) = extract_fence_blocks(input);
        assert_eq!(blocks.len(), 1);
        assert!(cleaned.contains("Ecco i treni:"));
        assert!(cleaned.contains("Quale preferisci?"));
        assert!(!cleaned.contains("```blocks"));
    }

    #[test]
    fn extract_fence_invalid_json_keeps_markdown() {
        let input = "Testo\n```blocks\n{invalid json}\n```\nFine";
        let (cleaned, blocks) = extract_fence_blocks(input);
        assert!(blocks.is_empty());
        assert!(cleaned.contains("```blocks"));
        assert!(cleaned.contains("{invalid json}"));
    }

    #[test]
    fn extract_fence_no_fence() {
        let input = "Risposta normale senza blocks";
        let (cleaned, blocks) = extract_fence_blocks(input);
        assert!(blocks.is_empty());
        assert_eq!(cleaned, input);
    }

    // ─── Unified extract_blocks tests ────────────────────────────

    #[test]
    fn extract_blocks_prefers_fence() {
        // When fences exist, use them (don't auto-detect)
        let input = "Ecco:\n```blocks\n{\"block_type\":\"choice\",\"id\":\"b1\",\"title\":\"Test\",\"options\":[{\"id\":\"o1\",\"label\":\"A\"}]}\n```\nFine";
        let (cleaned, blocks) = extract_blocks(input);
        assert_eq!(blocks.len(), 1);
        assert!(!cleaned.contains("```blocks"));
    }

    #[test]
    fn extract_blocks_falls_back_to_auto_detect() {
        // No fences → auto-detect structured markdown
        let input = r#"1. **Option A** — first
**Price:** €10

2. **Option B** — second
**Price:** €20"#;
        let (_, blocks) = extract_blocks(input);
        assert_eq!(blocks.len(), 1, "Should auto-detect as ChoiceBlock");
    }

    #[test]
    fn extract_blocks_plain_text_no_blocks() {
        let input = "Just a regular response with no structure.";
        let (cleaned, blocks) = extract_blocks(input);
        assert!(blocks.is_empty());
        assert_eq!(cleaned, input);
    }

    // ─── Auto-detection tests ──────────────────────────────────

    /// Real output from kimi-k2.5:cloud — restaurant recommendations
    #[test]
    fn detect_restaurant_recommendations() {
        let input = r#"Ho raccolto ottime informazioni. Ecco 3 proposte per una cena romantica a Roma, con diverse fasce di prezzo:

---

## 🍽️ 1. **Necci dal 1924** — Atmosfera bohemien
📍 Via Fanfulla da Lodi, 68 — **Pigneto**
**Cucina:** Italiana mediterranea, piatti romani rivisitati
**Prezzo medio:** 15-25€ a persona
**Perché è romantico:** Giardino interno suggestivo, atmosfera rilassata e bohemien

## 🍽️ 2. **Adelaide** — Eleganza stellata
📍 Hotel Vilòn, Via dell'Arco della Ciambella — **Centro Storico**
**Cucina:** Italiana contemporanea, fine dining
**Prezzo medio:** 80-120€ a persona
**Perché è romantico:** Ristorante d'hotel elegante, terrazza con vista

## 🍽️ 3. **La Ciambella Bar à Vin** — Intimo e raffinato
📍 Via dell'Arco della Ciambella 20 — **Centro**
**Cucina:** Francese-italiana, vini naturali
**Prezzo medio:** 40-60€ a persona
**Perché è romantico:** Piccolo locale intimo, perfetto per una serata a due

Quale preferisci? Posso cercare disponibilità e prenotare."#;

        let blocks = detect_blocks_from_markdown(input);
        assert!(blocks.is_some(), "Should detect restaurant list");
        let blocks = blocks.unwrap();
        assert_eq!(blocks.len(), 1, "Should produce one ChoiceBlock");

        match &blocks[0] {
            ResponseBlock::Choice(choice) => {
                assert_eq!(choice.options.len(), 3, "Should have 3 options");
                assert!(
                    choice.options[0].label.contains("Necci"),
                    "First option should be Necci: got {}",
                    choice.options[0].label
                );
                assert!(
                    choice.options[1].label.contains("Adelaide"),
                    "Second option should be Adelaide: got {}",
                    choice.options[1].label
                );
                assert!(
                    choice.options[2].label.contains("Ciambella"),
                    "Third option should be La Ciambella"
                );
                // Each option should have metadata with fields
                assert!(choice.options[0].metadata.is_some(), "Should have metadata");
                assert!(
                    choice.options[0].subtitle.is_some(),
                    "Should have subtitle from fields"
                );
            }
            _ => panic!("Expected ChoiceBlock"),
        }
    }

    /// Simulated output — train schedule (another common pattern)
    #[test]
    fn detect_train_schedule() {
        let input = r#"Ecco i treni disponibili per domani:

1. **IC 724** — Roma Termini → Milano Centrale
**Partenza:** 14:30
**Arrivo:** 17:45
**Prezzo:** €49.90

2. **FR 9618** — Roma Termini → Milano Centrale
**Partenza:** 15:00
**Arrivo:** 17:55
**Prezzo:** €79.00

3. **IC 730** — Roma Termini → Milano Centrale
**Partenza:** 16:15
**Arrivo:** 19:30
**Prezzo:** €45.00

Quale preferisci?"#;

        let blocks = detect_blocks_from_markdown(input);
        assert!(blocks.is_some(), "Should detect train list");
        let blocks = blocks.unwrap();

        match &blocks[0] {
            ResponseBlock::Choice(choice) => {
                assert_eq!(choice.options.len(), 3);
                assert!(choice.options[0].label.contains("IC 724"));
                assert!(choice.options[2].label.contains("IC 730"));
            }
            _ => panic!("Expected ChoiceBlock"),
        }
    }

    /// Plain prose — should NOT produce blocks
    #[test]
    fn detect_plain_prose_no_blocks() {
        let input = "Roma è una città bellissima! Ti consiglio di visitare il Colosseo, \
                      poi Piazza Navona e infine Trastevere per cena. Buon viaggio!";
        assert!(detect_blocks_from_markdown(input).is_none());
    }

    /// Single item — should NOT produce blocks (need at least 2)
    #[test]
    fn detect_single_item_no_blocks() {
        let input = r#"## 1. **Necci dal 1924**
**Cucina:** Italiana
**Prezzo:** 20€"#;
        assert!(detect_blocks_from_markdown(input).is_none());
    }

    /// Numbered list without consistent fields — should NOT produce blocks
    #[test]
    fn detect_inconsistent_fields_no_blocks() {
        let input = r#"1. **Step uno**
Fai questo

2. **Step due**
Poi fai quest'altro"#;
        assert!(detect_blocks_from_markdown(input).is_none());
    }

    // ─── Parsing helpers tests ─────────────────────────────────

    #[test]
    fn parse_heading_with_emoji_and_bold() {
        let h = parse_numbered_heading("## 🍽️ 1. **Necci dal 1924** — Atmosfera bohemien");
        assert!(h.is_some());
        let h = h.unwrap();
        assert_eq!(h.title, "Necci dal 1924");
        assert_eq!(h.subtitle, "Atmosfera bohemien");
    }

    #[test]
    fn parse_heading_simple_bold() {
        let h = parse_numbered_heading("1. **IC 724** — Roma → Milano");
        assert!(h.is_some());
        let h = h.unwrap();
        assert_eq!(h.title, "IC 724");
        assert_eq!(h.subtitle, "Roma → Milano");
    }

    #[test]
    fn parse_heading_no_subtitle() {
        let h = parse_numbered_heading("## 3. **La Ciambella**");
        assert!(h.is_some());
        let h = h.unwrap();
        assert_eq!(h.title, "La Ciambella");
        assert!(h.subtitle.is_empty());
    }

    #[test]
    fn parse_bold_kv_with_emoji() {
        let kv = parse_bold_key_value("📍 **Location:** Via Roma 1");
        assert!(kv.is_some());
        let kv = kv.unwrap();
        assert_eq!(kv.label, "Location");
        assert_eq!(kv.value, "Via Roma 1");
    }

    #[test]
    fn parse_bold_kv_colon_inside() {
        let kv = parse_bold_key_value("**Cucina:** Italiana mediterranea");
        assert!(kv.is_some());
        let kv = kv.unwrap();
        assert_eq!(kv.label, "Cucina");
        assert_eq!(kv.value, "Italiana mediterranea");
    }

    #[test]
    fn parse_bold_kv_colon_outside() {
        let kv = parse_bold_key_value("**Prezzo**: €49.90");
        assert!(kv.is_some());
        let kv = kv.unwrap();
        assert_eq!(kv.label, "Prezzo");
        assert_eq!(kv.value, "€49.90");
    }

    #[test]
    fn parse_bold_kv_not_kv() {
        // Bold text without colon — should NOT match
        assert!(parse_bold_key_value("**Just bold text**").is_none());
        // No bold — should NOT match
        assert!(parse_bold_key_value("Regular text").is_none());
    }

    #[test]
    fn strip_emoji_prefix() {
        assert_eq!(strip_leading_emoji("🍽️ 1. **Title**"), "1. **Title**");
        assert_eq!(strip_leading_emoji("📍 Via Roma"), "Via Roma");
        assert_eq!(strip_leading_emoji("No emoji here"), "No emoji here");
        assert_eq!(strip_leading_emoji("✅ Done"), "Done");
    }
}
