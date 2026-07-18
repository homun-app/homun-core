//! Document CONTENT generation — the same "model fills fixed slots, code owns
//! structure" caposaldo as deck generation, applied to the 16 registered
//! document block types (`docs/superpowers/plans/2026-07-16-presentations-fase2-documents.md`).
//!
//! A bundled document pack's `example.json` fixes the block SKELETON (which
//! blocks, in which order — curated by us, never by the model). This module
//! derives a STRICT JSON schema from that skeleton — one required property per
//! slot, `additionalProperties:false` — so the model can only fill content into
//! pre-existing slots; it cannot add, remove or reorder blocks. `assemble_doc_json`
//! then reassembles the model's slot-keyed output back into the ordered
//! `{"title","blocks":[...]}` doc.json the renderer expects, failing loudly (never
//! inventing content) if a slot is missing.
//!
//! Wired into `make_document`'s templated path (F2-T8, `main.rs`'s
//! `make_templated_document`): the unit-testable half (skeleton/schema/assemble)
//! is exercised below, the HTTP half (`generate_document_content`) live via that
//! call site.

use serde_json::{Map, Value, json};

use crate::TemplateCatalogEntry;

/// One fixed slot in a document's block skeleton: which block type occupies it,
/// the key the model-facing schema uses to address it, and the CURATED example
/// block itself. We keep the whole curated block so `assemble_doc_json` can carry
/// editorial chrome the model never fills (eyebrow/hero_art) onto the output —
/// making the generated doc match the preview (both sourced from example.json).
pub(crate) struct DocBlockSlot {
    pub(crate) block_type: String,
    pub(crate) slot_key: String,
    pub(crate) template_block: Map<String, Value>,
}

/// Derive the ordered slot skeleton from a pack's `example.json`. The curated
/// example fixes WHICH blocks appear and in what order; the model only ever
/// fills their fields (never chooses/reorders blocks — that's the caposaldo).
pub(crate) fn document_block_skeleton(example: &Value) -> Vec<DocBlockSlot> {
    example
        .get("blocks")
        .and_then(|b| b.as_array())
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(i, block)| {
            let block_type = block.get("type")?.as_str()?.to_string();
            let slot_key = format!("slot_{i}_{block_type}");
            let mut template_block = block.as_object().cloned().unwrap_or_default();
            template_block.remove("type");
            Some(DocBlockSlot { block_type, slot_key, template_block })
        })
        .collect()
}

/// `{"type":"string","description":desc}` — every leaf field gets a description
/// so a weak model knows what prose belongs there (ADR 0016: schemas alone
/// under-specify intent for small local models).
fn s(desc: &str) -> Value {
    json!({"type": "string", "description": desc})
}

/// `{"type":"array","description":desc,"items":items,"maxItems":max}` — caps
/// come from the block-registry table in the plan; they bound render/DOCX
/// layout, not model creativity (the model may emit fewer, never more).
fn arr(desc: &str, items: Value, max: usize) -> Value {
    json!({"type": "array", "description": desc, "items": items, "maxItems": max})
}

/// Strict object schema: every listed field is `required` (strict slot-filling
/// mode — the prompt tells the model to use `""`/`[]` for "empty", never omit
/// a key) and `additionalProperties:false` (the model cannot invent fields).
fn obj(fields: &[(&str, Value)]) -> Value {
    let mut properties = Map::new();
    let mut required = Vec::new();
    for (key, schema) in fields {
        properties.insert((*key).to_string(), schema.clone());
        required.push(Value::String((*key).to_string()));
    }
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

/// The 16-block registry: field shapes mirror the table in
/// `docs/superpowers/plans/2026-07-16-presentations-fase2-documents.md`
/// ("I 16 blocchi documento"), the single source shared by doc_render.py,
/// this schema and doc_json_to_docx (F2-T7). `None` for an unregistered type —
/// the caller must never fall back to a guessed shape.
pub(crate) fn document_block_schema(block_type: &str) -> Option<Value> {
    Some(match block_type {
        "section_cover" => obj(&[
            ("title", s("Section/cover title, short and punchy.")),
            ("subtitle", s("Supporting subtitle; use \"\" if none.")),
        ]),
        "text_section" => obj(&[
            ("title", s("Section heading; use \"\" for an untitled block.")),
            (
                "paragraphs",
                arr("Body paragraphs of plain prose, one per item.", s("A single paragraph."), 6),
            ),
            (
                "bullets",
                arr("Key facts as short bullet points.", s("A single bullet point."), 8),
            ),
        ]),
        "letterhead" => obj(&[
            ("organization", s("Sender organization name.")),
            ("contact_line", s("Address / email / phone, one compact line.")),
            ("date_line", s("Letter date, human-readable.")),
            (
                "recipient_lines",
                arr(
                    "Recipient name/address, one line per item.",
                    s("A single recipient address line."),
                    5,
                ),
            ),
        ]),
        "letter_body" => obj(&[
            ("salutation", s("Opening salutation, e.g. \"Dear Ms Rossi,\".")),
            (
                "paragraphs",
                arr("Letter body paragraphs, plain prose.", s("A single paragraph."), 8),
            ),
        ]),
        "signature_block" => obj(&[
            ("closing", s("Closing phrase, e.g. \"Kind regards,\".")),
            ("name", s("Signer's full name.")),
            ("role", s("Signer's role/title; use \"\" if none.")),
        ]),
        "cta_footer" => obj(&[
            ("heading", s("Call-to-action heading, e.g. \"Contact us\".")),
            (
                "lines",
                arr("Contact/closing lines.", s("A single contact or closing line."), 3),
            ),
        ]),
        "contact_header" => obj(&[
            ("name", s("Person's full name (CV/profile header).")),
            ("headline", s("Short professional headline; use \"\" if none.")),
            (
                "contact_items",
                arr(
                    "Contact details (email, phone, location, links).",
                    s("A single contact item."),
                    6,
                ),
            ),
        ]),
        "profile_summary" => obj(&[
            ("title", s("Summary heading, e.g. \"Profile\".")),
            ("text", s("Profile summary prose, a few sentences.")),
        ]),
        "timeline" => obj(&[
            ("title", s("Timeline heading, e.g. \"Experience\".")),
            (
                "entries",
                arr(
                    "Chronological entries (experience/phases), most recent first.",
                    obj(&[
                        ("label", s("Date range or short label, e.g. \"2020–2023\".")),
                        ("heading", s("Entry title, e.g. role or milestone name.")),
                        ("subheading", s("Entry subtitle, e.g. organization name.")),
                        (
                            "points",
                            arr(
                                "Short highlight points for this entry.",
                                s("A single highlight point."),
                                4,
                            ),
                        ),
                    ]),
                    8,
                ),
            ),
        ]),
        "education_list" => obj(&[
            ("title", s("Section heading, e.g. \"Education\".")),
            (
                "entries",
                arr(
                    "Education entries, most recent first.",
                    obj(&[
                        ("label", s("Date range or short label.")),
                        ("heading", s("Degree/programme name.")),
                        ("subheading", s("Institution name.")),
                    ]),
                    6,
                ),
            ),
        ]),
        "skill_tags" => obj(&[
            ("title", s("Section heading, e.g. \"Skills\".")),
            (
                "groups",
                arr(
                    "Skill groups (categories of related tags).",
                    obj(&[
                        ("label", s("Group label, e.g. \"Languages\".")),
                        (
                            "tags",
                            arr("Individual skill/tag names.", s("A single skill or tag."), 10),
                        ),
                    ]),
                    4,
                ),
            ),
        ]),
        "product_grid" => obj(&[
            ("title", s("Section heading, e.g. \"Products\".")),
            (
                "products",
                arr(
                    "Product/offering cards.",
                    obj(&[
                        ("name", s("Product name.")),
                        ("description", s("Short product description.")),
                        ("price", s("Price string, e.g. \"€49/mo\"; use \"\" if none.")),
                        ("badge", s("Optional badge text, e.g. \"New\"; use \"\" if none.")),
                    ]),
                    9,
                ),
            ),
        ]),
        "pricing_table" => obj(&[
            ("title", s("Table heading, e.g. \"Pricing\".")),
            (
                "headers",
                arr("Column headers.", s("A single column header."), 5),
            ),
            (
                "rows",
                arr(
                    "Table rows; each row is an array of cell strings aligned to headers.",
                    arr("One table row.", s("A single cell value."), 5),
                    10,
                ),
            ),
            ("note", s("Footnote below the table; use \"\" if none.")),
        ]),
        "spec_table" => obj(&[
            ("title", s("Table heading, e.g. \"Specifications\".")),
            (
                "headers",
                arr("Column headers.", s("A single column header."), 4),
            ),
            (
                "rows",
                arr(
                    "Table rows; each row is an array of cell strings aligned to headers.",
                    arr("One table row.", s("A single cell value."), 4),
                    12,
                ),
            ),
        ]),
        "kpi_band" => obj(&[
            ("title", s("Section heading; use \"\" if none.")),
            (
                "items",
                arr(
                    "KPI figures.",
                    obj(&[
                        ("value", s("The KPI figure, e.g. \"+32%\".")),
                        ("label", s("What the figure measures.")),
                    ]),
                    4,
                ),
            ),
        ]),
        "testimonial_quote" => obj(&[
            ("quote", s("The testimonial quote text.")),
            ("author", s("Quote author's name.")),
            ("role", s("Author's role/company; use \"\" if none.")),
        ]),
        _ => return None,
    })
}

/// Wrap the skeleton into the model-facing strict schema: `{title, slots:
/// {<slot_key>: <block schema>, ...}}`, `additionalProperties:false` and every
/// slot `required`. The model never sees or chooses block types — only the
/// slot keys and their per-slot schema (caposaldo: model fills slots, code
/// owns structure).
pub(crate) fn document_content_schema(skeleton: &[DocBlockSlot]) -> Result<Value, String> {
    let mut slot_properties = Map::new();
    let mut slot_required = Vec::new();
    for slot in skeleton {
        // An unregistered block type is a pack-authoring bug (F2-T9 pack
        // content) that makes the whole document ungenerable — fail loud with
        // the offending name (mirrors assemble_doc_json) instead of silently
        // skipping the slot, which would desync assemble_doc_json's strict
        // 1:1 slot↔block expectation.
        let schema = document_block_schema(&slot.block_type).ok_or_else(|| {
            format!(
                "unregistered document block type `{}` in pack skeleton (slot `{}`)",
                slot.block_type, slot.slot_key
            )
        })?;
        slot_properties.insert(slot.slot_key.clone(), schema);
        slot_required.push(Value::String(slot.slot_key.clone()));
    }
    Ok(json!({
        "type": "object",
        "properties": {
            "title": s("Document title."),
            "slots": {
                "type": "object",
                "properties": slot_properties,
                "required": slot_required,
                "additionalProperties": false,
            },
        },
        "required": ["title", "slots"],
        "additionalProperties": false,
    }))
}

/// Reassemble the model's slot-keyed output into the ordered doc.json the
/// renderer/DOCX exporter expect: `{"title","blocks":[{"type":...,...fields}]}`.
/// A missing slot is an `Err` naming it — the caller retries or fails the whole
/// generation; we never synthesize a placeholder block (that would be content
/// the model didn't actually write, silently laundered into the deliverable).
pub(crate) fn assemble_doc_json(
    title_fallback: &str,
    skeleton: &[DocBlockSlot],
    model_output: &Value,
) -> Result<Value, String> {
    let slots = model_output.get("slots");
    let mut blocks = Vec::with_capacity(skeleton.len());
    for slot in skeleton {
        let filled = slots
            .and_then(|s| s.get(&slot.slot_key))
            .and_then(|v| v.as_object())
            .ok_or_else(|| format!("document content missing slot `{}`", slot.slot_key))?;
        // Start from the curated skeleton block so non-slot chrome (eyebrow/hero_art)
        // survives; overlay the model's content (it wins on shared keys like name/title).
        let mut block = slot.template_block.clone();
        for (k, v) in filled {
            block.insert(k.clone(), v.clone());
        }
        block.insert("type".to_string(), Value::String(slot.block_type.clone()));
        blocks.push(Value::Object(block));
    }
    let title = model_output
        .get("title")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(title_fallback)
        .to_string();
    Ok(json!({ "title": title, "blocks": blocks }))
}

/// Read a template pack's curated `example.json` (the skeleton source). Same
/// on-disk shape as deck packs (`template_packs.rs`): `<pack_root>/example.json`.
pub(crate) fn load_pack_example(entry: &TemplateCatalogEntry) -> Result<Value, String> {
    let root = entry.template_pack_root.as_ref().ok_or_else(|| {
        format!("template `{}` has no pack root (not a bundled/imported pack)", entry.id)
    })?;
    let path = root.join("example.json");
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("failed to read {}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("invalid JSON in {}: {e}", path.display()))
}

/// Extract the model's document object, tolerating a wrapper key (some
/// providers nest the answer under e.g. `{"document": {...}}` despite
/// instructions) — mirrors `extract_deck_object`'s tolerance for decks.
fn extract_document_object(v: &Value) -> Option<Value> {
    let has_slots = |o: &Value| o.get("slots").and_then(|s| s.as_object()).is_some();
    if has_slots(v) {
        return Some(v.clone());
    }
    v.as_object()?.values().find(|val| has_slots(val)).cloned()
}

/// Mirror of `generate_deck_content` for documents: strict slot-filling schema
/// first, `json_object` fallback on HTTP 400 (some providers reject
/// `json_schema`). The caller validates via `assemble_doc_json` — a malformed
/// answer never reaches the renderer.
pub(crate) async fn generate_document_content(
    http: &reqwest::Client,
    base_url: &str,
    model: &str,
    api_key: Option<&str>,
    brief: &str,
    language: &str,
    skeleton: &[DocBlockSlot],
    design_directives: &str,
) -> Result<Value, String> {
    // Same reasoning as generate_deck_content: hit the OpenAI-compat endpoint
    // DIRECTLY, not chat_endpoint() (which rewrites to Ollama's native /api/chat,
    // a different request/response shape).
    let endpoint = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let lang = if language.trim().is_empty() {
        "the SAME language as the user's brief below".to_string()
    } else {
        format!("the language with code '{}'", language.trim())
    };
    let system = format!(
        "You are a senior business writer. Fill EVERY slot of this document template in {lang}. \
         Slots are fixed — do not add, remove or reorder sections. Return ONLY the JSON object. \
         {design_directives}"
    );
    let messages = json!([
        { "role": "system", "content": system },
        { "role": "user", "content": brief },
    ]);
    // A skeleton with an unregistered block type is a pack-authoring bug —
    // surface it as this generation's error instead of crashing the gateway.
    let schema = document_content_schema(skeleton)?;
    let attempts = [
        crate::structured_response_format("homun_document", Some(&schema)),
        crate::structured_response_format("homun_document", None),
    ];
    let mut content = String::new();
    let mut last_err = "document content request failed".to_string();
    for (i, rf) in attempts.iter().enumerate() {
        let body = json!({
            "model": model,
            "temperature": 0.35,
            "messages": messages.clone(),
            "response_format": rf.clone(),
        });
        let mut req = http
            .post(endpoint.as_str())
            .timeout(std::time::Duration::from_secs(120))
            .json(&body);
        if let Some(k) = api_key {
            req = req.bearer_auth(k);
        }
        match req.send().await {
            Ok(resp) => {
                let code = resp.status().as_u16();
                if code == 400 && i == 0 {
                    continue; // endpoint rejects strict json_schema → retry json_object
                }
                if !resp.status().is_success() {
                    return Err(format!(
                        "document content HTTP {code} from model «{model}» — the inference \
                         provider rejected the request. Check it is reachable and authenticated \
                         (API key / `ollama signin`), or switch the chat model to a working one."
                    ));
                }
                let json: Value = resp
                    .json()
                    .await
                    .map_err(|e| format!("bad document content response: {e}"))?;
                content = json
                    .get("choices")
                    .and_then(|c| c.as_array())
                    .and_then(|a| a.first())
                    .and_then(|c| c.get("message"))
                    .and_then(|m| m.get("content"))
                    .and_then(|c| c.as_str())
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                if content.is_empty() {
                    let reasoning = json
                        .get("choices")
                        .and_then(|c| c.as_array())
                        .and_then(|a| a.first())
                        .and_then(|c| c.get("message"))
                        .and_then(|m| {
                            m.get("reasoning")
                                .or_else(|| m.get("reasoning_content"))
                                .or_else(|| m.get("thinking"))
                        })
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .trim();
                    last_err = if reasoning.is_empty() {
                        format!("document content model «{model}» returned an empty content field")
                    } else {
                        format!(
                            "document content model «{model}» returned reasoning-only output and \
                             no JSON content; choose a non-thinking model/provider for make_document"
                        )
                    };
                    continue;
                }
                break;
            }
            Err(e) => last_err = format!("document content provider unreachable: {e}"),
        }
    }
    if content.is_empty() {
        return Err(last_err);
    }
    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    let raw: Value = serde_json::from_str(cleaned)
        .map_err(|e| format!("document content not valid JSON: {e}"))?;
    extract_document_object(&raw).ok_or_else(|| "document content produced no slots".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn example() -> Value {
        json!({"blocks": [
            {"type": "contact_header", "name": "X"},
            {"type": "timeline", "title": "Experience"}
        ]})
    }

    #[test]
    fn skeleton_extracts_ordered_slots() {
        let skeleton = document_block_skeleton(&example());
        assert_eq!(skeleton.len(), 2);
        assert_eq!(skeleton[0].block_type, "contact_header");
        assert_eq!(skeleton[0].slot_key, "slot_0_contact_header");
        assert_eq!(skeleton[1].slot_key, "slot_1_timeline");
    }

    #[test]
    fn content_schema_is_strict_slot_filling() {
        let skeleton = document_block_skeleton(&example());
        let schema = document_content_schema(&skeleton).expect("registered types only");
        let slots = &schema["properties"]["slots"];
        assert!(slots["properties"]["slot_0_contact_header"].is_object());
        assert_eq!(slots["additionalProperties"], json!(false));
        let required: Vec<&str> = slots["required"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(required, vec!["slot_0_contact_header", "slot_1_timeline"]);
    }

    #[test]
    fn every_registered_block_type_has_a_schema() {
        for block_type in [
            "section_cover",
            "text_section",
            "letterhead",
            "letter_body",
            "signature_block",
            "cta_footer",
            "contact_header",
            "profile_summary",
            "timeline",
            "education_list",
            "skill_tags",
            "product_grid",
            "pricing_table",
            "spec_table",
            "kpi_band",
            "testimonial_quote",
        ] {
            assert!(document_block_schema(block_type).is_some(), "{block_type}");
        }
        assert!(document_block_schema("mystery").is_none());
    }

    #[test]
    fn content_schema_fails_loud_on_unregistered_block_type() {
        let skeleton = document_block_skeleton(&json!({"blocks": [
            {"type": "contact_header", "name": "X"},
            {"type": "mystery_block", "title": "?"}
        ]}));
        let err = document_content_schema(&skeleton).unwrap_err();
        assert!(err.contains("mystery_block"), "{err}");
        assert!(err.contains("slot_1_mystery_block"), "{err}");
    }

    #[test]
    fn assemble_reorders_slots_and_fails_on_missing() {
        let skeleton = document_block_skeleton(&example());
        let output = json!({"title": "Doc", "slots": {
            "slot_1_timeline": {"title": "Exp", "entries": []},
            "slot_0_contact_header": {"name": "Elena", "headline": "", "contact_items": []}
        }});
        let doc = assemble_doc_json("fallback", &skeleton, &output).unwrap();
        assert_eq!(doc["blocks"][0]["type"], "contact_header");
        assert_eq!(doc["blocks"][0]["name"], "Elena");
        assert_eq!(doc["blocks"][1]["type"], "timeline");
        let missing = json!({"title": "Doc", "slots": {}});
        assert!(assemble_doc_json("f", &skeleton, &missing).is_err());
    }

    #[test]
    fn assemble_carries_skeleton_chrome_and_lets_model_content_win() {
        // Skeleton cover block carries curated chrome (hero_art) the model never sees,
        // plus example content (name) the model overwrites.
        let example = json!({"blocks": [
            {"type": "contact_header", "name": "Jane Example", "headline": "Example",
             "eyebrow": "CURRICULUM VITAE", "contact_items": ["a@b.c"]},
            {"type": "section_cover", "title": "Example", "subtitle": "x",
             "eyebrow": "CASE STUDY", "hero_art": "gradient"}
        ]});
        let skeleton = document_block_skeleton(&example);
        let model_output = json!({"title": "Real CV", "slots": {
            "slot_0_contact_header": {"name": "Marco Rossi", "headline": "Ops Lead",
                "contact_items": ["marco@x.it"]},
            "slot_1_section_cover": {"title": "Acme × Us", "subtitle": "How we did it"}
        }});
        let doc = assemble_doc_json("fallback", &skeleton, &model_output).unwrap();
        let b = doc["blocks"].as_array().unwrap();
        // model content wins
        assert_eq!(b[0]["name"], "Marco Rossi");
        assert_eq!(b[1]["title"], "Acme × Us");
        // curated chrome carried from the skeleton (model never emitted these)
        assert_eq!(b[0]["eyebrow"], "CURRICULUM VITAE");
        assert_eq!(b[1]["eyebrow"], "CASE STUDY");
        assert_eq!(b[1]["hero_art"], "gradient");
        // contact_header has NO hero_art in the skeleton → stays absent
        assert!(b[0].get("hero_art").is_none());
        // type preserved
        assert_eq!(b[0]["type"], "contact_header");
    }
}
