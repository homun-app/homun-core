//! Chat attachment ingestion: turns files the user attached in the composer into
//! model-visible content. Text-bearing files (PDF text layer, txt/csv/code) become
//! a text block injected into the prompt; images (photos, or scanned-PDF pages
//! rasterized via pdfium) become `data:` URLs fed to the vision model.
//!
//! Attaching a file IS the user's access grant for THAT file, so we read the exact
//! `local_path` provided (with size/existence guards) rather than going through the
//! folder-authorization jail used by the model-driven `list_directory` tool.

use std::path::Path;

use base64::Engine;
use image::ImageEncoder;
use local_first_desktop_gateway::AttachmentInput;
use pdfium_render::prelude::*;

/// Hard cap on a single attachment we will read into memory.
const MAX_ATTACHMENT_BYTES: u64 = 25 * 1024 * 1024;
/// Truncate extracted/loaded text so one giant file can't blow the context.
const MAX_TEXT_CHARS: usize = 120_000;
/// Pages we rasterize for a scanned PDF (bounds token cost on the vision model).
const MAX_PDF_PAGES: usize = 8;
/// Render width in px; height follows the page aspect ratio.
const PDF_RENDER_WIDTH: i32 = 1240;
/// Below this much non-whitespace text, a PDF is treated as a scan → rasterize.
const MIN_PDF_TEXT_CHARS: usize = 80;

/// The result of ingesting all attachments for one chat turn.
#[derive(Debug, Default)]
pub struct IngestedAttachments {
    /// Combined text blocks to append to the model-facing prompt.
    pub text: String,
    /// `data:` URLs (images / rendered PDF pages) for the vision model.
    pub images: Vec<String>,
}

/// One attachment after ingestion — the unit we persist per-thread so a file stays
/// available across turns. `text` is the extracted text (or a "scan → images" /
/// "⚠️ error" note); `images` are `data:` URLs for the vision model.
#[derive(Debug, Clone)]
pub struct IngestedFile {
    pub display_name: String,
    pub mime_type: String,
    pub text: Option<String>,
    pub images: Vec<String>,
}

/// Ingests each attachment independently, one `IngestedFile` per input. A failure
/// degrades to an `⚠️` note (never panics, never drops the entry) so the caller
/// can still persist/surface that the file was seen.
pub fn ingest_each(attachments: &[AttachmentInput]) -> Vec<IngestedFile> {
    attachments
        .iter()
        .map(|att| {
            let display_name = if att.display_name.trim().is_empty() {
                att.local_path.clone()
            } else {
                att.display_name.clone()
            };
            match ingest_one(att) {
                Ok(One { text, images }) => IngestedFile {
                    display_name,
                    mime_type: att.mime_type.clone(),
                    text,
                    images,
                },
                Err(note) => IngestedFile {
                    display_name,
                    mime_type: att.mime_type.clone(),
                    text: Some(format!("⚠️ {note}")),
                    images: Vec::new(),
                },
            }
        })
        .collect()
}

/// Reads every attachment and merges their extracted text + images. Per-attachment
/// failures degrade to a short note in the text (never panic, never abort the turn).
pub fn ingest_attachments(attachments: &[AttachmentInput]) -> IngestedAttachments {
    let mut out = IngestedAttachments::default();
    for file in ingest_each(attachments) {
        if let Some(text) = &file.text {
            if !text.trim().is_empty() {
                out.text
                    .push_str(&format!("\n\n[Allegato: {}]\n{}", file.display_name, text));
            }
        }
        out.images.extend(file.images);
    }
    out
}

struct One {
    text: Option<String>,
    images: Vec<String>,
}

fn ingest_one(att: &AttachmentInput) -> Result<One, String> {
    if att.local_path.trim().is_empty() {
        return Err("percorso locale non disponibile".to_string());
    }
    let path = Path::new(&att.local_path);
    let meta = std::fs::metadata(path).map_err(|_| "file non trovato".to_string())?;
    if !meta.is_file() {
        return Err("non è un file".to_string());
    }
    if meta.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!("troppo grande (max {} MB)", MAX_ATTACHMENT_BYTES / 1024 / 1024));
    }

    let mime = att.mime_type.to_lowercase();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    if mime.contains("svg") || ext == "svg" {
        // Vision models reject SVG; tell the user instead of silently sending it.
        return Err("immagine SVG non supportata dai modelli vision; esporta in PNG/JPEG".to_string());
    }
    if mime.starts_with("image/") || is_image_ext(&ext) {
        return Ok(One { text: None, images: vec![image_data_url(path, &mime, &ext)?] });
    }
    if mime == "application/pdf" || ext == "pdf" {
        return ingest_pdf(path);
    }
    if is_text_like(&mime, &ext) {
        let bytes = read_file_capped(path)?;
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        truncate_chars(&mut text, MAX_TEXT_CHARS);
        return Ok(One { text: Some(text), images: Vec::new() });
    }
    Err("tipo non ancora supportato per l'analisi (per ora: PDF, immagini, testo/codice)".to_string())
}

/// PDF: prefer the embedded text layer (born-digital docs → cheap, exact). If the
/// text is sparse (a scan/photo), rasterize the pages and hand them to the vision
/// model instead — this is what makes a scanned document (e.g. a driving licence)
/// analyzable at all.
fn ingest_pdf(path: &Path) -> Result<One, String> {
    let pdfium = bind_pdfium()?;
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("PDF illeggibile: {e}"))?;

    let mut text = String::new();
    for page in document.pages().iter() {
        if let Ok(page_text) = page.text() {
            text.push_str(page_text.all().trim());
            text.push('\n');
        }
    }
    let meaningful = text.chars().filter(|c| !c.is_whitespace()).count();
    if meaningful >= MIN_PDF_TEXT_CHARS {
        truncate_chars(&mut text, MAX_TEXT_CHARS);
        return Ok(One { text: Some(text), images: Vec::new() });
    }

    // Sparse text → treat as a scan and rasterize pages for the vision model.
    let images = render_pdf_pages(&document)?;
    if images.is_empty() {
        return Err("PDF senza testo estraibile e impossibile da rasterizzare".to_string());
    }
    let note = if document.pages().len() as usize > images.len() {
        format!(
            "(PDF scansione: prime {} pagine fornite come immagini per l'analisi visiva)",
            images.len()
        )
    } else {
        "(PDF scansione: pagine fornite come immagini per l'analisi visiva)".to_string()
    };
    Ok(One { text: Some(note), images })
}

/// Renders a PDF FILE's pages to JPEG data-URL images, for a clean document-style
/// preview in the artifact panel (white pages, no dark PDF-viewer chrome). Reuses the
/// same pdfium path as scan ingestion; errors clearly if pdfium isn't available so the
/// caller can fall back to the native iframe viewer.
pub fn render_pdf_to_images(path: &Path) -> Result<Vec<String>, String> {
    let pdfium = bind_pdfium()?;
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(|e| format!("PDF illeggibile: {e}"))?;
    render_pdf_pages(&document)
}

fn render_pdf_pages(document: &PdfDocument) -> Result<Vec<String>, String> {
    let config = PdfRenderConfig::new().set_target_width(PDF_RENDER_WIDTH);
    let mut urls = Vec::new();
    for (index, page) in document.pages().iter().enumerate() {
        if index >= MAX_PDF_PAGES {
            break;
        }
        let bitmap = page
            .render_with_config(&config)
            .map_err(|e| format!("render pagina {}: {e}", index + 1))?;
        let dynamic = bitmap.as_image();
        let rgb = dynamic.into_rgb8();
        let (width, height) = (rgb.width(), rgb.height());
        let mut buffer = std::io::Cursor::new(Vec::new());
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buffer, 75)
            .write_image(rgb.as_raw(), width, height, image::ExtendedColorType::Rgb8)
            .map_err(|e| format!("encode pagina {}: {e}", index + 1))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(buffer.get_ref());
        urls.push(format!("data:image/jpeg;base64,{b64}"));
    }
    Ok(urls)
}

/// Binds the pdfium dynamic library at runtime. Resolution order:
/// `LOCAL_FIRST_PDFIUM_LIB` (a dir or the lib file) → `~/.local-first-personal-assistant/pdfium`
/// → the system library. Returns a clear error (not a panic) when unavailable, so a
/// missing lib degrades to a "couldn't read the scan" note rather than crashing.
fn bind_pdfium() -> Result<Pdfium, String> {
    let bindings = match pdfium_lib_dir() {
        Some(dir) => Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&dir)),
        None => Pdfium::bind_to_system_library(),
    }
    .map_err(|e| {
        format!(
            "motore PDF (pdfium) non disponibile: {e}. Scarica libpdfium e mettilo in \
~/.local-first-personal-assistant/pdfium/ (o imposta LOCAL_FIRST_PDFIUM_LIB)."
        )
    })?;
    Ok(Pdfium::new(bindings))
}

fn pdfium_lib_dir() -> Option<std::path::PathBuf> {
    if let Ok(raw) = std::env::var("LOCAL_FIRST_PDFIUM_LIB") {
        let path = std::path::PathBuf::from(&raw);
        if path.is_dir() {
            return Some(path);
        }
        if path.is_file() {
            return path.parent().map(|p| p.to_path_buf());
        }
    }
    let home = std::env::var("HOME").ok()?;
    let dir = std::path::PathBuf::from(home)
        .join(".local-first-personal-assistant")
        .join("pdfium");
    if dir.is_dir() {
        return Some(dir);
    }
    None
}

/// Reads a file with a hard byte cap, closing the stat→read TOCTOU window (a file
/// that grows after the `metadata()` size check can't exceed the cap here).
fn read_file_capped(path: &Path) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.take(MAX_ATTACHMENT_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(format!("troppo grande (max {} MB)", MAX_ATTACHMENT_BYTES / 1024 / 1024));
    }
    Ok(buf)
}

fn image_data_url(path: &Path, mime: &str, ext: &str) -> Result<String, String> {
    let bytes = read_file_capped(path)?;
    let mime = if mime.starts_with("image/") {
        mime.to_string()
    } else {
        match ext {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "bmp" => "image/bmp",
            _ => "image/png",
        }
        .to_string()
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

fn is_image_ext(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp")
}

fn is_text_like(mime: &str, ext: &str) -> bool {
    if mime.starts_with("text/") {
        return true;
    }
    if matches!(
        mime,
        "application/json" | "application/xml" | "application/x-yaml" | "application/csv"
    ) {
        return true;
    }
    matches!(
        ext,
        "txt"
            | "md"
            | "markdown"
            | "csv"
            | "tsv"
            | "json"
            | "yaml"
            | "yml"
            | "xml"
            | "html"
            | "htm"
            | "rs"
            | "py"
            | "js"
            | "ts"
            | "tsx"
            | "jsx"
            | "go"
            | "java"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "rb"
            | "php"
            | "sh"
            | "toml"
            | "ini"
            | "cfg"
            | "log"
            | "sql"
    )
}

/// Truncates a string to at most `max` chars on a char boundary, appending a marker.
fn truncate_chars(text: &mut String, max: usize) {
    if text.chars().count() <= max {
        return;
    }
    let cut: String = text.chars().take(max).collect();
    *text = format!("{cut}\n… [troncato]");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_file_is_read_as_a_text_block() {
        let dir = std::env::temp_dir().join(format!("lfpa-att-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.txt");
        std::fs::write(&file, "ciao mondo").unwrap();
        let att = AttachmentInput {
            local_path: file.display().to_string(),
            display_name: "note.txt".into(),
            mime_type: "text/plain".into(),
            size_bytes: 10,
        };
        let out = ingest_attachments(std::slice::from_ref(&att));
        assert!(out.text.contains("ciao mondo"));
        assert!(out.text.contains("note.txt"));
        assert!(out.images.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_degrades_to_a_note_not_a_panic() {
        let att = AttachmentInput {
            local_path: "/nope/missing.pdf".into(),
            display_name: "missing.pdf".into(),
            mime_type: "application/pdf".into(),
            size_bytes: 0,
        };
        let out = ingest_attachments(std::slice::from_ref(&att));
        assert!(out.text.contains("missing.pdf"));
        assert!(out.text.contains("file non trovato"));
        assert!(out.images.is_empty());
    }

    // Opt-in smoke against a REAL pdfium lib (resolved from the data dir) + a real
    // PDF. Run with: LOCAL_FIRST_TEST_PDF=/path/to.pdf cargo test -p
    // local-first-desktop-gateway pdfium_ingestion_smoke -- --ignored --nocapture
    #[test]
    #[ignore = "needs pdfium lib installed + LOCAL_FIRST_TEST_PDF set"]
    fn pdfium_ingestion_smoke() {
        let path = std::env::var("LOCAL_FIRST_TEST_PDF").expect("set LOCAL_FIRST_TEST_PDF");
        let att = AttachmentInput {
            local_path: path.clone(),
            display_name: "test.pdf".into(),
            mime_type: "application/pdf".into(),
            size_bytes: 0,
        };
        let out = ingest_attachments(std::slice::from_ref(&att));
        eprintln!(
            "INGEST text_chars={} images={}",
            out.text.chars().count(),
            out.images.len()
        );
        eprintln!("INGEST text_head={}", out.text.chars().take(200).collect::<String>());
        assert!(
            !out.text.trim().is_empty() || !out.images.is_empty(),
            "pdfium ingestion produced no text and no images"
        );
        // Exercise the render path directly (rasterizes any page, scan or not).
        let pdfium = bind_pdfium().expect("bind pdfium");
        let doc = pdfium
            .load_pdf_from_file(Path::new(&path), None)
            .expect("load pdf");
        let images = render_pdf_pages(&doc).expect("render pages");
        eprintln!(
            "RENDER pages={} first_data_url_len={}",
            images.len(),
            images.first().map(|s| s.len()).unwrap_or(0)
        );
        assert!(!images.is_empty(), "render produced no page images");
        assert!(images[0].starts_with("data:image/jpeg;base64,"));
    }

    #[test]
    fn unsupported_type_is_noted() {
        let dir = std::env::temp_dir().join(format!("lfpa-att2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.bin");
        std::fs::write(&file, [0u8, 1, 2, 3]).unwrap();
        let att = AttachmentInput {
            local_path: file.display().to_string(),
            display_name: "a.bin".into(),
            mime_type: "application/octet-stream".into(),
            size_bytes: 4,
        };
        let out = ingest_attachments(std::slice::from_ref(&att));
        assert!(out.text.contains("non ancora supportato"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
