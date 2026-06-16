//! In-process Markdown → PDF rendering for the assistant's "create a PDF" capability.
//!
//! Design (SOTA): the model writes the document in **Markdown** (its strength) and we
//! render it to a paginated PDF here, deterministically. We do NOT ask the model to
//! emit PDF bytes. The renderer is **pure Rust** and uses the built-in base-14 PDF
//! fonts (Helvetica/Courier) — no font file is shipped, no Docker/sidecar/UI/network —
//! so producing a PDF ALWAYS works.

use printpdf::{BuiltinFont, IndirectFontRef, Mm, PdfDocumentReference, PdfLayerReference};
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};

const PAGE_W_MM: f64 = 210.0; // A4
const PAGE_H_MM: f64 = 297.0;
const MARGIN_MM: f64 = 18.0;
const USABLE_W_MM: f64 = PAGE_W_MM - 2.0 * MARGIN_MM;
const PT_PER_MM: f64 = 2.834_645_7;

/// A structural block extracted from the Markdown.
enum Block {
    Heading(u8, String),
    Paragraph(String),
    Bullet(String),
    Code(String),
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

/// Parses Markdown into a flat list of blocks. Inline emphasis is flattened to plain
/// text (kept simple + robust); tables render as ` | `-joined rows.
fn parse_blocks(markdown: &str) -> Vec<Block> {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    let parser = Parser::new_ext(markdown, options);

    let mut blocks: Vec<Block> = Vec::new();
    let mut buffer = String::new();
    let mut heading: Option<u8> = None;
    let mut in_item = false;
    let mut in_code = false;

    for event in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                flush(&mut blocks, &mut buffer, &mut heading, in_item);
                heading = Some(heading_level(level));
            }
            Event::End(TagEnd::Heading(_)) => {
                flush(&mut blocks, &mut buffer, &mut heading, in_item);
            }
            Event::Start(Tag::Item) => {
                flush(&mut blocks, &mut buffer, &mut heading, in_item);
                in_item = true;
            }
            Event::End(TagEnd::Item) => {
                flush(&mut blocks, &mut buffer, &mut heading, in_item);
                in_item = false;
            }
            Event::Start(Tag::CodeBlock(_)) => {
                flush(&mut blocks, &mut buffer, &mut heading, in_item);
                in_code = true;
            }
            Event::End(TagEnd::CodeBlock) => {
                let code = buffer.trim_end_matches('\n').to_string();
                if !code.trim().is_empty() {
                    blocks.push(Block::Code(code));
                }
                buffer.clear();
                in_code = false;
            }
            Event::End(TagEnd::Paragraph) => {
                flush(&mut blocks, &mut buffer, &mut heading, in_item);
            }
            // A table row ends → emit the accumulated cells as one line.
            Event::End(TagEnd::TableHead) | Event::End(TagEnd::TableRow) => {
                let row = buffer.trim().trim_end_matches('|').trim().to_string();
                if !row.is_empty() {
                    blocks.push(Block::Paragraph(row));
                }
                buffer.clear();
            }
            Event::End(TagEnd::TableCell) => {
                buffer.push_str(" | ");
            }
            Event::Text(text) => buffer.push_str(&text),
            Event::Code(text) => {
                buffer.push_str(&text);
            }
            Event::SoftBreak | Event::HardBreak => {
                if in_code {
                    buffer.push('\n');
                } else if !buffer.ends_with(' ') {
                    buffer.push(' ');
                }
            }
            _ => {}
        }
    }
    flush(&mut blocks, &mut buffer, &mut heading, in_item);
    blocks
}

fn flush(blocks: &mut Vec<Block>, buffer: &mut String, heading: &mut Option<u8>, in_item: bool) {
    let text = buffer.trim().to_string();
    buffer.clear();
    if text.is_empty() {
        *heading = None;
        return;
    }
    if let Some(level) = heading.take() {
        blocks.push(Block::Heading(level, text));
    } else if in_item {
        blocks.push(Block::Bullet(text));
    } else {
        blocks.push(Block::Paragraph(text));
    }
}

/// A single laid-out line ready to draw.
struct Line {
    text: String,
    size: f64,
    bold: bool,
    mono: bool,
    gap_before: f64,
}

/// Greedy word-wrap to fit the usable width, using an average-advance estimate for the
/// built-in font (Helvetica ≈ 0.5·em, Courier ≈ 0.6·em). Hard-breaks over-long words.
fn wrap(text: &str, size: f64, mono: bool) -> Vec<String> {
    let advance_pt = if mono { 0.60 } else { 0.50 } * size;
    let char_mm = advance_pt / PT_PER_MM;
    let max = ((USABLE_W_MM / char_mm).floor() as usize).max(20);

    let mut out: Vec<String> = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if line.is_empty() {
            line = word.to_string();
        } else if line.chars().count() + 1 + word.chars().count() <= max {
            line.push(' ');
            line.push_str(word);
        } else {
            out.push(std::mem::take(&mut line));
            line = word.to_string();
        }
        while line.chars().count() > max {
            let head: String = line.chars().take(max).collect();
            out.push(head);
            line = line.chars().skip(max).collect();
        }
    }
    if !line.is_empty() {
        out.push(line);
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

fn layout(title: &str, blocks: &[Block]) -> Vec<Line> {
    let mut lines: Vec<Line> = Vec::new();
    let title = title.trim();
    if !title.is_empty() {
        for (index, wrapped) in wrap(title, 20.0, false).into_iter().enumerate() {
            lines.push(Line {
                text: wrapped,
                size: 20.0,
                bold: true,
                mono: false,
                gap_before: if index == 0 { 0.0 } else { 1.0 },
            });
        }
    }
    for block in blocks {
        match block {
            Block::Heading(level, text) => {
                let size = match level {
                    1 => 16.0,
                    2 => 14.0,
                    _ => 12.5,
                };
                for (index, wrapped) in wrap(text, size, false).into_iter().enumerate() {
                    lines.push(Line {
                        text: wrapped,
                        size,
                        bold: true,
                        mono: false,
                        gap_before: if index == 0 { 4.5 } else { 0.0 },
                    });
                }
            }
            Block::Paragraph(text) => {
                for (index, wrapped) in wrap(text, 11.0, false).into_iter().enumerate() {
                    lines.push(Line {
                        text: wrapped,
                        size: 11.0,
                        bold: false,
                        mono: false,
                        gap_before: if index == 0 { 3.0 } else { 0.0 },
                    });
                }
            }
            Block::Bullet(text) => {
                for (index, wrapped) in wrap(text, 11.0, false).into_iter().enumerate() {
                    let prefixed = if index == 0 {
                        format!("•  {wrapped}")
                    } else {
                        format!("   {wrapped}")
                    };
                    lines.push(Line {
                        text: prefixed,
                        size: 11.0,
                        bold: false,
                        mono: false,
                        gap_before: if index == 0 { 1.5 } else { 0.0 },
                    });
                }
            }
            Block::Code(text) => {
                for raw in text.lines() {
                    for wrapped in wrap(raw, 9.5, true) {
                        lines.push(Line {
                            text: wrapped,
                            size: 9.5,
                            bold: false,
                            mono: true,
                            gap_before: 0.4,
                        });
                    }
                }
            }
        }
    }
    lines
}

/// Renders Markdown to a paginated A4 PDF and returns its bytes.
pub fn markdown_to_pdf(title: &str, markdown: &str) -> Result<Vec<u8>, String> {
    let doc_title = if title.trim().is_empty() { "Document" } else { title.trim() };
    let (doc, page1, layer1): (PdfDocumentReference, _, _) = printpdf::PdfDocument::new(
        doc_title,
        Mm(PAGE_W_MM as f32),
        Mm(PAGE_H_MM as f32),
        "Layer 1",
    );

    let regular: IndirectFontRef =
        doc.add_builtin_font(BuiltinFont::Helvetica).map_err(|e| e.to_string())?;
    let bold: IndirectFontRef =
        doc.add_builtin_font(BuiltinFont::HelveticaBold).map_err(|e| e.to_string())?;
    let mono: IndirectFontRef =
        doc.add_builtin_font(BuiltinFont::Courier).map_err(|e| e.to_string())?;

    let blocks = parse_blocks(markdown);
    let lines = layout(title, &blocks);

    let mut layer: PdfLayerReference = doc.get_page(page1).get_layer(layer1);
    let mut y = PAGE_H_MM - MARGIN_MM;

    for line in &lines {
        y -= line.gap_before;
        let line_height = line.size * 1.2 / PT_PER_MM;
        if y - line_height < MARGIN_MM {
            let (page, layer_index) =
                doc.add_page(Mm(PAGE_W_MM as f32), Mm(PAGE_H_MM as f32), "Layer");
            layer = doc.get_page(page).get_layer(layer_index);
            y = PAGE_H_MM - MARGIN_MM;
        }
        y -= line_height;
        if !line.text.is_empty() {
            let font = if line.mono {
                &mono
            } else if line.bold {
                &bold
            } else {
                &regular
            };
            layer.use_text(&line.text, line.size as f32, Mm(MARGIN_MM as f32), Mm(y as f32), font);
        }
    }

    let mut buffer: Vec<u8> = Vec::new();
    {
        let mut writer = std::io::BufWriter::new(&mut buffer);
        doc.save(&mut writer).map_err(|e| e.to_string())?;
    }
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_markdown_to_valid_pdf() {
        let md = "# ACME Quote\n\nConsulting 3 days.\n\n- Item one\n- Item two\n\n| Ship | Price |\n|---|---|\n| Cruise Roma | 135€ |\n\n```\ncode line\n```\n";
        let bytes = markdown_to_pdf("Quote", md).expect("render");
        // Valid PDFs start with the %PDF- header and are non-trivial in size.
        assert!(bytes.starts_with(b"%PDF-"), "missing PDF header");
        assert!(bytes.len() > 800, "PDF unexpectedly small: {}", bytes.len());
    }

    #[test]
    fn wrap_breaks_long_text() {
        let long = "word ".repeat(80);
        let lines = wrap(&long, 11.0, false);
        assert!(lines.len() > 1, "long text should wrap to multiple lines");
    }
}
