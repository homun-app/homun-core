//! Deliverable tool schemas and content helpers.
//!
//! Owns artifact/deck/document tool schemas, deliverable design policy, deck and
//! document content generation helpers, quality guardrails, and Markdown/doc.json
//! to DOCX packaging. Runtime dispatch remains in `main.rs` until the artifact
//! execution boundary is extracted.

use super::*;

#[test]
fn deliverables_owner_smoke() {
    assert!(
        make_document_tool_schema()
            .to_string()
            .contains("make_document")
    );
}

/// Tool for the model to author a document/code artifact directly (no skill):
/// writes the content to the conversation's output area and surfaces it as an
/// artifact (card + workspace panel).
pub(crate) fn create_artifact_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "create_artifact",
            "description": "Create an 'artifact' file (document, code, markdown, csv, html, json, text, PDF) by writing its full content. The file appears as a downloadable and previewable artifact in the chat (File panel). Use it when the user asks to PRODUCE a document/code/PDF to deliver, instead of just pasting it in the message. PDF: if the user asks for a PDF, use a name ending in \".pdf\" and write the `content` in MARKDOWN (headings #, lists -, tables, **bold**): it gets paginated into a real PDF automatically. Do NOT try to write PDF bytes by hand.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "File name with extension, e.g. \"report.md\", \"script.py\", \"data.csv\", \"quote.pdf\"" },
                    "content": { "type": "string", "description": "COMPLETE content of the file. For .pdf: write it in Markdown (it will be rendered to PDF)." }
                },
                "required": ["name", "content"]
            }
        }
    })
}

/// Tool for the model to GENERATE an image from a prompt (photo, illustration, icon,
/// slide visual) — saved as a downloadable PNG artifact. Provider-agnostic: local Ollama
/// by default (Flux / Z-Image), or a cloud model.
/// One-call deck generation — the MAXIMUM-scaffolding tier (ADR 0016). The model
/// supplies only a brief; the ENGINE owns the whole pipeline (brand → slide
/// content via a schema-ENFORCED model call → images → render). This is what makes
/// a deck reliable even on a weak/local model: the model never orchestrates, it
/// fills exactly one slot, so it cannot balloon a plan, loop, or skip the stop.
pub(crate) fn make_deck_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "make_deck",
            "description": "Create a COMPLETE on-brand, editable presentation (.pptx + HTML/PDF preview) from a brief in ONE call. The engine does EVERYTHING deterministically — brand, slide content, images, render. Use this for ANY request to make slides / a deck / a presentation / a pitch. Do NOT plan, do NOT call get_brand_kit/generate_image/render_deck/update_plan, do NOT write files or use the shell. Just call make_deck with the brief; when it returns, the deck is DONE — give the user a one-line summary.",
            "parameters": {
                "type": "object",
                "properties": {
                    "brief": { "type": "string", "description": "What the deck is about, plus any structure, sections or points the user specified — verbatim." },
                    "language": { "type": "string", "description": "Deck language code, e.g. 'it' or 'en'. Default: the user's language." },
                    "slides": { "type": "integer", "description": "Desired number of slides (3-12). Default 6." },
                    "template_ref": { "type": "string", "description": "Optional template catalog reference selected from capability discovery, e.g. homun/startup-pitch-clean-01. It is resolved by the harness into design_* defaults; explicit design_* args override or extend it." },
                    "design_template": deliverable_design_template_schema(),
                    "design_theme": deliverable_design_theme_schema("deck"),
                    "design_profile": deliverable_design_profile_schema(),
                    "design_components": deliverable_design_components_schema()
                },
                "required": ["brief"]
            }
        }
    })
}

/// One-call document generation. The model supplies only the brief; the harness
/// owns the workflow contract and writes/registers the managed artifact.
pub(crate) fn make_document_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "make_document",
            "description": "Create a COMPLETE structured document artifact from a brief in ONE call. The engine drafts a polished Markdown document, writes it as managed Markdown/PDF/DOCX artifacts, and registers them in memory. With a bundled document template_ref, the engine instead renders the designed HTML/PDF and an editable DOCX (the formats arg does not apply on that path). Use this for requests to write/create/draft a document, report, memo, meeting minutes or relazione. Do NOT create a separate plan and do NOT call create_artifact/write_file/shell for this workflow. Just call make_document with the brief; when it returns, the document is DONE.",
            "parameters": {
                "type": "object",
                "properties": {
                    "brief": { "type": "string", "description": "What the document must contain, including any sections, audience, tone, constraints or source material the user provided — verbatim." },
                    "language": { "type": "string", "description": "Document language code, e.g. 'it' or 'en'. Default: the user's language." },
                    "name": { "type": "string", "description": "Artifact filename. If the user named the file, preserve that name exactly as a simple filename such as report.md, report.pdf or report.docx. If no name was specified, choose a concise descriptive .md filename." },
                    "template_ref": { "type": "string", "description": "Optional template catalog reference selected from capability discovery, e.g. homun/cv-professional-01. It is resolved by the harness into design_* defaults; explicit design_* args override or extend it. Templated document packs render designed HTML/PDF + editable DOCX." },
                    "document_type": {
                        "type": "string",
                        "description": "Document shape requested by the user. Preserve explicit intent; do not infer from weak hints.",
                        "enum": ["generic", "report", "memo", "brief", "proposal", "meeting_minutes"]
                    },
                    "audience": { "type": "string", "description": "Primary audience when the user names one, e.g. CEO, client, PM, engineering team." },
                    "tone": {
                        "type": "string",
                        "description": "Writing tone requested by the user. Preserve explicit intent; omit when unspecified.",
                        "enum": ["professional", "concise", "executive", "technical", "operational"]
                    },
                    "layout_profile": {
                        "type": "string",
                        "description": "Explicit document layout profile requested by the user. Preserve explicit intent; omit when unspecified.",
                        "enum": ["standard", "one_page", "executive_brief", "detailed_report", "proposal"]
                    },
                    "design_template": deliverable_design_template_schema(),
                    "design_theme": deliverable_design_theme_schema("document"),
                    "design_profile": deliverable_design_profile_schema(),
                    "design_components": deliverable_design_components_schema(),
                    "sections": {
                        "type": "array",
                        "description": "Section headings explicitly requested by the user, in order. Do not invent this list when unspecified.",
                        "items": { "type": "string" }
                    },
                    "formats": {
                        "type": "array",
                        "description": "Output formats to materialize from the same Markdown source. Use ['md'] by default, ['pdf'] when the user asks for a PDF, ['docx'] when the user asks for an editable Word file, or combine them when multiple outputs are requested.",
                        "items": { "type": "string", "enum": ["md", "pdf", "docx"] }
                    }
                },
                "required": ["brief", "name"]
            }
        }
    })
}

pub(crate) fn deliverable_design_components_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "array",
        "description": "Shared reusable deliverable components explicitly requested by the user. Applies across presentations and documents. Preserve explicit intent; omit when unspecified.",
        "items": { "type": "string", "enum": DELIVERABLE_DESIGN_COMPONENTS },
        "maxItems": 6
    })
}

pub(crate) fn deliverable_design_template_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "string",
        "description": "Shared reusable deliverable template requested by the user. Applies across presentations and documents. Expands to default profile/components; explicit profile/components override or extend it.",
        "enum": DELIVERABLE_DESIGN_TEMPLATES
    })
}

/// `medium` is "deck" or "document" — documents exclude the dark-surface
/// editorial themes (see `DARK_EDITORIAL_THEMES`) since doc_render's body
/// text/tables still assume a light surface; decks keep the full palette.
/// Filters the one shared list rather than maintaining a second enum, so the
/// two media can never silently drift apart on the other 8 theme names.
pub(crate) fn deliverable_design_theme_schema(medium: &str) -> serde_json::Value {
    let enum_values: Vec<&str> = DELIVERABLE_DESIGN_THEMES
        .iter()
        .copied()
        .filter(|theme| medium != "document" || !DARK_EDITORIAL_THEMES.contains(theme))
        .collect();
    serde_json::json!({
        "type": "string",
        "description": "Shared visual theme token explicitly requested by the user. Applies across presentations and documents. Preserve explicit intent; omit when unspecified.",
        "enum": enum_values
    })
}

pub(crate) fn deliverable_design_profile_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "string",
        "description": "Shared deliverable design profile requested by the user. Applies across presentations and documents. Preserve explicit intent; omit when unspecified.",
        "enum": DELIVERABLE_DESIGN_PROFILES
    })
}

pub(crate) const DELIVERABLE_DESIGN_PROFILES: &[&str] = &[
    "executive",
    "sales_pitch",
    "technical",
    "editorial",
    "minimal",
];

pub(crate) const DELIVERABLE_DESIGN_TEMPLATES: &[&str] = &[
    "startup_pitch",
    "executive_update",
    "project_plan",
    "technical_brief",
    "sales_proposal",
    "cv",
    "cover_letter",
    "product_catalog",
];

pub(crate) const DELIVERABLE_DESIGN_THEMES: &[&str] = &[
    "clean_corporate",
    "high_contrast",
    "warm_editorial",
    "minimal_mono",
    "soft_gradient",
    // S1a editorial themes (design_tokens.py THEMES is the canonical source of
    // truth for their surface/ink/muted/hairline/on_brand values — this
    // whitelist just has to KNOW the names, or the bundled packs' own
    // design_theme silently drops to None here and to the pack's default
    // (white surface / brand-kit colours) at real generation time, even
    // though the committed preview shows the dramatic theme. Found wiring
    // S1a-T5's pack defaults through this exact gate.
    "editorial_noir",
    "editorial_warm",
    "editorial_bold",
    "editorial_ivory",
    "editorial_slate",
];

/// The 2 editorial themes whose SURFACE is dark (design_tokens.py THEMES:
/// editorial_noir/editorial_bold paint the page itself near-black/deep-teal).
/// They read as dramatic on a fixed-canvas DECK slide but doc_render still
/// assumes a light surface for body text/tables, so a document rendered in
/// either is unreadable — restrict them out of the document-facing theme
/// enum/resolution (deck keeps all 5 editorial themes) rather than duplicate
/// the enum with a hand-maintained "document themes" list.
pub(crate) const DARK_EDITORIAL_THEMES: &[&str] = &["editorial_noir", "editorial_bold"];

pub(crate) const DELIVERABLE_DESIGN_COMPONENTS: &[&str] = &[
    "kpi_grid",
    "timeline",
    "comparison_table",
    "quote_callout",
    "process_steps",
    "risks_table",
];

pub(crate) fn deliverable_design_template(parsed: &serde_json::Value) -> Option<String> {
    parsed
        .get("design_template")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| DELIVERABLE_DESIGN_TEMPLATES.contains(&value.as_str()))
}

pub(crate) fn deliverable_template_ref(parsed: &serde_json::Value) -> Option<String> {
    parsed
        .get("template_ref")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(160).collect())
}

/// S2 T4: force the tool-call args' `template_ref` to the deterministic binding's — the
/// binding WINS, always. The user already picked this exact template via "Use template";
/// the model's own `template_ref` (correct, absent, or drifted onto a different pack across
/// the multi-turn intake) is not authoritative once a binding is active. Called BEFORE
/// `deliverable_template_ref`/`document_generation_options` parse `args` in the
/// `make_deck`/`make_document` dispatch arms, so every downstream read sees the bound ref.
/// `args` is coerced to an object if the model sent something else (defensive; tool-call
/// args are schema-validated JSON objects in practice).
pub(crate) fn merge_bound_template_ref(args: &mut serde_json::Value, template_ref: &str) {
    if !args.is_object() {
        *args = serde_json::json!({});
    }
    args["template_ref"] = serde_json::Value::String(template_ref.to_string());
}

pub(crate) fn deliverable_design_theme(parsed: &serde_json::Value) -> Option<String> {
    parsed
        .get("design_theme")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| DELIVERABLE_DESIGN_THEMES.contains(&value.as_str()))
}

pub(crate) fn deliverable_template_defaults(
    template: Option<&str>,
) -> (Option<&'static str>, Vec<&'static str>) {
    match template {
        Some("startup_pitch") => (
            Some("sales_pitch"),
            vec!["kpi_grid", "timeline", "quote_callout"],
        ),
        Some("executive_update") => (
            Some("executive"),
            vec!["kpi_grid", "risks_table", "timeline"],
        ),
        Some("project_plan") => (
            Some("technical"),
            vec!["process_steps", "timeline", "risks_table"],
        ),
        Some("technical_brief") => (
            Some("technical"),
            vec!["process_steps", "comparison_table", "risks_table"],
        ),
        Some("sales_proposal") => (
            Some("sales_pitch"),
            vec!["comparison_table", "timeline", "kpi_grid"],
        ),
        Some("cv") => (Some("minimal"), vec!["timeline"]),
        Some("cover_letter") => (Some("minimal"), Vec::new()),
        Some("product_catalog") => (Some("editorial"), vec!["comparison_table"]),
        _ => (None, Vec::new()),
    }
}

pub(crate) fn deliverable_design_components_from_value(
    value: Option<&serde_json::Value>,
) -> Vec<String> {
    value
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .map(|value| value.trim().to_ascii_lowercase())
                .filter(|value| DELIVERABLE_DESIGN_COMPONENTS.contains(&value.as_str()))
                .fold(Vec::<String>::new(), |mut acc, value| {
                    if acc.len() < 6 && !acc.iter().any(|existing| existing == &value) {
                        acc.push(value);
                    }
                    acc
                })
        })
        .unwrap_or_default()
}

pub(crate) fn deliverable_design_components(parsed: &serde_json::Value) -> Vec<String> {
    deliverable_design_components_from_value(parsed.get("design_components"))
}

#[cfg(test)]
pub(crate) fn resolved_deliverable_design_components(
    parsed: &serde_json::Value,
    template: Option<&str>,
) -> Vec<String> {
    resolved_deliverable_design_components_with_catalog(parsed, template, &[])
}

pub(crate) fn resolved_deliverable_design_components_with_catalog(
    parsed: &serde_json::Value,
    template: Option<&str>,
    catalog_components: &[String],
) -> Vec<String> {
    let (_, defaults) = deliverable_template_defaults(template);
    defaults
        .into_iter()
        .map(|value| value.to_string())
        .chain(
            catalog_components
                .iter()
                .map(|value| value.trim())
                .map(str::to_ascii_lowercase)
                .filter(|value| DELIVERABLE_DESIGN_COMPONENTS.contains(&value.as_str())),
        )
        .chain(deliverable_design_components(parsed))
        .fold(Vec::<String>::new(), |mut acc, value| {
            if acc.len() < 6 && !acc.iter().any(|existing| existing == &value) {
                acc.push(value);
            }
            acc
        })
}

pub(crate) fn deliverable_design_profile(parsed: &serde_json::Value) -> Option<String> {
    parsed
        .get("design_profile")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| DELIVERABLE_DESIGN_PROFILES.contains(&value.as_str()))
}

#[cfg(test)]
pub(crate) fn resolved_deliverable_design_profile(
    parsed: &serde_json::Value,
    template: Option<&str>,
) -> Option<String> {
    deliverable_design_profile(parsed).or_else(|| {
        let (profile, _) = deliverable_template_defaults(template);
        profile.map(String::from)
    })
}

pub(crate) fn deliverable_design_template_directive(
    template: Option<&str>,
    medium: &str,
) -> Option<String> {
    let directive = match (template, medium) {
        (Some("startup_pitch"), "deck") => {
            "Design template: startup_pitch. Shape the deliverable like an investor/customer pitch with problem, value, proof, roadmap and ask."
        }
        (Some("startup_pitch"), "document") => {
            "Design template: startup_pitch. Shape the document like a concise pitch brief with problem, value, proof, roadmap and ask."
        }
        (Some("executive_update"), "deck") => {
            "Design template: executive_update. Structure around status, metrics, risks, decisions and next steps."
        }
        (Some("executive_update"), "document") => {
            "Design template: executive_update. Structure around status, metrics, risks, decisions and next steps."
        }
        (Some("project_plan"), "deck") => {
            "Design template: project_plan. Structure around objectives, phases, responsibilities, risks and milestones."
        }
        (Some("project_plan"), "document") => {
            "Design template: project_plan. Structure around objectives, phases, responsibilities, risks and milestones."
        }
        (Some("technical_brief"), "deck") => {
            "Design template: technical_brief. Structure around architecture, constraints, tradeoffs, implementation sequence and verification."
        }
        (Some("technical_brief"), "document") => {
            "Design template: technical_brief. Structure around architecture, constraints, tradeoffs, implementation sequence and verification."
        }
        (Some("sales_proposal"), "deck") => {
            "Design template: sales_proposal. Structure around client problem, proposed solution, differentiators, timeline and next action."
        }
        (Some("sales_proposal"), "document") => {
            "Design template: sales_proposal. Structure around client problem, proposed solution, differentiators, scope, timeline and next action."
        }
        (Some("cv"), "deck") => {
            "Design template: cv. Structure it as a professional CV: profile first, reverse-chronological experience, tight factual bullets."
        }
        (Some("cv"), "document") => {
            "Design template: cv. Structure it as a professional CV: profile first, reverse-chronological experience, tight factual bullets."
        }
        (Some("cover_letter"), "deck") => {
            "Design template: cover_letter. Structure it as a focused cover letter: opening hook, why-this-role fit, concrete proof points and a confident closing ask."
        }
        (Some("cover_letter"), "document") => {
            "Design template: cover_letter. Structure it as a focused cover letter: opening hook, why-this-role fit, concrete proof points and a confident closing ask."
        }
        (Some("product_catalog"), "deck") => {
            "Design template: product_catalog. Structure it as a product catalog: category grouping, consistent per-item specs, comparison points and pricing/availability call-outs."
        }
        (Some("product_catalog"), "document") => {
            "Design template: product_catalog. Structure it as a product catalog: category grouping, consistent per-item specs, comparison points and pricing/availability call-outs."
        }
        _ => return None,
    };
    Some(directive.to_string())
}

pub(crate) fn deliverable_design_theme_directive(
    theme: Option<&str>,
    medium: &str,
) -> Option<String> {
    let directive = match (theme, medium) {
        (Some("clean_corporate"), "deck") => {
            "Design theme: clean_corporate. Use a crisp SaaS/business visual rhythm, clear whitespace, brand-led accents and calm evidence hierarchy."
        }
        (Some("clean_corporate"), "document") => {
            "Design theme: clean_corporate. Use a crisp business document style, compact sections, clear tables and calm evidence hierarchy."
        }
        (Some("high_contrast"), "deck") => {
            "Design theme: high_contrast. Use strong contrast, bold hierarchy and restrained accent colour for decision-ready emphasis."
        }
        (Some("high_contrast"), "document") => {
            "Design theme: high_contrast. Use strong hierarchy, short headings and high-signal tables with minimal decorative language."
        }
        (Some("warm_editorial"), "deck") => {
            "Design theme: warm_editorial. Use a warmer editorial rhythm, narrative pacing and human-readable section titles."
        }
        (Some("warm_editorial"), "document") => {
            "Design theme: warm_editorial. Use a warmer editorial narrative, readable transitions and polished section rhythm."
        }
        (Some("minimal_mono"), "deck") => {
            "Design theme: minimal_mono. Use sparse composition, monochrome structure and only one accent for orientation."
        }
        (Some("minimal_mono"), "document") => {
            "Design theme: minimal_mono. Use sparse structure, short paragraphs, compact tables and no ornamental prose."
        }
        (Some("soft_gradient"), "deck") => {
            "Design theme: soft_gradient. Use soft depth, restrained gradients and calm modern visual hierarchy."
        }
        (Some("soft_gradient"), "document") => {
            "Design theme: soft_gradient. Use a modern soft hierarchy, clear section grouping and concise visual tables."
        }
        // S1a editorial themes (final-review fix: these had no directive arms at
        // all, so shipped packs using them generated with no theme prose guidance).
        // One directive per theme regardless of medium — deck and document already
        // diverge on WHICH of these 5 are selectable (see DARK_EDITORIAL_THEMES /
        // deliverable_design_theme_schema); the prose itself doesn't need to.
        (Some("editorial_noir"), _) => {
            "Design theme: editorial_noir. Near-black surface, cream serif display type, a single warm-metal accent — dramatic and premium."
        }
        (Some("editorial_warm"), _) => {
            "Design theme: editorial_warm. Warm cream surface, deep terracotta accent and serif display type — inviting, tactile, human editorial warmth."
        }
        (Some("editorial_bold"), _) => {
            "Design theme: editorial_bold. Deep teal surface, crisp light serif display type and a golden accent — bold, confident, high-impact editorial energy."
        }
        (Some("editorial_ivory"), _) => {
            "Design theme: editorial_ivory. Soft ivory surface, forest-green accent and serif display type — refined, understated, quietly premium editorial calm."
        }
        (Some("editorial_slate"), _) => {
            "Design theme: editorial_slate. Pale slate-blue surface, cool blue accent and serif display type — crisp, professional, modern editorial restraint."
        }
        _ => return None,
    };
    Some(directive.to_string())
}

pub(crate) fn deliverable_design_profile_directive(
    profile: Option<&str>,
    medium: &str,
) -> Option<String> {
    let directive = match (profile, medium) {
        (Some("executive"), "deck") => {
            "Design profile: executive. Use restrained board-ready visuals, strong hierarchy, compact evidence, and decision-oriented slide titles."
        }
        (Some("executive"), "document") => {
            "Design profile: executive. Use board-ready structure, compact evidence, short sections, and decision-oriented headings."
        }
        (Some("sales_pitch"), "deck") => {
            "Design profile: sales_pitch. Lead with pain, value, proof and next action; use crisp benefit-led slide titles and persuasive pacing."
        }
        (Some("sales_pitch"), "document") => {
            "Design profile: sales_pitch. Structure around client pain, value proposition, proof, scope, timeline and next action."
        }
        (Some("technical"), "deck") => {
            "Design profile: technical. Prioritize architecture, constraints, tradeoffs, concrete metrics and implementation sequence."
        }
        (Some("technical"), "document") => {
            "Design profile: technical. Prioritize precise terminology, architecture, constraints, tradeoffs, implementation details and verification."
        }
        (Some("editorial"), "deck") => {
            "Design profile: editorial. Use narrative sequencing, magazine-like section rhythm, strong opening and memorable closing."
        }
        (Some("editorial"), "document") => {
            "Design profile: editorial. Use a polished narrative flow, strong opening, readable section rhythm and concise transitions."
        }
        (Some("minimal"), "deck") => {
            "Design profile: minimal. Use very sparse slides, short titles, few bullets, generous whitespace and no decorative complexity."
        }
        (Some("minimal"), "document") => {
            "Design profile: minimal. Use short sections, plain structure, compact tables only when needed and no decorative prose."
        }
        _ => return None,
    };
    Some(directive.to_string())
}

pub(crate) fn deliverable_design_component_directives(
    components: &[String],
    medium: &str,
) -> Vec<String> {
    components
        .iter()
        .filter_map(|component| {
            let directive = match (component.as_str(), medium) {
                ("kpi_grid", "deck") => {
                    "Component: kpi_grid. Include one KPI-focused slide with 3-5 quantified metrics and concise labels."
                }
                ("kpi_grid", "document") => {
                    "Component: kpi_grid. Include a compact KPI table with metric, value and implication."
                }
                ("timeline", "deck") => {
                    "Component: timeline. Include a timeline slide with clear phases, dates or sequence markers."
                }
                ("timeline", "document") => {
                    "Component: timeline. Include a timeline table with phase, owner/date and expected outcome."
                }
                ("comparison_table", "deck") => {
                    "Component: comparison_table. Include a comparison slide contrasting options or alternatives."
                }
                ("comparison_table", "document") => {
                    "Component: comparison_table. Include a comparison table with criteria and alternatives."
                }
                ("quote_callout", "deck") => {
                    "Component: quote_callout. Include one short quote or principle slide used as emphasis, not decoration."
                }
                ("quote_callout", "document") => {
                    "Component: quote_callout. Include one short highlighted quote or principle paragraph when supported by the brief."
                }
                ("process_steps", "deck") => {
                    "Component: process_steps. Include a process slide with 3-6 ordered steps."
                }
                ("process_steps", "document") => {
                    "Component: process_steps. Include ordered process steps with clear actions."
                }
                ("risks_table", "deck") => {
                    "Component: risks_table. Include a risk slide with risk, impact and mitigation."
                }
                ("risks_table", "document") => {
                    "Component: risks_table. Include a risk table with risk, impact, mitigation and owner when known."
                }
                _ => return None,
            };
            Some(directive.to_string())
        })
        .collect()
}

/// Strict JSON schema for the deck CONTENT the model produces. Deliberately
/// UNIFORM (cover/section/bullets/closing + a `want_image` flag) so it is valid
/// under OpenAI strict mode (every property required, additionalProperties:false)
/// AND constrains a local model via Ollama `format`/grammar. Richer layouts
/// (kpi/quote/two_column) are a later enrichment — v1 favours cross-model
/// reliability over variety.
pub(crate) fn deck_content_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["title", "subtitle", "slides"],
        "properties": {
            "title": { "type": "string" },
            "subtitle": { "type": "string" },
            "slides": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["layout", "title", "bullets", "notes", "want_image", "eyebrow"],
                    "properties": {
                        "layout": { "type": "string", "enum": ["cover", "section", "bullets", "closing"] },
                        "title": { "type": "string" },
                        "bullets": { "type": "array", "items": { "type": "string" } },
                        "notes": { "type": "string" },
                        "want_image": { "type": "boolean" },
                        "eyebrow": { "type": "string", "description": "Optional small-caps kicker above the COVER title only. Use only text grounded in the brief; never copy template placeholders. Leave \"\" when no grounded label exists and on non-cover slides." }
                    }
                }
            }
        }
    })
}

pub(crate) fn deck_brief_is_closed_world(brief: &str) -> bool {
    let normalized = brief.to_ascii_lowercase();
    [
        "usa solo questi dati",
        "usa esclusivamente questi dati",
        "non inventare",
        "use only this data",
        "use only these data",
        "do not invent",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

pub(crate) fn deck_grounding_directive(brief: &str) -> &'static str {
    if deck_brief_is_closed_world(brief) {
        "STRICT CLOSED-WORLD BRIEF: the brief is the complete evidence set. Do not add any result, status, interpretation, metric, product capability, process detail, or next step that is absent from it. A topic label is not proof of an outcome. When a requested topic has no supplied detail, keep the neutral topic label without asserting specifics."
    } else {
        "GROUNDING: do not invent factual results, metrics, customers, dates, product capabilities, or completed work that the brief does not provide."
    }
}

pub(crate) fn apply_deck_grounding_contract(deck: &mut serde_json::Value, brief: &str) {
    if !deck_brief_is_closed_world(brief) {
        return;
    }
    let Some(slides) = deck
        .get_mut("slides")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for slide in slides {
        slide["notes"] = serde_json::json!("");
    }
}

/// Pull the deck object out of a model response that may be wrapped or noisy.
/// Cloud-routed models (e.g. Ollama Cloud) ACCEPT `response_format: json_schema`
/// but do NOT actually enforce it — they wrap the deck under a key
/// (`{"presentation": {...}}`) or add extra fields. So we tolerantly find the
/// object carrying a non-empty `slides` array, at the top level or one level
/// down. This tolerant parsing — not enforcement — is the TRUE cross-model floor.
pub(crate) fn extract_deck_object(v: &serde_json::Value) -> Option<serde_json::Value> {
    let has_slides = |o: &serde_json::Value| {
        o.get("slides")
            .and_then(|s| s.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false)
    };
    if has_slides(v) {
        return Some(v.clone());
    }
    if let Some(obj) = v.as_object() {
        for val in obj.values() {
            if has_slides(val) {
                return Some(val.clone());
            }
        }
    }
    None
}

pub(crate) fn deck_slide_bullets(slide: &serde_json::Value) -> Vec<String> {
    slide
        .get("bullets")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .take(8)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn deck_notes_as_bullets(notes: &str) -> Vec<String> {
    notes
        .split(['\n', '.', '!', '?'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .take(4)
        .map(ToString::to_string)
        .collect()
}

/// Some OpenAI-compatible providers accept the JSON schema request but omit
/// required empty-array fields. Preserve their authored content by promoting
/// speaker notes into visible bullets when a substantive slide has no bullets.
/// A genuinely empty slide remains empty and is rejected by the semantic gate.
pub(crate) fn normalize_deck_model_content(deck: &mut serde_json::Value) {
    let deck_title = deck
        .get("title")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let deck_subtitle = deck
        .get("subtitle")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let Some(slides) = deck
        .get_mut("slides")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    if let (Some(title), Some(cover)) = (deck_title, slides.first_mut())
        && cover.get("layout").and_then(serde_json::Value::as_str) == Some("cover")
    {
        let prior_title = cover
            .get("title")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty() && *value != title)
            .map(ToString::to_string);
        cover["title"] = serde_json::json!(title);
        let subtitle_is_empty = cover
            .get("subtitle")
            .and_then(serde_json::Value::as_str)
            .is_none_or(|value| value.trim().is_empty());
        if subtitle_is_empty && let Some(subtitle) = deck_subtitle.or(prior_title) {
            cover["subtitle"] = serde_json::json!(subtitle);
        }
    }
    for slide in slides {
        let layout = slide
            .get("layout")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("bullets");
        if matches!(layout, "cover" | "section" | "closing")
            || !deck_slide_bullets(slide).is_empty()
        {
            continue;
        }
        let bullets = slide
            .get("notes")
            .and_then(serde_json::Value::as_str)
            .map(deck_notes_as_bullets)
            .unwrap_or_default();
        if !bullets.is_empty() {
            slide["bullets"] = serde_json::json!(bullets);
        }
    }
}

pub(crate) fn deck_component_target_indices(deck: &serde_json::Value) -> Vec<usize> {
    deck.get("slides")
        .and_then(|value| value.as_array())
        .map(|slides| {
            slides
                .iter()
                .enumerate()
                .filter_map(|(index, slide)| {
                    let layout = slide
                        .get("layout")
                        .and_then(|value| value.as_str())
                        .unwrap_or("bullets");
                    if matches!(layout, "cover" | "closing" | "section") {
                        None
                    } else {
                        Some(index)
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn split_component_bullets(
    bullets: &[String],
    left_fallback: &str,
    right_fallback: &str,
) -> (Vec<String>, Vec<String>) {
    let mut left = Vec::new();
    let mut right = Vec::new();
    for (index, bullet) in bullets.iter().enumerate() {
        if index % 2 == 0 {
            left.push(bullet.clone());
        } else {
            right.push(bullet.clone());
        }
    }
    if left.is_empty() {
        left.push(left_fallback.to_string());
    }
    if right.is_empty() {
        right.push(right_fallback.to_string());
    }
    (left, right)
}

pub(crate) fn apply_deck_design_components(deck: &mut serde_json::Value, components: &[String]) {
    let target_indices = deck_component_target_indices(deck);
    if target_indices.is_empty() {
        return;
    }
    let Some(slides) = deck
        .get_mut("slides")
        .and_then(|value| value.as_array_mut())
    else {
        return;
    };
    for (target_cursor, component) in components.iter().take(target_indices.len()).enumerate() {
        let index = target_indices[target_cursor];
        let Some(slide) = slides.get_mut(index) else {
            continue;
        };
        let bullets = deck_slide_bullets(slide);
        match component.as_str() {
            "kpi_grid" => {
                let kpi = bullets
                    .iter()
                    .find(|bullet| bullet.chars().any(|char| char.is_ascii_digit()))
                    .cloned();
                let Some(kpi) = kpi else {
                    continue;
                };
                let label = slide
                    .get("title")
                    .and_then(|value| value.as_str())
                    .unwrap_or("Key metric")
                    .to_string();
                slide["layout"] = serde_json::json!("kpi");
                slide["kpi"] = serde_json::json!(kpi);
                slide["kpi_label"] = serde_json::json!(label);
                slide["want_image"] = serde_json::json!(false);
            }
            "quote_callout" => {
                let quote = slide
                    .get("body")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .or_else(|| bullets.first().cloned());
                let Some(quote) = quote else {
                    continue;
                };
                slide["layout"] = serde_json::json!("quote");
                slide["quote"] = serde_json::json!(quote);
                slide["author"] = serde_json::json!("");
                slide["want_image"] = serde_json::json!(false);
            }
            "timeline" => {
                if bullets.len() < 2 {
                    continue;
                }
                let (left, right) =
                    split_component_bullets(&bullets, "Current phase", "Next phase");
                slide["layout"] = serde_json::json!("two_column");
                slide["columns"] = serde_json::json!([
                    { "title": "Now", "bullets": left },
                    { "title": "Next", "bullets": right },
                ]);
                slide["want_image"] = serde_json::json!(false);
            }
            "comparison_table" => {
                if bullets.len() < 2 {
                    continue;
                }
                let (left, right) = split_component_bullets(&bullets, "Option A", "Option B");
                slide["layout"] = serde_json::json!("two_column");
                slide["columns"] = serde_json::json!([
                    { "title": "Option A", "bullets": left },
                    { "title": "Option B", "bullets": right },
                ]);
                slide["want_image"] = serde_json::json!(false);
            }
            "process_steps" => {
                if bullets.len() < 2 {
                    continue;
                }
                let midpoint = bullets.len().max(2).div_ceil(2);
                let first = bullets.iter().take(midpoint).cloned().collect::<Vec<_>>();
                let second = bullets.iter().skip(midpoint).cloned().collect::<Vec<_>>();
                slide["layout"] = serde_json::json!("two_column");
                slide["columns"] = serde_json::json!([
                    { "title": "Steps", "bullets": if first.is_empty() { vec!["Step 1".to_string()] } else { first } },
                    { "title": "Outcomes", "bullets": if second.is_empty() { vec!["Expected outcome".to_string()] } else { second } },
                ]);
                slide["want_image"] = serde_json::json!(false);
            }
            "risks_table" => {
                if bullets.len() < 2 {
                    continue;
                }
                let (left, right) = split_component_bullets(&bullets, "Risk", "Mitigation");
                slide["layout"] = serde_json::json!("two_column");
                slide["columns"] = serde_json::json!([
                    { "title": "Risks", "bullets": left },
                    { "title": "Mitigations", "bullets": right },
                ]);
                slide["want_image"] = serde_json::json!(false);
            }
            _ => {}
        }
    }
}

pub(crate) fn design_theme_tokens(theme: Option<&str>, brand: &BrandKit) -> serde_json::Value {
    // S1a editorial themes: values MUST match runtimes/contained-computer/design_tokens.py's
    // THEMES dict (the canonical source deck_render.py resolves from) — keep the two in sync.
    let (primary, secondary, accent, heading_font, body_font) = match theme {
        Some("high_contrast") => ("#111827", "#000000", "#f59e0b", "Inter", "Inter"),
        Some("warm_editorial") => ("#7c2d12", "#431407", "#f97316", "Source Serif 4", "Inter"),
        Some("minimal_mono") => ("#111827", "#374151", "#6b7280", "Inter", "Inter"),
        Some("soft_gradient") => ("#0f766e", "#164e63", "#14b8a6", "Inter", "Inter"),
        Some("editorial_noir") => ("#c9a54e", "#1a1a1e", "#c9a54e", "Playfair Display", "Inter"),
        Some("editorial_warm") => ("#8a3b1e", "#e7ddcb", "#c46a3a", "Source Serif 4", "Inter"),
        Some("editorial_bold") => ("#2f9d95", "#0a2a2b", "#f2c14e", "Playfair Display", "Inter"),
        Some("editorial_ivory") => ("#1f4d3f", "#e9e3d6", "#1f4d3f", "Source Serif 4", "Inter"),
        Some("editorial_slate") => ("#1f4d6b", "#e6ebf0", "#1f4d6b", "Source Serif 4", "Inter"),
        Some("clean_corporate") | None | Some(_) => (
            brand.primary_color.as_str(),
            brand.secondary_color.as_str(),
            brand.accent_color.as_str(),
            brand.heading_font.as_str(),
            brand.body_font.as_str(),
        ),
    };
    serde_json::json!({
        // "name" lets deck_render.py resolve the FULL editorial token set
        // (surface/ink/muted/hairline/on_brand via design_tokens.THEMES) —
        // without it, a bundled pack's editorial_* theme silently rendered on
        // deck_render's plain white default surface at real generation time,
        // even though the committed preview (built straight from example.json
        // with "theme":{"name":...}) showed the dramatic surface. The
        // primary/secondary/accent below still win as explicit overrides for
        // the pre-existing 5 themes (theme_values() merges truthy overrides
        // onto the name-resolved base), so their look is unchanged.
        "name": theme,
        "organization": brand.organization,
        "primary": primary,
        "secondary": secondary,
        "accent": accent,
        "heading_font": heading_font,
        "body_font": body_font,
    })
}

pub(crate) fn apply_deck_design_theme(
    deck: &mut serde_json::Value,
    theme: Option<&str>,
    brand: &BrandKit,
) {
    if theme.is_none() {
        return;
    }
    deck["theme"] = design_theme_tokens(theme, brand);
}

pub(crate) fn clip_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    let mut clipped = value
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>();
    clipped.push('…');
    clipped
}

pub(crate) fn deck_text_fingerprint(value: &str) -> String {
    value
        .split_whitespace()
        .map(|word| {
            word.chars()
                .filter(|ch| ch.is_alphanumeric())
                .flat_map(|ch| ch.to_lowercase())
                .collect::<String>()
        })
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn deck_bullets_have_duplicate_or_redundant_text(
    title_key: &str,
    bullets: &[serde_json::Value],
) -> bool {
    let mut seen = HashSet::new();
    for bullet in bullets {
        let Some(text) = bullet.as_str() else {
            continue;
        };
        let key = deck_text_fingerprint(text);
        if key.is_empty() {
            continue;
        }
        if !title_key.is_empty() && key == title_key {
            return true;
        }
        if !seen.insert(key) {
            return true;
        }
    }
    false
}

pub(crate) fn normalize_deck_bullets(title_key: &str, bullets: &mut Vec<serde_json::Value>) {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for bullet in bullets.iter() {
        let Some(text) = bullet
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let key = deck_text_fingerprint(text);
        if key.is_empty() || (!title_key.is_empty() && key == title_key) || !seen.insert(key) {
            continue;
        }
        normalized.push(serde_json::json!(clip_chars(text, 150)));
        if normalized.len() >= 4 {
            break;
        }
    }
    *bullets = normalized;
}

pub(crate) fn deck_quality_guardrail_issues(deck: &serde_json::Value) -> Vec<String> {
    let mut issues = Vec::new();
    let Some(slides) = deck.get("slides").and_then(|value| value.as_array()) else {
        return issues;
    };
    for (index, slide) in slides.iter().enumerate() {
        let slide_no = index + 1;
        let title_len = slide
            .get("title")
            .and_then(|value| value.as_str())
            .map(|value| value.chars().count())
            .unwrap_or(0);
        if title_len > 72 {
            issues.push(format!("slide {slide_no}: title exceeds 72 chars"));
        }
        let bullet_count = slide
            .get("bullets")
            .and_then(|value| value.as_array())
            .map(|values| values.len())
            .unwrap_or(0);
        if bullet_count > 4 {
            issues.push(format!("slide {slide_no}: more than 4 bullets"));
        }
        if let Some(bullets) = slide.get("bullets").and_then(|value| value.as_array()) {
            let title_key = slide
                .get("title")
                .and_then(|value| value.as_str())
                .map(deck_text_fingerprint)
                .unwrap_or_default();
            if deck_bullets_have_duplicate_or_redundant_text(&title_key, bullets) {
                issues.push(format!("slide {slide_no}: duplicate/redundant bullet text"));
            }
            for (bullet_index, bullet) in bullets.iter().enumerate() {
                let len = bullet
                    .as_str()
                    .map(|value| value.chars().count())
                    .unwrap_or(0);
                if len > 150 {
                    issues.push(format!(
                        "slide {slide_no}: bullet {} exceeds 150 chars",
                        bullet_index + 1
                    ));
                }
            }
        }
    }
    issues
}

pub(crate) fn apply_deck_quality_guardrails(deck: &mut serde_json::Value) -> Vec<String> {
    let issues = deck_quality_guardrail_issues(deck);
    let Some(slides) = deck
        .get_mut("slides")
        .and_then(|value| value.as_array_mut())
    else {
        return issues;
    };
    for slide in slides {
        if let Some(title) = slide.get("title").and_then(|value| value.as_str()) {
            slide["title"] = serde_json::json!(clip_chars(title, 72));
        }
        let title_key = slide
            .get("title")
            .and_then(|value| value.as_str())
            .map(deck_text_fingerprint)
            .unwrap_or_default();
        if let Some(bullets) = slide
            .get_mut("bullets")
            .and_then(|value| value.as_array_mut())
        {
            normalize_deck_bullets(&title_key, bullets);
        }
    }
    issues
}

pub(crate) fn deck_semantic_quality_errors(deck: &serde_json::Value) -> Vec<String> {
    let Some(slides) = deck.get("slides").and_then(serde_json::Value::as_array) else {
        return vec!["deck has no slides".to_string()];
    };
    let placeholders = [
        "option a",
        "option b",
        "step 1",
        "expected outcome",
        "current phase",
        "next phase",
        "key metric",
    ];
    let mut errors = Vec::new();
    for (index, slide) in slides.iter().enumerate() {
        let serialized = serde_json::to_string(slide)
            .unwrap_or_default()
            .to_ascii_lowercase();
        for placeholder in placeholders {
            if serialized.contains(&format!("\"{placeholder}\"")) {
                errors.push(format!(
                    "slide {} contains placeholder `{placeholder}`",
                    index + 1
                ));
            }
        }
        let layout = slide
            .get("layout")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("bullets");
        if matches!(layout, "cover" | "section") {
            continue;
        }
        let has_content = match layout {
            "closing" => {
                !deck_slide_bullets(slide).is_empty()
                    || slide
                        .get("title")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty())
            }
            "bullets" | "image_right" => !deck_slide_bullets(slide).is_empty(),
            "kpi" => slide
                .get("kpi")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.trim().is_empty()),
            "quote" => slide
                .get("quote")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.trim().is_empty()),
            "two_column" => slide
                .get("columns")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|columns| {
                    columns
                        .iter()
                        .any(|column| !deck_slide_bullets(column).is_empty())
                }),
            "timeline" => slide
                .get("items")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|items| !items.is_empty()),
            "comparison" => slide
                .get("rows")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|rows| !rows.is_empty()),
            "team_grid" => slide
                .get("members")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|members| !members.is_empty()),
            _ => !deck_slide_bullets(slide).is_empty(),
        };
        if !has_content {
            errors.push(format!(
                "slide {} has no substantive content for layout `{layout}`",
                index + 1
            ));
        }
    }
    errors
}

pub(crate) fn rendered_deck_qa_result(render_output: &str) -> Option<serde_json::Value> {
    render_output.lines().find_map(|line| {
        line.strip_prefix("DECK_QA_JSON:")
            .and_then(|json| serde_json::from_str::<serde_json::Value>(json.trim()).ok())
    })
}

pub(crate) fn rendered_deck_qa_failure(render_output: &str) -> Option<String> {
    let qa = rendered_deck_qa_result(render_output)?;
    if qa
        .get("ok")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        return None;
    }
    let issues = qa
        .get("issues")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|issue| {
                    let message = issue
                        .get("message")
                        .and_then(|value| value.as_str())
                        .map(ToString::to_string)?;
                    let code = issue
                        .get("code")
                        .and_then(|value| value.as_str())
                        .unwrap_or("qa_issue");
                    Some(format!("{code}: {message}"))
                })
                .take(5)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if issues.is_empty() {
        Some("rendered deck QA failed without details".to_string())
    } else {
        Some(format!("rendered deck QA failed: {}", issues.join("; ")))
    }
}

pub(crate) fn deck_quality_metadata_from_qa_result(
    qa: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    let qa = qa?;
    let status = if qa
        .get("ok")
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
    {
        "passed"
    } else {
        "warning"
    };
    let mut metadata = serde_json::Map::new();
    metadata.insert("quality_status".to_string(), serde_json::json!(status));
    if let Some(slide_count) = qa.get("slide_count").and_then(|value| value.as_u64()) {
        metadata.insert(
            "quality_slide_count".to_string(),
            serde_json::json!(slide_count),
        );
    }
    let issues = qa
        .get("issues")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|issue| {
                    let message = issue.get("message").and_then(|value| value.as_str())?;
                    let code = issue
                        .get("code")
                        .and_then(|value| value.as_str())
                        .unwrap_or("qa_issue");
                    let severity = issue
                        .get("severity")
                        .and_then(|value| value.as_str())
                        .unwrap_or("warning");
                    Some(serde_json::json!({
                        "severity": severity,
                        "code": code,
                        "message": message,
                    }))
                })
                .take(10)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !issues.is_empty() {
        metadata.insert(
            "quality_issues".to_string(),
            serde_json::Value::Array(issues),
        );
    }
    Some(serde_json::Value::Object(metadata))
}

pub(crate) fn deck_template_metadata(template: Option<&TemplateCatalogEntry>) -> serde_json::Value {
    let Some(template) = template else {
        return serde_json::json!({});
    };
    serde_json::json!({
        "template_ref": template.id,
        "template_provider": template.provider,
        "template_source_provider": template.source_provider,
        "template_source_ref": template.source_ref,
        "template_license": template.license,
        "template_attribution_required": template.attribution_required,
        "template_attribution_text": template.attribution_text,
        "template_redistribution_policy": template.redistribution_policy,
    })
}

pub(crate) fn merge_object_metadata(
    target: &mut serde_json::Value,
    extra: Option<&serde_json::Value>,
) {
    let Some(extra) = extra.and_then(|value| value.as_object()) else {
        return;
    };
    let Some(target) = target.as_object_mut() else {
        return;
    };
    for (key, value) in extra {
        target.insert(key.clone(), value.clone());
    }
}

/// Discriminator for `make_document`'s templated path (F2-T8): a template_ref
/// only qualifies when it resolves to a BUNDLED document pack with a pack root
/// on disk — i.e. `document_content::load_pack_example` can actually read
/// example.json. A presentation pack, an imported (non-bundled) pack, or no
/// template at all must fall through to the existing markdown path; never
/// guessed from partial data (a bundled flag without a pack root, say).
pub(crate) fn document_template_pack(
    entry: Option<&TemplateCatalogEntry>,
) -> Option<&TemplateCatalogEntry> {
    let entry = entry?;
    (entry.kind == "document" && entry.bundled && entry.template_pack_root.is_some())
        .then_some(entry)
}

/// Deck analogue of `document_template_pack`: a template_ref qualifies for chrome
/// overlay only when it resolves to a BUNDLED presentation pack with a pack root
/// on disk (so `load_pack_example` can read example.json). Imported/non-bundled or
/// no template → no overlay (fail-open, identical to today).
pub(crate) fn deck_template_pack(
    entry: Option<&TemplateCatalogEntry>,
) -> Option<&TemplateCatalogEntry> {
    let entry = entry?;
    (entry.kind == "presentation" && entry.bundled && entry.template_pack_root.is_some())
        .then_some(entry)
}

/// Carry the pack's non-textual editorial chrome onto the model-generated deck.
/// Template examples are visual references, never a source of user-visible text:
/// an eyebrow must come from generated content grounded in the brief. Fail-open:
/// a missing slides array or absent chrome leaves the deck untouched.
pub(crate) fn apply_deck_template_chrome(
    deck: &mut serde_json::Value,
    example: &serde_json::Value,
) {
    let pack_slides = example.get("slides").and_then(|s| s.as_array());
    let Some(pack_slides) = pack_slides else {
        return;
    };
    let pack_for = |layout: &str| -> Option<&serde_json::Value> {
        pack_slides
            .iter()
            .find(|s| s.get("layout").and_then(|l| l.as_str()) == Some(layout))
    };
    let pack_cover = pack_for("cover");
    let pack_section = pack_for("section");
    let Some(slides) = deck.get_mut("slides").and_then(|s| s.as_array_mut()) else {
        return;
    };
    for slide in slides.iter_mut() {
        let layout = slide.get("layout").and_then(|l| l.as_str()).unwrap_or("");
        let pack = match layout {
            "cover" => pack_cover,
            "section" => pack_section,
            _ => None,
        };
        let Some(pack) = pack else { continue };
        // hero_art: deterministic — always from the pack.
        if let Some(art) = pack.get("hero_art").cloned() {
            slide["hero_art"] = art;
        }
    }
}

/// Container-relative render command for a templated document — same shape as
/// the deck command (cd into the bind-mounted output dir, render, headless
/// Chromium to PDF, QA-gate on the SAME `DECK_QA_JSON:` prefix so the existing
/// parser (`rendered_deck_qa_result`/`_failure`) converges across deck and
/// document, non-zero QA exit propagates as the command's exit code).
pub(crate) fn build_document_render_command(container_out: &str, stem: &str) -> String {
    format!(
        "cd '{container_out}' && doc-render {stem}.json --prefix {stem} && \\\n chromium --headless --no-sandbox --disable-gpu --print-to-pdf={stem}.pdf {stem}.html >/dev/null 2>&1 && \\\n qa=$(deck-qa {stem}.html --json --mode document 2>&1); qa_code=$?; \\\n echo \"DECK_QA_JSON:$qa\"; \\\n if [ \"$qa_code\" -ne 0 ]; then exit \"$qa_code\"; fi; \\\n ls -la {stem}.html {stem}.pdf 2>&1"
    )
}

/// Produce the deck CONTENT as schema-enforced JSON. Uses the orchestrator-role
/// endpoint with `response_format: json_schema` (constrained decoding — the
/// cross-model floor), degrading ONCE to `json_object` on a 400 (e.g.
/// ollama.com/v1). The floor shapes come from the single inference-crate
/// definition (`structured_response_format`, caposaldo #5 / ADR 0016); only the
/// async transport + degrade control-flow live here (they differ from the
/// blocking provider: system+user messages, richer empty/reasoning-only handling).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn generate_deck_content(
    http: &reqwest::Client,
    base_url: &str,
    model: &str,
    api_key: Option<&str>,
    brief: &str,
    brand: &BrandKit,
    slides: usize,
    language: &str,
    design_template: Option<&str>,
    design_theme: Option<&str>,
    design_profile: Option<&str>,
    design_components: &[String],
) -> Result<serde_json::Value, String> {
    // Use the CURRENT turn's model (what the chat is actually running), NOT a
    // fresh orchestrator-role resolution. Hit the OpenAI-compat endpoint DIRECTLY
    // ({base}/chat/completions) — NOT chat_endpoint(), which rewrites an Ollama
    // base to the NATIVE /api/chat (a different request+response shape: it wants
    // `format` not `response_format`, and returns `message.content` not
    // `choices[].message.content`). We build an OpenAI-compat body + parse
    // `choices[0]`, so we MUST hit the OpenAI-compat endpoint (this is exactly the
    // path the deck-content eval validates, 5/5 on gemma).
    // Robust, model-independent language: if the caller didn't pass one, tell the
    // model to MATCH the brief's language (the brief is always present and in the
    // user's language) instead of a vague "the user's language" that defaults to
    // English. Fixes Italian requests coming back as an English deck.
    let lang = if language.trim().is_empty() {
        "the SAME language as the user's brief below".to_string()
    } else {
        format!("the language with code '{}'", language.trim())
    };
    let org = if brand.organization.trim().is_empty() {
        "the organization"
    } else {
        brand.organization.trim()
    };
    let design_directive =
        deliverable_design_profile_directive(design_profile, "deck").unwrap_or_default();
    let template_directive =
        deliverable_design_template_directive(design_template, "deck").unwrap_or_default();
    let theme_directive =
        deliverable_design_theme_directive(design_theme, "deck").unwrap_or_default();
    let component_directives =
        deliverable_design_component_directives(design_components, "deck").join(" ");
    let grounding_directive = deck_grounding_directive(brief);
    let notes_directive = if deck_brief_is_closed_world(brief) {
        "Set `notes` to an empty string on every slide."
    } else {
        "Write speaker `notes` for the substantive slides."
    };
    let system = format!(
        "You are a senior presentation designer. Output ONLY JSON matching the schema. \
Design a tight, on-brand deck of EXACTLY {slides} slides in {lang}. Every slide object MUST contain \
exactly these keys: layout, title, bullets, notes, want_image, eyebrow. `bullets` MUST be a JSON array; \
for every slide except cover and section it MUST contain 1-4 non-empty strings. Never leave visible \
slide content only in `notes`. Rules: the FIRST slide layout \
must be \"cover\" and the LAST \"closing\"; use \"section\" only as an occasional divider; every \
other slide is \"bullets\". Leave `eyebrow` empty unless the user's brief explicitly supplies or implies a grounded label. Headline titles of at most 6 words. At most 4 bullets per slide, \
numbers over adjectives, one idea per slide. {notes_directive} \
Set want_image=true on the cover and on AT MOST two of the most visual slides (false on the rest). \
{grounding_directive} \
{design_directive} \
{template_directive} \
{theme_directive} \
{component_directives} \
Brand: organization «{org}», accent colour {accent}. Do NOT output colours, fonts, logos or file \
names — textual content only. Return a JSON object with EXACTLY these top-level keys: \"title\" \
(string), \"subtitle\" (string) and \"slides\" (array of slide objects). Do NOT wrap them under \
any other key such as \"presentation\" or \"deck\", and add no extra top-level keys.",
        accent = brand.accent_color,
    );
    let messages = serde_json::json!([
        { "role": "system", "content": system },
        { "role": "user", "content": brief },
    ]);
    let attempts = [
        structured_response_format("deck", Some(&deck_content_schema())),
        structured_response_format("deck", None),
    ];
    let mut usage = local_first_inference_usage::UsageContext::new(
        uuid::Uuid::new_v4().to_string(),
        local_first_inference_usage::InferencePurpose::ArtifactGeneration,
        gateway_user_id().as_str(),
    );
    usage.purpose_detail = Some("deck_content".to_string());
    usage.workspace_id = Some(gateway_workspace_id().as_str().to_string());
    let mut content = String::new();
    let mut last_err = "deck content request failed".to_string();
    for (i, rf) in attempts.iter().enumerate() {
        let body = serde_json::json!({
            "model": model,
            "temperature": 0.4,
            "messages": messages.clone(),
            "response_format": rf.clone(),
        });
        match inference_transport::send_openai_json(
            http,
            global_usage_recorder(),
            &usage,
            &inference_provider_id(base_url),
            model,
            inference_locality(base_url),
            base_url,
            api_key,
            &body,
            Some(std::time::Duration::from_secs(120)),
            system.chars().count().saturating_add(brief.chars().count()),
        )
        .await
        {
            Ok(resp) => {
                let code = resp.status;
                if code == 400 && i == 0 {
                    continue; // endpoint rejects strict json_schema → retry json_object
                }
                if !(200..300).contains(&code) {
                    return Err(format!(
                        "deck content HTTP {code} from model «{model}» — the inference provider \
                         rejected the request. Check it is reachable and authenticated (API key / \
                         `ollama signin`), or switch the chat model to a working one."
                    ));
                }
                let json = resp.body;
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
                        format!("deck content model «{model}» returned an empty content field")
                    } else {
                        format!(
                            "deck content model «{model}» returned reasoning-only output and no JSON content; choose a non-thinking model/provider for make_deck"
                        )
                    };
                    continue;
                }
                break;
            }
            Err(e) => last_err = format!("deck content provider unreachable: {e}"),
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
    let raw: serde_json::Value =
        serde_json::from_str(cleaned).map_err(|e| format!("deck content not valid JSON: {e}"))?;
    let deck =
        extract_deck_object(&raw).ok_or_else(|| "deck content produced no slides".to_string())?;
    // Rebuild a CLEAN deck with only the keys the renderer needs, deriving a
    // title when the model omitted one (the cover uses it). Strips any stray
    // wrapper/extra keys the model added (brand/accent_color/…).
    let slides = deck
        .get("slides")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let title = deck
        .get("title")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| {
            deck.get("slides")
                .and_then(|s| s.as_array())
                .and_then(|a| a.first())
                .and_then(|s0| s0.get("title"))
                .and_then(|t| t.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| brief.chars().take(60).collect::<String>());
    let subtitle = deck
        .get("subtitle")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    Ok(serde_json::json!({ "title": title, "subtitle": subtitle, "slides": slides }))
}

pub(crate) fn enforce_deck_slide_count(
    deck: &mut serde_json::Value,
    expected: usize,
) -> Result<(), String> {
    let slides = deck
        .get_mut("slides")
        .and_then(serde_json::Value::as_array_mut)
        .ok_or_else(|| "deck content produced no slides".to_string())?;
    if slides.len() != expected {
        return Err(format!(
            "deck content produced {} slides instead of the requested {expected}",
            slides.len()
        ));
    }
    Ok(())
}

pub(crate) fn make_deck_content_failure_message(
    error: &str,
    requested_template_ref: Option<&str>,
    resolved_template_ref: Option<&str>,
    base_url: &str,
    model: &str,
) -> String {
    let template_status = match (requested_template_ref, resolved_template_ref) {
        (Some(requested), Some(resolved)) => format!(
            "Template reference `{requested}` was resolved locally as `{resolved}` from Homun's built-in template catalog; it does NOT require a Monet MCP connection."
        ),
        (Some(requested), None) => format!(
            "Template reference `{requested}` is not present in Homun's local template catalog, so the workflow fell back to explicit/default design settings; this is still NOT a Monet MCP lookup."
        ),
        (None, _) => "No external template lookup was needed; the workflow uses Homun's local design defaults.".to_string(),
    };
    format!(
        "MAKE_DECK_CONTENT_PROVIDER_UNAVAILABLE: make_deck could not generate slide content because the inference provider is unreachable. {template_status} Provider endpoint: `{base_url}`. Model: `{model}`. Error: {error}. Do not create files manually and do not use shell/filesystem/MCP fallback. Ask the user to choose a reachable provider or start the required local service, then retry make_deck."
    )
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct DocumentGenerationOptions {
    pub(crate) template_ref: Option<String>,
    pub(crate) document_type: Option<String>,
    pub(crate) audience: Option<String>,
    pub(crate) tone: Option<String>,
    pub(crate) layout_profile: Option<String>,
    pub(crate) design_template: Option<String>,
    pub(crate) design_theme: Option<String>,
    pub(crate) design_profile: Option<String>,
    pub(crate) design_components: Vec<String>,
    pub(crate) sections: Vec<String>,
}

pub(crate) fn clean_document_option(value: &str) -> Option<String> {
    let cleaned = value.trim();
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.chars().take(120).collect())
    }
}

pub(crate) fn document_generation_options(parsed: &serde_json::Value) -> DocumentGenerationOptions {
    let allowed_types = [
        "generic",
        "report",
        "memo",
        "brief",
        "proposal",
        "meeting_minutes",
    ];
    let allowed_tones = [
        "professional",
        "concise",
        "executive",
        "technical",
        "operational",
    ];
    let allowed_layout_profiles = [
        "standard",
        "one_page",
        "executive_brief",
        "detailed_report",
        "proposal",
    ];
    let document_type = parsed
        .get("document_type")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| allowed_types.contains(&value.as_str()));
    let tone = parsed
        .get("tone")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| allowed_tones.contains(&value.as_str()));
    let layout_profile = parsed
        .get("layout_profile")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| allowed_layout_profiles.contains(&value.as_str()));
    let requested_template_ref = deliverable_template_ref(parsed);
    let catalog_template = template_catalog_by_id(requested_template_ref.as_deref());
    let template_ref = catalog_template.as_ref().map(|entry| entry.id.clone());
    let design_template = deliverable_design_template(parsed).or_else(|| {
        catalog_template
            .as_ref()
            .map(|entry| entry.design_template.clone())
    });
    let design_theme = deliverable_design_theme(parsed)
        .or_else(|| {
            catalog_template
                .as_ref()
                .and_then(|entry| entry.design_theme.clone())
        })
        // Belt-and-suspenders: the make_document tool schema already excludes
        // the dark editorial themes (see `deliverable_design_theme_schema`),
        // but a dark theme could still arrive via template_ref resolution or
        // a client that doesn't honour the enum — drop to no theme (the
        // pack's/renderer's light default) rather than render an unreadable
        // dark-surface document.
        .filter(|theme| !DARK_EDITORIAL_THEMES.contains(&theme.as_str()));
    let design_profile = deliverable_design_profile(parsed)
        .or_else(|| {
            catalog_template
                .as_ref()
                .and_then(|entry| entry.design_profile.clone())
        })
        .or_else(|| {
            let (profile, _) = deliverable_template_defaults(design_template.as_deref());
            profile.map(String::from)
        });
    let design_components = resolved_deliverable_design_components_with_catalog(
        parsed,
        design_template.as_deref(),
        catalog_template
            .as_ref()
            .map(|entry| entry.design_components.as_slice())
            .unwrap_or(&[]),
    );
    let audience = parsed
        .get("audience")
        .and_then(|value| value.as_str())
        .and_then(clean_document_option);
    let sections = parsed
        .get("sections")
        .and_then(|value| value.as_array())
        .map(|values| {
            values
                .iter()
                .filter_map(|value| value.as_str())
                .filter_map(clean_document_option)
                .take(12)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    DocumentGenerationOptions {
        template_ref,
        document_type,
        audience,
        tone,
        layout_profile,
        design_template,
        design_theme,
        design_profile,
        design_components,
        sections,
    }
}

pub(crate) fn document_generation_directives(options: &DocumentGenerationOptions) -> String {
    let mut directives = Vec::new();
    if let Some(template_ref) = options.template_ref.as_deref() {
        directives.push(format!("Template reference: {template_ref}."));
    }
    if let Some(document_type) = options.document_type.as_deref()
        && document_type != "generic"
    {
        directives.push(format!("Document type: {document_type}."));
    }
    if let Some(audience) = options.audience.as_deref() {
        directives.push(format!("Audience: {audience}."));
    }
    if let Some(tone) = options.tone.as_deref() {
        directives.push(format!("Tone: {tone}."));
    }
    match options.layout_profile.as_deref() {
        Some("one_page") => directives.push(
            "Layout profile: one_page. Keep the document to one concise page, with short paragraphs and one compact table at most.".to_string(),
        ),
        Some("executive_brief") => directives.push(
            "Layout profile: executive_brief. Lead with an executive summary, use decision-ready headings, and keep each section compact.".to_string(),
        ),
        Some("detailed_report") => directives.push(
            "Layout profile: detailed_report. Include deeper analysis, evidence-oriented subsections, and tables where useful.".to_string(),
        ),
        Some("proposal") => directives.push(
            "Layout profile: proposal. Structure around client problem, proposed solution, value, scope, timeline, and next action.".to_string(),
        ),
        Some("standard") | None => {}
        Some(_) => {}
    }
    if let Some(directive) =
        deliverable_design_template_directive(options.design_template.as_deref(), "document")
    {
        directives.push(directive);
    }
    if let Some(directive) =
        deliverable_design_theme_directive(options.design_theme.as_deref(), "document")
    {
        directives.push(directive);
    }
    if let Some(directive) =
        deliverable_design_profile_directive(options.design_profile.as_deref(), "document")
    {
        directives.push(directive);
    }
    directives.extend(deliverable_design_component_directives(
        &options.design_components,
        "document",
    ));
    if !options.sections.is_empty() {
        directives.push(format!(
            "Required section order: {}.",
            options.sections.join(" -> ")
        ));
    }
    if directives.is_empty() {
        String::new()
    } else {
        format!(" Additional document contract: {}", directives.join(" "))
    }
}

pub(crate) async fn generate_document_markdown(
    http: &reqwest::Client,
    base_url: &str,
    model: &str,
    api_key: Option<&str>,
    brief: &str,
    language: &str,
    options: &DocumentGenerationOptions,
) -> Result<String, String> {
    let lang = if language.trim().is_empty() {
        "the SAME language as the user's brief below".to_string()
    } else {
        format!("the language with code '{}'", language.trim())
    };
    let directives = document_generation_directives(options);
    let system = format!(
        "You are a senior business writer. Produce ONLY a complete Markdown document in {lang}. \
Use a clear title, concise executive opening, structured sections with headings, and concrete \
bullets or tables when useful. Do not wrap the answer in code fences. Do not mention that you are \
an AI. The output must be ready to save as a deliverable artifact.{directives}"
    );
    let body = serde_json::json!({
        "model": model,
        "temperature": 0.35,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": brief },
        ],
    });
    let resp = recorded_openai_value(
        http,
        base_url,
        model,
        api_key,
        &body,
        std::time::Duration::from_secs(120),
        local_first_inference_usage::InferencePurpose::ArtifactGeneration,
        "document_markdown",
        system.chars().count().saturating_add(brief.chars().count()),
    )
    .await
    .ok_or_else(|| "document provider unreachable".to_string())?;
    let code = resp.status;
    if !(200..300).contains(&code) {
        return Err(format!(
            "document generation HTTP {code} from model «{model}» — check the provider or switch model."
        ));
    }
    let json = resp.body;
    let content = json
        .get("choices")
        .and_then(|choices| choices.as_array())
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(|content| content.as_str())
        .unwrap_or_default()
        .trim()
        .trim_start_matches("```markdown")
        .trim_start_matches("```md")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim()
        .to_string();
    if content.is_empty() {
        Err("document generation returned empty content".to_string())
    } else {
        Ok(content)
    }
}

/// Generate + assemble a templated document's doc.json (F2-T8), with ONE
/// corrective retry if the model dropped a slot. `assemble_doc_json` fails
/// loud rather than synthesizing placeholder content for a missing slot (that
/// would launder content the model never wrote into the deliverable) — the
/// retry hands the model the exact missing-slot error and one more chance
/// before we give up honestly.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn generate_templated_document_json(
    http: &reqwest::Client,
    base_url: &str,
    model: &str,
    api_key: Option<&str>,
    brief: &str,
    language: &str,
    skeleton: &[document_content::DocBlockSlot],
    design_directives: &str,
    title_fallback: &str,
) -> Result<serde_json::Value, String> {
    let first_output = document_content::generate_document_content(
        http,
        base_url,
        model,
        api_key,
        brief,
        language,
        skeleton,
        design_directives,
    )
    .await?;
    match document_content::assemble_doc_json(title_fallback, skeleton, &first_output) {
        Ok(doc) => Ok(doc),
        Err(missing) => {
            let corrective = format!(
                "{design_directives} CORRECTION: your previous JSON was rejected — {missing}. \
                 Return the COMPLETE JSON again with EVERY slot key filled; never omit one."
            );
            let retry_output = document_content::generate_document_content(
                http,
                base_url,
                model,
                api_key,
                brief,
                language,
                skeleton,
                &corrective,
            )
            .await?;
            document_content::assemble_doc_json(title_fallback, skeleton, &retry_output).map_err(
                |still_missing| {
                    format!(
                        "document content still incomplete after one corrective retry: {still_missing} (first attempt: {missing})"
                    )
                },
            )
        }
    }
}

pub(crate) fn markdown_candidate_lines(markdown: &str) -> Vec<String> {
    markdown
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty()
                || trimmed.starts_with('|')
                || trimmed.starts_with('#')
                || markdown_table_separator(trimmed)
            {
                return None;
            }
            let cleaned = trimmed
                .trim_start_matches("- ")
                .trim_start_matches("* ")
                .trim_start_matches(|ch: char| ch.is_ascii_digit() || ch == '.')
                .trim()
                .trim_matches('*')
                .trim()
                .to_string();
            if cleaned.is_empty() {
                None
            } else {
                Some(cleaned.chars().take(140).collect())
            }
        })
        .take(24)
        .collect()
}

pub(crate) fn markdown_has_heading(markdown: &str, heading: &str) -> bool {
    let target = heading.trim().to_ascii_lowercase();
    markdown.lines().any(|line| {
        line.trim()
            .trim_start_matches('#')
            .trim()
            .to_ascii_lowercase()
            == target
    })
}

pub(crate) fn component_line(lines: &[String], index: usize, fallback: &str) -> String {
    lines
        .get(index)
        .cloned()
        .unwrap_or_else(|| fallback.to_string())
}

pub(crate) fn document_component_block(component: &str, lines: &[String]) -> Option<String> {
    match component {
        "kpi_grid" => {
            let metrics = lines
                .iter()
                .filter(|line| line.chars().any(|ch| ch.is_ascii_digit()))
                .take(3)
                .cloned()
                .collect::<Vec<_>>();
            let metrics = if metrics.is_empty() {
                lines.iter().take(3).cloned().collect::<Vec<_>>()
            } else {
                metrics
            };
            if metrics.is_empty() {
                return None;
            }
            let mut rows = String::from(
                "## Key metrics\n\n| Metric | Value | Implication |\n| --- | --- | --- |\n",
            );
            for metric in metrics {
                rows.push_str(&format!("| {} | - | - |\n", metric.replace('|', "/")));
            }
            Some(rows)
        }
        "timeline" => Some(format!(
            "## Timeline\n\n| Phase | Detail | Outcome |\n| --- | --- | --- |\n| Now | {} | Current focus |\n| Next | {} | Next milestone |\n",
            component_line(lines, 0, "Current phase").replace('|', "/"),
            component_line(lines, 1, "Next phase").replace('|', "/"),
        )),
        "comparison_table" => Some(format!(
            "## Comparison\n\n| Criteria | Option A | Option B |\n| --- | --- | --- |\n| Focus | {} | {} |\n| Tradeoff | {} | {} |\n",
            component_line(lines, 0, "Primary option").replace('|', "/"),
            component_line(lines, 1, "Alternative option").replace('|', "/"),
            component_line(lines, 2, "Main benefit").replace('|', "/"),
            component_line(lines, 3, "Main tradeoff").replace('|', "/"),
        )),
        "quote_callout" => Some(format!(
            "## Key principle\n\n> {}\n",
            component_line(lines, 0, "Keep the deliverable focused and actionable")
        )),
        "process_steps" => {
            let steps = lines.iter().take(5).cloned().collect::<Vec<_>>();
            if steps.is_empty() {
                return None;
            }
            let mut block = String::from("## Process steps\n\n");
            for (index, step) in steps.iter().enumerate() {
                block.push_str(&format!("{}. {}\n", index + 1, step));
            }
            Some(block)
        }
        "risks_table" => Some(format!(
            "## Risks and mitigations\n\n| Risk | Impact | Mitigation |\n| --- | --- | --- |\n| {} | - | {} |\n| {} | - | {} |\n",
            component_line(lines, 0, "Execution risk").replace('|', "/"),
            component_line(lines, 1, "Mitigation").replace('|', "/"),
            component_line(lines, 2, "Adoption risk").replace('|', "/"),
            component_line(lines, 3, "Owner follow-up").replace('|', "/"),
        )),
        _ => None,
    }
}

pub(crate) fn apply_document_design_components(markdown: &str, components: &[String]) -> String {
    if components.is_empty() {
        return markdown.to_string();
    }
    let lines = markdown_candidate_lines(markdown);
    let mut output = markdown.trim().to_string();
    for component in components {
        let heading = match component.as_str() {
            "kpi_grid" => "Key metrics",
            "timeline" => "Timeline",
            "comparison_table" => "Comparison",
            "quote_callout" => "Key principle",
            "process_steps" => "Process steps",
            "risks_table" => "Risks and mitigations",
            _ => continue,
        };
        if markdown_has_heading(&output, heading) {
            continue;
        }
        let Some(block) = document_component_block(component, &lines) else {
            continue;
        };
        output.push_str("\n\n");
        output.push_str(block.trim());
    }
    output.push('\n');
    output
}

pub(crate) fn markdown_table_cell_count(line: &str) -> Option<usize> {
    let trimmed = line.trim();
    if !trimmed.starts_with('|') || !trimmed.ends_with('|') {
        return None;
    }
    Some(trimmed.trim_matches('|').split('|').map(str::trim).count())
}

pub(crate) fn document_quality_issues(markdown: &str) -> Vec<String> {
    let mut issues = Vec::new();
    let mut expected_table_cells: Option<usize> = None;
    for (index, line) in markdown.lines().enumerate() {
        let line_no = index + 1;
        let trimmed = line.trim();
        if trimmed.chars().count() > 420 {
            issues.push(format!(
                "line {line_no}: line is too long for stable document rendering"
            ));
        }
        for token in trimmed.split_whitespace() {
            if token.starts_with("http://") || token.starts_with("https://") {
                continue;
            }
            if token.chars().count() > 160 {
                issues.push(format!(
                    "line {line_no}: long unbroken text exceeds 160 characters"
                ));
                break;
            }
        }
        if trimmed.is_empty() || !trimmed.starts_with('|') {
            expected_table_cells = None;
            continue;
        }
        let Some(cell_count) = markdown_table_cell_count(trimmed) else {
            expected_table_cells = None;
            continue;
        };
        if markdown_table_separator(trimmed) {
            continue;
        }
        match expected_table_cells {
            Some(expected) if cell_count != expected => {
                issues.push(format!(
                    "line {line_no}: table row has {cell_count} cells but expected {expected}"
                ));
            }
            Some(_) => {}
            None => expected_table_cells = Some(cell_count),
        }
    }
    issues
}

pub(crate) fn document_table_row(cells: &[String]) -> String {
    format!("| {} |", cells.join(" | "))
}

pub(crate) fn markdown_table_cells_for_repair(line: &str) -> Option<Vec<String>> {
    let trimmed = line.trim();
    if !trimmed.starts_with('|') || !trimmed.ends_with('|') {
        return None;
    }
    Some(
        trimmed
            .trim_matches('|')
            .split('|')
            .map(|cell| cell.trim().to_string())
            .collect(),
    )
}

pub(crate) fn document_normalize_table_cells(
    mut cells: Vec<String>,
    expected: usize,
) -> Vec<String> {
    if expected == 0 {
        return cells;
    }
    if cells.len() > expected {
        let overflow = cells.split_off(expected - 1);
        cells.push(overflow.join(" / "));
    }
    while cells.len() < expected {
        cells.push("-".to_string());
    }
    cells
}

pub(crate) fn normalize_document_tables(markdown: &str) -> String {
    let lines = markdown.lines().collect::<Vec<_>>();
    let mut output = Vec::with_capacity(lines.len());
    let mut index = 0usize;
    while index < lines.len() {
        let line = lines[index];
        let Some(header_cells) = markdown_table_cells(line) else {
            output.push(line.to_string());
            index += 1;
            continue;
        };
        if index + 1 >= lines.len() || !markdown_table_separator(lines[index + 1]) {
            output.push(line.to_string());
            index += 1;
            continue;
        }
        let expected = header_cells.len();
        output.push(document_table_row(&header_cells));
        output.push(document_table_row(&vec!["---".to_string(); expected]));
        index += 2;
        while index < lines.len() {
            let Some(row_cells) = markdown_table_cells_for_repair(lines[index]) else {
                break;
            };
            if markdown_table_separator(lines[index]) {
                break;
            }
            let cells = document_normalize_table_cells(row_cells, expected);
            output.push(document_table_row(&cells));
            index += 1;
        }
    }
    let mut normalized = output.join("\n");
    if markdown.ends_with('\n') {
        normalized.push('\n');
    }
    normalized
}

pub(crate) fn apply_document_quality_guardrails(markdown: &str) -> (String, Vec<String>) {
    let issues = document_quality_issues(markdown);
    let normalized = if issues.iter().any(|issue| issue.contains("table row has")) {
        normalize_document_tables(markdown)
    } else {
        markdown.to_string()
    };
    (normalized, issues)
}

pub(crate) fn document_artifact_name(raw: Option<&str>) -> String {
    document_artifact_name_with_extension(raw, "md")
}

pub(crate) fn document_artifact_name_with_extension(raw: Option<&str>, extension: &str) -> String {
    let extension = extension.trim_start_matches('.').to_ascii_lowercase();
    let extension = if extension.is_empty() {
        "md".to_string()
    } else {
        extension
    };
    let default = format!("document.{extension}");
    let candidate = raw.unwrap_or(default.as_str()).trim();
    let candidate = if candidate.is_empty() {
        default.as_str()
    } else {
        candidate
    };
    let basename = candidate
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(default.as_str())
        .trim();
    let mut safe = String::new();
    for ch in basename.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            safe.push(ch);
        } else if ch.is_whitespace() {
            safe.push('-');
        }
    }
    let safe = safe.trim_matches('.').trim_matches('-').to_string();
    let safe = if safe.is_empty() {
        "document".to_string()
    } else {
        safe
    };
    let lower = safe.to_ascii_lowercase();
    let stem = if lower.ends_with(".md") || lower.ends_with(".pdf") || lower.ends_with(".docx") {
        safe.rsplit_once('.')
            .map(|(stem, _)| stem)
            .unwrap_or(safe.as_str())
            .trim_matches('.')
            .trim_matches('-')
            .to_string()
    } else {
        safe
    };
    let stem = if stem.is_empty() {
        "document".to_string()
    } else {
        stem
    };
    format!("{stem}.{extension}")
}

pub(crate) fn document_artifact_name_from_brief(brief: &str) -> Option<String> {
    for token in brief.split_whitespace() {
        let raw = token.trim_matches(|ch: char| {
            matches!(
                ch,
                '"' | '\'' | '`' | '(' | ')' | '[' | ']' | '{' | '}' | ':' | ';' | ','
            )
        });
        let lower = raw.to_ascii_lowercase();
        let extension = lower
            .find(".docx")
            .map(|pos| (pos, "docx"))
            .or_else(|| lower.find(".pdf").map(|pos| (pos, "pdf")))
            .or_else(|| lower.find(".md").map(|pos| (pos, "md")));
        let Some((pos, extension)) = extension else {
            continue;
        };
        let end = pos + extension.len() + 1;
        let candidate = &raw[..end];
        if !candidate
            .trim_end_matches(".md")
            .trim_end_matches(".pdf")
            .trim_end_matches(".docx")
            .chars()
            .any(|ch| ch.is_ascii_alphanumeric())
        {
            continue;
        }
        return Some(document_artifact_name_with_extension(
            Some(candidate),
            extension,
        ));
    }
    None
}

pub(crate) fn document_requested_pdf(brief: &str) -> bool {
    let normalized = brief.to_ascii_lowercase();
    normalized.contains(".pdf")
        || normalized
            .split(|ch: char| !ch.is_ascii_alphanumeric())
            .any(|word| word == "pdf")
}

pub(crate) fn document_requested_docx(brief: &str) -> bool {
    let normalized = brief.to_ascii_lowercase();
    normalized.contains(".docx")
        || normalized
            .split(|ch: char| !ch.is_ascii_alphanumeric())
            .any(|word| {
                matches!(
                    word,
                    "docx" | "word" | "editable" | "editabile" | "modificabile"
                )
            })
}

pub(crate) fn document_output_formats(
    parsed: &serde_json::Value,
    name: &str,
    brief: &str,
) -> Vec<String> {
    let mut formats = Vec::new();
    if let Some(values) = parsed.get("formats").and_then(|value| value.as_array()) {
        for value in values {
            let Some(raw) = value.as_str() else {
                continue;
            };
            let format = raw.trim().trim_start_matches('.').to_ascii_lowercase();
            if matches!(format.as_str(), "md" | "pdf" | "docx")
                && !formats.iter().any(|f| f == &format)
            {
                formats.push(format);
            }
        }
    }
    if formats.is_empty() {
        let lower_name = name.to_ascii_lowercase();
        if lower_name.ends_with(".docx") || document_requested_docx(brief) {
            formats.push("docx".to_string());
        } else if lower_name.ends_with(".pdf") || document_requested_pdf(brief) {
            formats.push("pdf".to_string());
        } else {
            formats.push("md".to_string());
        }
    }
    formats
}

pub(crate) fn xml_escape_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub(crate) fn docx_text_run(text: &str, bold: bool, italic: bool) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut props = String::new();
    if bold {
        props.push_str("<w:b/>");
    }
    if italic {
        props.push_str("<w:i/>");
    }
    let props = if props.is_empty() {
        String::new()
    } else {
        format!("<w:rPr>{props}</w:rPr>")
    };
    let space = if text.starts_with(char::is_whitespace) || text.ends_with(char::is_whitespace) {
        r#" xml:space="preserve""#
    } else {
        ""
    };
    format!(
        r#"<w:r>{props}<w:t{space}>{}</w:t></w:r>"#,
        xml_escape_text(text)
    )
}

pub(crate) fn markdown_inline_to_docx_runs(text: &str) -> String {
    let mut runs = String::new();
    let mut buffer = String::new();
    let mut bold = false;
    let mut italic = false;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '*' && chars.peek() == Some(&'*') {
            chars.next();
            runs.push_str(&docx_text_run(&buffer, bold, italic));
            buffer.clear();
            bold = !bold;
        } else if ch == '*' {
            runs.push_str(&docx_text_run(&buffer, bold, italic));
            buffer.clear();
            italic = !italic;
        } else {
            buffer.push(ch);
        }
    }
    runs.push_str(&docx_text_run(&buffer, bold, italic));
    if runs.is_empty() {
        docx_text_run(text, false, false)
    } else {
        runs
    }
}

pub(crate) fn markdown_line_to_docx_paragraph(line: &str, force_heading1: bool) -> String {
    let trimmed = line.trim();
    let (style, text) = if let Some(text) = trimmed.strip_prefix("# ") {
        (Some("Heading1"), text.trim())
    } else if let Some(text) = trimmed.strip_prefix("## ") {
        (Some("Heading2"), text.trim())
    } else if let Some(text) = trimmed.strip_prefix("### ") {
        (Some("Heading3"), text.trim())
    } else if let Some(text) = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
    {
        (Some("ListParagraph"), text.trim())
    } else if let Some((number, _)) = trimmed.split_once(". ") {
        if number.chars().all(|ch| ch.is_ascii_digit()) && !number.is_empty() {
            (Some("ListParagraph"), trimmed)
        } else if force_heading1 {
            (Some("Heading1"), trimmed)
        } else {
            (None, trimmed)
        }
    } else if force_heading1 {
        (Some("Heading1"), trimmed)
    } else {
        (None, trimmed)
    };
    let style_xml = style
        .map(|style| format!(r#"<w:pPr><w:pStyle w:val="{style}"/></w:pPr>"#))
        .unwrap_or_default();
    format!(
        r#"<w:p>{style_xml}{}</w:p>"#,
        markdown_inline_to_docx_runs(text)
    )
}

pub(crate) fn markdown_table_cells(line: &str) -> Option<Vec<String>> {
    let trimmed = line.trim();
    if !trimmed.contains('|') {
        return None;
    }
    let inner = trimmed.trim_matches('|');
    let cells = inner
        .split('|')
        .map(|cell| cell.trim().to_string())
        .collect::<Vec<_>>();
    if cells.len() < 2 { None } else { Some(cells) }
}

pub(crate) fn markdown_table_separator(line: &str) -> bool {
    let Some(cells) = markdown_table_cells(line) else {
        return false;
    };
    cells.iter().all(|cell| {
        let compact = cell.replace([':', '-'], "");
        compact.trim().is_empty() && cell.chars().filter(|ch| *ch == '-').count() >= 3
    })
}

pub(crate) fn markdown_table_to_docx(rows: &[Vec<String>]) -> String {
    let col_count = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
    let pct_widths = if col_count == 2 {
        vec![1750, 3250]
    } else {
        let base = 5000 / col_count;
        let mut widths = vec![base; col_count];
        if let Some(last) = widths.last_mut() {
            *last += 5000 - base * col_count;
        }
        widths
    };
    let page_width_twips = 9026;
    let grid_widths = pct_widths
        .iter()
        .map(|width| ((*width as f32 / 5000.0) * page_width_twips as f32).round() as usize)
        .collect::<Vec<_>>();
    let grid = grid_widths
        .iter()
        .map(|width| format!(r#"<w:gridCol w:w="{width}"/>"#))
        .collect::<String>();
    let mut out = format!(
        r#"<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="B7B7B7"/><w:left w:val="single" w:sz="4" w:space="0" w:color="B7B7B7"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="B7B7B7"/><w:right w:val="single" w:sz="4" w:space="0" w:color="B7B7B7"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="B7B7B7"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="B7B7B7"/></w:tblBorders></w:tblPr><w:tblGrid>{grid}</w:tblGrid>"#,
    );
    for (row_index, row) in rows.iter().enumerate() {
        out.push_str("<w:tr>");
        for col_index in 0..col_count {
            let cell = row.get(col_index).map(String::as_str).unwrap_or("");
            let width = pct_widths.get(col_index).copied().unwrap_or(5000);
            let fill = if row_index == 0 {
                r#"<w:shd w:fill="F2F2F2"/>"#
            } else {
                ""
            };
            let runs = if row_index == 0 {
                docx_text_run(cell, true, false)
            } else {
                markdown_inline_to_docx_runs(cell)
            };
            out.push_str(&format!(
                r#"<w:tc><w:tcPr><w:tcW w:w="{width}" w:type="pct"/>{fill}</w:tcPr><w:p>{runs}</w:p></w:tc>"#,
            ));
        }
        out.push_str("</w:tr>");
    }
    out.push_str("</w:tbl>");
    out
}

pub(crate) fn markdown_to_docx(title: &str, markdown: &str) -> Result<Vec<u8>, String> {
    let mut document_body = String::new();
    let mut saw_content = false;
    let lines = markdown.lines().collect::<Vec<_>>();
    let mut i = 0;
    let mut first_content = true;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            if saw_content {
                document_body.push_str("<w:p/>");
            }
            i += 1;
            continue;
        }
        if let Some(header) = markdown_table_cells(line)
            && i + 1 < lines.len()
            && markdown_table_separator(lines[i + 1])
        {
            let mut rows = vec![header];
            i += 2;
            while i < lines.len() {
                let Some(row) = markdown_table_cells(lines[i]) else {
                    break;
                };
                if markdown_table_separator(lines[i]) {
                    break;
                }
                rows.push(row);
                i += 1;
            }
            saw_content = true;
            first_content = false;
            document_body.push_str(&markdown_table_to_docx(&rows));
            continue;
        }
        saw_content = true;
        document_body.push_str(&markdown_line_to_docx_paragraph(line, first_content));
        first_content = false;
        i += 1;
    }
    if !saw_content {
        document_body.push_str(&markdown_line_to_docx_paragraph(title, true));
    }
    docx_package(document_body)
}

/// Package a `word/document.xml` body into a minimal but valid Word (.docx)
/// OOXML zip: content types + package/document rels + one shared styles.xml
/// (Normal/Heading1-3/ListParagraph/TableGrid) + the body itself. Extracted
/// out of `markdown_to_docx` (F2-T7) so `doc_json_to_docx` can reuse the SAME
/// package writer instead of a second copy — converge, don't duplicate.
/// Behavior-preserving: this is a verbatim lift of markdown_to_docx's former
/// tail, guarded by its existing tests (they unzip and probe word/document.xml).
pub(crate) fn docx_package(document_body: String) -> Result<Vec<u8>, String> {
    let document_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:xml="http://www.w3.org/XML/1998/namespace">
<w:body>{document_body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>"#
    );
    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>"#;
    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;
    let document_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#;
    let styles = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="34"/><w:szCs w:val="34"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="220" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="180" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="59"/><w:qFormat/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="B7B7B7"/><w:left w:val="single" w:sz="4" w:space="0" w:color="B7B7B7"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="B7B7B7"/><w:right w:val="single" w:sz="4" w:space="0" w:color="B7B7B7"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="B7B7B7"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="B7B7B7"/></w:tblBorders></w:tblPr></w:style>
</w:styles>"#;
    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        writer
            .start_file("[Content_Types].xml", options)
            .map_err(|error| error.to_string())?;
        std::io::Write::write_all(&mut writer, content_types.as_bytes())
            .map_err(|error| error.to_string())?;
        writer
            .add_directory("_rels/", options)
            .map_err(|error| error.to_string())?;
        writer
            .start_file("_rels/.rels", options)
            .map_err(|error| error.to_string())?;
        std::io::Write::write_all(&mut writer, rels.as_bytes())
            .map_err(|error| error.to_string())?;
        writer
            .add_directory("word/", options)
            .map_err(|error| error.to_string())?;
        writer
            .add_directory("word/_rels/", options)
            .map_err(|error| error.to_string())?;
        writer
            .start_file("word/_rels/document.xml.rels", options)
            .map_err(|error| error.to_string())?;
        std::io::Write::write_all(&mut writer, document_rels.as_bytes())
            .map_err(|error| error.to_string())?;
        writer
            .start_file("word/styles.xml", options)
            .map_err(|error| error.to_string())?;
        std::io::Write::write_all(&mut writer, styles.as_bytes())
            .map_err(|error| error.to_string())?;
        writer
            .start_file("word/document.xml", options)
            .map_err(|error| error.to_string())?;
        std::io::Write::write_all(&mut writer, document_xml.as_bytes())
            .map_err(|error| error.to_string())?;
        writer.finish().map_err(|error| error.to_string())?;
    }
    Ok(cursor.into_inner())
}

/// `<w:p>` wrapper around pre-built run XML with an optional paragraph style.
/// Sibling of `markdown_line_to_docx_paragraph` but takes already-built run
/// XML instead of a markdown source line, since doc.json block fields are
/// plain model-authored strings, not markdown syntax to re-parse.
pub(crate) fn docx_paragraph_xml(style: Option<&str>, runs_xml: &str) -> String {
    let style_xml = style
        .map(|s| format!(r#"<w:pPr><w:pStyle w:val="{s}"/></w:pPr>"#))
        .unwrap_or_default();
    format!(r#"<w:p>{style_xml}{runs_xml}</w:p>"#)
}

/// A Heading1 paragraph, or nothing for empty text — same empty-means-absent
/// convention as `docx_heading2_paragraph` (an empty cover title/contact name
/// must not leave a stray empty heading paragraph in the document).
pub(crate) fn docx_heading1_paragraph(text: &str) -> String {
    if text.is_empty() {
        String::new()
    } else {
        docx_paragraph_xml(Some("Heading1"), &markdown_inline_to_docx_runs(text))
    }
}

/// A small-caps editorial kicker paragraph above a cover heading (DOCX). Mirrors
/// the HTML `.eyebrow` styling intent (uppercase, spaced) as far as flat DOCX runs
/// allow: bold + uppercased text. Empty input renders nothing (fail-open).
pub(crate) fn docx_eyebrow_paragraph(text: &str) -> String {
    if text.trim().is_empty() {
        return String::new();
    }
    docx_paragraph_xml(None, &docx_text_run(&text.to_uppercase(), true, false))
}

/// A Heading2 paragraph, or nothing for an empty/absent title — most doc.json
/// blocks carry an optional `title` field (`document_content.rs`'s block
/// registry) and an empty block-level title is deliberate ("use \"\" if none"),
/// not a paragraph to render.
pub(crate) fn docx_heading2_paragraph(text: &str) -> String {
    if text.is_empty() {
        String::new()
    } else {
        docx_paragraph_xml(Some("Heading2"), &markdown_inline_to_docx_runs(text))
    }
}

/// A Normal paragraph, or nothing for empty text (same "empty means absent"
/// convention as `docx_heading2_paragraph`).
pub(crate) fn docx_normal_paragraph(text: &str) -> String {
    if text.is_empty() {
        String::new()
    } else {
        docx_paragraph_xml(None, &markdown_inline_to_docx_runs(text))
    }
}

/// Read a string field off a doc.json block (or a nested entry/product/item
/// object), defaulting to `""` — blocks are model-authored JSON and
/// best-effort by design (PDF is the fidelity path; a missing/wrong-typed
/// field here degrades gracefully instead of panicking).
pub(crate) fn doc_block_field(block: &serde_json::Value, key: &str) -> String {
    block
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Read a string-array field off a doc.json block, defaulting to empty.
pub(crate) fn doc_block_string_array(block: &serde_json::Value, key: &str) -> Vec<String> {
    block
        .get(key)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Dispatch one doc.json block to OOXML paragraphs/tables. Mirrors
/// `doc_render.py::render_block`'s type switch (same 16 registered block
/// types — the shared registry in
/// `docs/superpowers/plans/2026-07-16-presentations-fase2-documents.md`,
/// schema in `document_content.rs::document_block_schema`) so the DOCX never
/// drops content the designed HTML/PDF shows — only fidelity differs
/// (declared best-effort: no new style plumbing beyond the shared styles.xml,
/// YAGNI). Inner array caps (pricing/spec row & cell counts, etc.) are the
/// model-facing schema's job (`document_content.rs`), not re-enforced here.
pub(crate) fn doc_block_to_docx_xml(block: &serde_json::Value) -> String {
    let kind = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match kind {
        "section_cover" => {
            let mut out = docx_eyebrow_paragraph(&doc_block_field(block, "eyebrow"));
            out.push_str(&docx_heading1_paragraph(&doc_block_field(block, "title")));
            out.push_str(&docx_normal_paragraph(&doc_block_field(block, "subtitle")));
            out
        }
        "contact_header" => {
            let mut out = docx_eyebrow_paragraph(&doc_block_field(block, "eyebrow"));
            out.push_str(&docx_heading1_paragraph(&doc_block_field(block, "name")));
            let headline = doc_block_field(block, "headline");
            if !headline.is_empty() {
                out.push_str(&docx_paragraph_xml(
                    None,
                    &docx_text_run(&headline, false, true),
                ));
            }
            let contacts = doc_block_string_array(block, "contact_items");
            if !contacts.is_empty() {
                out.push_str(&docx_paragraph_xml(
                    None,
                    &docx_text_run(&contacts.join("  ·  "), false, false),
                ));
            }
            out
        }
        "timeline" | "education_list" => {
            let mut out = docx_heading2_paragraph(&doc_block_field(block, "title"));
            for entry in block
                .get("entries")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                let heading = entry.get("heading").and_then(|v| v.as_str()).unwrap_or("");
                if !heading.is_empty() {
                    out.push_str(&docx_paragraph_xml(
                        None,
                        &docx_text_run(heading, true, false),
                    ));
                }
                let label = entry.get("label").and_then(|v| v.as_str()).unwrap_or("");
                let subheading = entry
                    .get("subheading")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                // "muted" (label — subheading) can't be a colour in a
                // style-only writer, so italics carries the de-emphasis.
                let meta = match (label.is_empty(), subheading.is_empty()) {
                    (true, true) => String::new(),
                    (false, true) => label.to_string(),
                    (true, false) => subheading.to_string(),
                    (false, false) => format!("{label} — {subheading}"),
                };
                if !meta.is_empty() {
                    out.push_str(&docx_paragraph_xml(
                        None,
                        &docx_text_run(&meta, false, true),
                    ));
                }
                for point in entry
                    .get("points")
                    .and_then(|v| v.as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|v| v.as_str())
                {
                    out.push_str(&docx_paragraph_xml(
                        Some("ListParagraph"),
                        &markdown_inline_to_docx_runs(point),
                    ));
                }
            }
            out
        }
        "pricing_table" | "spec_table" => {
            let mut out = docx_heading2_paragraph(&doc_block_field(block, "title"));
            let headers = doc_block_string_array(block, "headers");
            // Clamp each data row to the header width (defense-in-depth mirror
            // of doc_render.py's `row[:len(headers)]`): markdown_table_to_docx
            // derives col_count from the LONGEST row, so one over-wide
            // hand-authored row would grow a blank shaded header cell over
            // real data instead of being dropped.
            let rows: Vec<Vec<String>> = block
                .get("rows")
                .and_then(|v| v.as_array())
                .map(|rows| {
                    rows.iter()
                        .map(|row| {
                            row.as_array()
                                .map(|cells| {
                                    cells
                                        .iter()
                                        .take(headers.len())
                                        .filter_map(|c| c.as_str())
                                        .map(str::to_string)
                                        .collect()
                                })
                                .unwrap_or_default()
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !headers.is_empty() {
                let mut table_rows = Vec::with_capacity(rows.len() + 1);
                table_rows.push(headers);
                table_rows.extend(rows);
                out.push_str(&markdown_table_to_docx(&table_rows));
            }
            out.push_str(&docx_normal_paragraph(&doc_block_field(block, "note")));
            out
        }
        "product_grid" => {
            let mut out = docx_heading2_paragraph(&doc_block_field(block, "title"));
            if let Some(products) = block.get("products").and_then(|v| v.as_array())
                && !products.is_empty()
            {
                let mut rows = vec![vec![
                    "Name".to_string(),
                    "Description".to_string(),
                    "Price".to_string(),
                ]];
                for product in products {
                    // Fold a non-empty badge into the name cell ("Name — BADGE")
                    // instead of dropping it — the badge is real product.json
                    // content (doc_render.py's HTML renders it as a pill), and
                    // the DOCX table has no spare column for a 5th field.
                    let badge = doc_block_field(product, "badge");
                    let name = doc_block_field(product, "name");
                    let name_cell = if badge.trim().is_empty() {
                        name
                    } else {
                        format!("{name} — {badge}")
                    };
                    rows.push(vec![
                        name_cell,
                        doc_block_field(product, "description"),
                        doc_block_field(product, "price"),
                    ]);
                }
                out.push_str(&markdown_table_to_docx(&rows));
            }
            out
        }
        "kpi_band" => {
            let mut out = docx_heading2_paragraph(&doc_block_field(block, "title"));
            if let Some(items) = block.get("items").and_then(|v| v.as_array())
                && !items.is_empty()
            {
                // One table: header row = values (bold/shaded like any
                // markdown_table_to_docx header), single body row = labels.
                let values = items
                    .iter()
                    .map(|i| doc_block_field(i, "value"))
                    .collect::<Vec<_>>();
                let labels = items
                    .iter()
                    .map(|i| doc_block_field(i, "label"))
                    .collect::<Vec<_>>();
                out.push_str(&markdown_table_to_docx(&[values, labels]));
            }
            out
        }
        "text_section" => {
            let mut out = docx_heading2_paragraph(&doc_block_field(block, "title"));
            for para in doc_block_string_array(block, "paragraphs") {
                out.push_str(&docx_normal_paragraph(&para));
            }
            for bullet in doc_block_string_array(block, "bullets") {
                out.push_str(&docx_paragraph_xml(
                    Some("ListParagraph"),
                    &markdown_inline_to_docx_runs(&bullet),
                ));
            }
            out
        }
        "profile_summary" => {
            let mut out = docx_heading2_paragraph(&doc_block_field(block, "title"));
            out.push_str(&docx_normal_paragraph(&doc_block_field(block, "text")));
            out
        }
        "skill_tags" => {
            let mut out = docx_heading2_paragraph(&doc_block_field(block, "title"));
            for group in block
                .get("groups")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                let label = group.get("label").and_then(|v| v.as_str()).unwrap_or("");
                let tags = group
                    .get("tags")
                    .and_then(|v| v.as_array())
                    .map(|tags| {
                        tags.iter()
                            .filter_map(|t| t.as_str())
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default();
                let line = match (label.is_empty(), tags.is_empty()) {
                    (true, true) => continue,
                    (false, true) => label.to_string(),
                    (true, false) => tags,
                    (false, false) => format!("{label}: {tags}"),
                };
                out.push_str(&docx_paragraph_xml(
                    None,
                    &docx_text_run(&line, false, false),
                ));
            }
            out
        }
        // Best-effort flat paragraph dump — these blocks carry no "title"
        // slot to promote to a heading; DOCX editability wins over layout
        // fidelity (the designed HTML/PDF is the fidelity path).
        "letterhead" => {
            let mut out = docx_eyebrow_paragraph(&doc_block_field(block, "eyebrow"));
            out.push_str(&docx_normal_paragraph(&doc_block_field(
                block,
                "organization",
            )));
            out.push_str(&docx_normal_paragraph(&doc_block_field(
                block,
                "contact_line",
            )));
            out.push_str(&docx_normal_paragraph(&doc_block_field(block, "date_line")));
            for line in doc_block_string_array(block, "recipient_lines") {
                out.push_str(&docx_normal_paragraph(&line));
            }
            out
        }
        "letter_body" => {
            let mut out = docx_normal_paragraph(&doc_block_field(block, "salutation"));
            for para in doc_block_string_array(block, "paragraphs") {
                out.push_str(&docx_normal_paragraph(&para));
            }
            out
        }
        "signature_block" => {
            let mut out = docx_normal_paragraph(&doc_block_field(block, "closing"));
            out.push_str(&docx_normal_paragraph(&doc_block_field(block, "name")));
            out.push_str(&docx_normal_paragraph(&doc_block_field(block, "role")));
            out
        }
        "cta_footer" => {
            let mut out = docx_normal_paragraph(&doc_block_field(block, "heading"));
            for line in doc_block_string_array(block, "lines") {
                out.push_str(&docx_normal_paragraph(&line));
            }
            out
        }
        "testimonial_quote" => {
            let mut out = docx_normal_paragraph(&doc_block_field(block, "quote"));
            let author = doc_block_field(block, "author");
            let role = doc_block_field(block, "role");
            let attribution = match (author.is_empty(), role.is_empty()) {
                (true, true) => String::new(),
                (false, true) => format!("— {author}"),
                (true, false) => format!("— {role}"),
                (false, false) => format!("— {author}, {role}"),
            };
            if !attribution.is_empty() {
                out.push_str(&docx_paragraph_xml(
                    None,
                    &docx_text_run(&attribution, false, true),
                ));
            }
            out
        }
        // Unregistered/unknown block type — never drop content silently
        // (mirrors doc_render.py's own text_section fallback for the same
        // reason): title -> Heading2, paragraphs/bullets if present.
        _ => {
            let mut out = docx_heading2_paragraph(&doc_block_field(block, "title"));
            for para in doc_block_string_array(block, "paragraphs") {
                out.push_str(&docx_normal_paragraph(&para));
            }
            for bullet in doc_block_string_array(block, "bullets") {
                out.push_str(&docx_paragraph_xml(
                    Some("ListParagraph"),
                    &markdown_inline_to_docx_runs(&bullet),
                ));
            }
            out
        }
    }
}

/// doc.json (F2 documents, `document_content.rs`) -> editable .docx. The
/// designed HTML/PDF (`doc_render.py`) is the fidelity path; this writer's
/// job is editability, reusing the exact package/style plumbing already
/// shipped for `markdown_to_docx` (`docx_package`) so there is only ONE OOXML
/// writer in the gateway, not two.
///
/// Wired into `make_document`'s templated path (F2-T8,
/// `make_templated_document`), which produces the DOCX gateway-side from the
/// same doc.json the container renders to HTML/PDF.
pub(crate) fn doc_json_to_docx(doc: &serde_json::Value) -> Result<Vec<u8>, String> {
    let title = doc
        .get("title")
        .and_then(|t| t.as_str())
        .unwrap_or("Document");
    let blocks = doc.get("blocks").and_then(|b| b.as_array());
    let mut document_body = String::new();
    match blocks {
        Some(blocks) if !blocks.is_empty() => {
            for block in blocks {
                document_body.push_str(&doc_block_to_docx_xml(block));
            }
        }
        // Malformed/empty doc.json — still produce something rather than a
        // blank page, mirroring markdown_to_docx's own no-content fallback.
        _ => {
            document_body.push_str(&docx_paragraph_xml(
                Some("Heading1"),
                &markdown_inline_to_docx_runs(title),
            ));
        }
    }
    docx_package(document_body)
}

pub(crate) fn generate_image_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "generate_image",
            "description": "Generate an image from a text prompt (a photo, illustration, icon, diagram-free visual, slide background, …) and save it as a downloadable PNG artifact. Runs on the configured image provider — a LOCAL model via Ollama by default, or a cloud one. Use it when the user asks to create/generate/draw an image, or when a visual is needed (e.g. a slide cover).",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "What to depict — be specific about subject, style, composition and colours." },
                    "name": { "type": "string", "description": "Optional artifact file name WITHOUT extension (e.g. \"cover\"). Defaults to \"image\"." },
                    "size": { "type": "string", "description": "Optional WxH (default 1024x1024).", "enum": ["1024x1024", "1280x720", "768x1024", "1024x768"] }
                },
                "required": ["prompt"]
            }
        }
    })
}

/// Read the user's saved BRAND KIT (organization, colours, fonts, logo data URL) so a
/// deliverable can be produced ON-BRAND.
pub(crate) fn render_deck_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "render_deck",
            "description": "Render a presentation from a STRUCTURED deck (content only) into an EDITABLE PowerPoint (.pptx) plus an HTML/PDF preview, saved as artifacts. This tool does ALL the file writing and rendering deterministically — do NOT use the shell, do NOT write deck.json yourself, do NOT search for files. The brand kit (colours, fonts, logo) is applied AUTOMATICALLY: do NOT include any theme or logo. Reference images you made with generate_image by their file name only (e.g. \"cover.png\").",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Deck title." },
                    "subtitle": { "type": "string", "description": "Optional subtitle, e.g. 'ORG · date'." },
                    "slides": {
                        "type": "array",
                        "description": "Slides in order; vary the layout. One idea per slide.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "layout": { "type": "string", "enum": ["cover","section","bullets","image_left","image_right","kpi","two_column","quote","closing"], "description": "Slide layout." },
                                "title": { "type": "string" },
                                "subtitle": { "type": "string" },
                                "bullets": { "type": "array", "items": { "type": "string" } },
                                "body": { "type": "string" },
                                "image": { "type": "string", "description": "File name of a generated image (e.g. cover.png)." },
                                "kpi": { "type": "string" },
                                "kpi_label": { "type": "string" },
                                "quote": { "type": "string" },
                                "author": { "type": "string" },
                                "columns": { "type": "array", "items": { "type": "object" }, "description": "two_column: [{title,bullets[]},{title,bullets[]}]." },
                                "notes": { "type": "string", "description": "Speaker notes (PPTX)." }
                            },
                            "required": ["layout"]
                        }
                    }
                },
                "required": ["slides"]
            }
        }
    })
}

pub(crate) fn get_brand_kit_tool_schema() -> serde_json::Value {
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "get_brand_kit",
            "description": "Read the user's saved brand kit — organization name, primary/secondary/accent colours (hex), heading/body fonts, and a logo (data URL, may be empty). Call it BEFORE creating a presentation, document or any branded visual, and apply the returned colours/fonts/logo so the deliverable matches the user's brand.",
            "parameters": { "type": "object", "properties": {}, "required": [] }
        }
    })
}

/// Tool to deliver a generated artifact to a user-authorized destination folder.
/// The gateway performs the copy host-side, scoped to granted destinations only.
pub(crate) fn save_artifact_tool_schema(destinations: &[ArtifactDestination]) -> serde_json::Value {
    let labels = destinations
        .iter()
        .map(|d| d.label.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    serde_json::json!({
        "type": "function",
        "function": {
            "name": "save_artifact",
            "description": format!(
                "Copy a generated file (artifact, saved in $OUTPUT_DIR) to a destination folder \
    AUTHORIZED by the user. Available destinations: {labels}. Use it when the user \
    asks to save/export a file to a folder."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "file": { "type": "string", "description": "Name of the artifact file to copy, e.g. \"report.xlsx\"" },
                    "destination": { "type": "string", "description": format!("Destination label among: {labels}") }
                },
                "required": ["file", "destination"]
            }
        }
    })
}
