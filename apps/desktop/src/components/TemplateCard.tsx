import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Presentation, Trash2 } from "lucide-react";
import { coreBridge, type BrandKit, type TemplateCatalogEntry } from "../lib/coreBridge";
import { brandPreviewOverride, DARK_SURFACE_THEMES, templateDisplayName } from "./presentationsShared";

/** Minimal card for the template gallery grid (S1c: Fabio's direct feedback on
 *  the S1b full-bleed relayout — "toglierei il contenitore intorno alle
 *  schede"). No card container box: `.tcard` is a transparent flex column.
 *  `.tcard-frame` is the only bordered surface left, a lightly-framed rounded
 *  thumbnail (Z.ai-style); the title + kind badge live in a plain caption
 *  BELOW it, always visible; Use/Remove reveal as a light hover overlay
 *  instead of the old heavy dark scrim. `.tcard-open` (the click-to-open
 *  trigger) and `.tcard-hover-actions` (Use/Remove) are SIBLINGS inside the
 *  frame, not nested — a <button> can't contain another <button>. Secondary
 *  metadata (source, selection rationale, theme tags) stays in
 *  TemplateDetailModal, which this card opens on click. */
export function TemplateCard({
  entry,
  brandKit,
  starting,
  deleting,
  disabled,
  onOpen,
  onUse,
  onDelete,
}: {
  entry: TemplateCatalogEntry;
  brandKit: BrandKit;
  starting: boolean;
  deleting: boolean;
  // Global in-flight guard: true while ANY card is mid-use/delete. Neither
  // useTemplate nor deleteTemplate is re-entrant, so without this a user could
  // click Use on card A then card B and spawn two racing chat workflows.
  // Per-card `starting`/`deleting` still drive this card's spinner/label.
  disabled: boolean;
  onOpen: () => void;
  onUse: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <article className={`tcard${entry.kind === "document" ? " doc" : ""}`}>
      <div className="tcard-frame">
        <button
          type="button"
          className="tcard-open"
          onClick={onOpen}
          aria-label={t("presentations:openTemplateDetails", {
            name: templateDisplayName(entry, i18n.language),
          })}
        >
          <TemplateCardPreview entry={entry} brandKit={brandKit} />
        </button>
        <div className="tcard-hover-actions">
          <button
            type="button"
            onClick={onUse}
            disabled={disabled || starting || deleting}
            title={t("presentations:useTemplate")}
          >
            <Presentation size={13} aria-hidden />
            {starting ? t("presentations:starting") : t("presentations:useTemplate")}
          </button>
          {entry.is_imported && (
            <button
              type="button"
              className="tcard-remove"
              onClick={onDelete}
              disabled={disabled || starting || deleting}
              title={t("presentations:removeTemplate")}
            >
              <Trash2 size={12} aria-hidden />
              {deleting ? t("presentations:removing") : t("presentations:removeTemplate")}
            </button>
          )}
        </div>
      </div>
      <div className="tcard-caption">
        <h4>{templateDisplayName(entry, i18n.language)}</h4>
        <span className="tcard-badge">{entry.kind === "presentation" ? "PPTX" : "DOCX"}</span>
      </div>
    </article>
  );
}

export function TemplateCardPreview({ entry, brandKit }: { entry: TemplateCatalogEntry; brandKit: BrandKit }) {
  if (entry.preview_html_ref) return <TemplateLivePreview entry={entry} brandKit={brandKit} />;
  return <TemplateRasterOrContractPreview entry={entry} />;
}

/** Embeds the pack's REAL renderer output (preview.html) scaled into the card.
 *  sandbox="" = no scripts, no same-origin: the HTML is trusted (we build it)
 *  but the cheapest posture wins. Card mode is inert (pointer-events none);
 *  interactive mode (detail modal) lets the user scroll through the pages. */
export function TemplateLivePreview({
  entry,
  interactive = false,
  brandKit,
}: {
  entry: TemplateCatalogEntry;
  interactive?: boolean;
  brandKit?: BrandKit;
}) {
  const { i18n } = useTranslation();
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [scale, setScale] = useState(0.2);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Document packs render at A4 width (794px @96dpi); presentations at 16:9 (1280px).
  // The scale factor below is derived from this so the iframe always fits its card.
  const designWidth = entry.kind === "document" ? 794 : 1280;
  // Card mode is scrolled through a taller-than-viewport iframe on hover (see the
  // template-preview-cycle keyframes in styles.css); the height/page-size below
  // are generous fixed guesses (4 deck slides / 3 A4 pages) — the sandboxed
  // iframe gives us no way to measure real content length, so packs shorter
  // than that show blank space past their last page, which is an acceptable
  // preview-only artifact.
  const pageHeight = entry.kind === "document" ? 1123 : 720;
  const previewHeight = pageHeight * (entry.kind === "document" ? 3 : 4);

  useEffect(() => {
    let active = true;
    setHtml(null);
    setFailed(false);
    if (!entry.preview_html_ref) {
      setFailed(true);
      return undefined;
    }
    void coreBridge
      .templatePreviewHtml(entry.preview_html_ref)
      .then((text) => {
        if (active) setHtml(text);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [entry.preview_html_ref]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0) setScale(el.clientWidth / designWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [html, designWidth]);

  if (failed) return <TemplateRasterOrContractPreview entry={entry} />;
  if (!html) {
    return (
      <div className="template-card-preview template-preview-loading">
        <div className="template-preview-shimmer" />
        <div className="template-preview-loading-lines">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }
  // Recolor is a derived string, not a refetch: `html` stays keyed on preview_html_ref
  // (fetched once above), so editing the brand kit only recomputes this cheap replace —
  // instant recolor, zero network. Both renderers emit literal `</head>`/`<body>` anchors
  // (deck_render _HTML_SHELL, doc_render render_html); if either is missing the replace
  // is a no-op and `html` passes through untouched (fail-open, never a broken srcDoc).
  // Dark editorial surfaces own their palette; the recolor only swaps --brand/--accent
  // (not --surface), so a dark user brand would make accents vanish there. Colour override
  // is skipped on those packs (colorSafe:false) but the font override is never surface-unsafe,
  // so it always applies — brandPreviewOverride always runs, only colourVars are gated.
  const colorSafe = !(entry.design_theme && DARK_SURFACE_THEMES.has(entry.design_theme));
  const override = brandKit ? brandPreviewOverride(brandKit, { colorSafe }) : null;
  const srcDoc = override
    ? html
        .replace("</head>", `${override.style}</head>`)
        .replace(/<body([^>]*)>/, `<body$1>${override.logo}`)
    : html;
  return (
    <div
      ref={wrapRef}
      className={`template-card-preview template-live-preview${interactive ? " interactive" : ""}${entry.kind === "document" ? " doc-preview" : ""}`}
      style={
        {
          "--cycle-1": `-${Math.round(pageHeight * 1 * scale)}px`,
          "--cycle-2": `-${Math.round(pageHeight * 2 * scale)}px`,
          "--cycle-3": `-${Math.round(pageHeight * 3 * scale)}px`,
        } as CSSProperties
      }
    >
      {/* Card mode is a decorative thumbnail (inert, hidden from AT); interactive mode is the actual scrollable content, so it must be focusable and titled. */}
      <iframe
        sandbox=""
        srcDoc={srcDoc}
        title={interactive ? templateDisplayName(entry, i18n.language) : ""}
        tabIndex={interactive ? 0 : -1}
        aria-hidden={interactive ? undefined : true}
        style={{
          width: designWidth,
          transform: `scale(${scale})`,
          height: interactive ? `${Math.round(560 / scale)}px` : `${previewHeight}px`,
        }}
      />
    </div>
  );
}

/** Fallback chain for packs without a live preview.html: an authenticated raster
 *  fetch (imported PPTX thumbnails) first, a text-only "contract" card last. */
export function TemplateRasterOrContractPreview({ entry }: { entry: TemplateCatalogEntry }) {
  const { t } = useTranslation();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const canRenderImage = entry.preview_ref
    ? /^(https?:\/\/|\/api\/templates\/preview|template-pack:\/\/)/.test(entry.preview_ref)
    : false;
  const needsAuthenticatedFetch = entry.preview_ref
    ? /^(\/*api\/templates\/preview|template-pack:\/\/)/.test(entry.preview_ref)
    : false;
  const imageSrc = entry.preview_ref ? coreBridge.templatePreviewUrl(entry.preview_ref) : "";

  useEffect(() => {
    if (!entry.preview_ref || !needsAuthenticatedFetch) {
      setBlobUrl(null);
      setImageFailed(false);
      return undefined;
    }
    let active = true;
    let nextUrl: string | null = null;
    setBlobUrl(null);
    setImageFailed(false);
    void coreBridge
      .templatePreviewBlobUrl(entry.preview_ref)
      .then((url) => {
        nextUrl = url;
        if (active) {
          setBlobUrl(url);
        } else if (url.startsWith("blob:")) {
          URL.revokeObjectURL(url);
        }
      })
      .catch(() => {
        if (active) setImageFailed(true);
      });
    return () => {
      active = false;
      if (nextUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(nextUrl);
      }
    };
  }, [entry.preview_ref, needsAuthenticatedFetch]);

  if (canRenderImage && needsAuthenticatedFetch && !blobUrl && !imageFailed) {
    return (
      <div className="template-card-preview template-preview-loading" aria-label={t("presentations:loadingPreview")}>
        <div className="template-preview-shimmer" />
        <div className="template-preview-loading-lines">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  }

  if (canRenderImage && !imageFailed) {
    return (
      <div className="template-card-preview image-preview">
        <img
          src={needsAuthenticatedFetch ? blobUrl ?? "" : imageSrc}
          alt=""
          loading="lazy"
          onError={() => setImageFailed(true)}
        />
      </div>
    );
  }

  return (
    <div className="template-card-contract">
      <div className="template-contract-topline">
        {entry.kind === "presentation" ? (
          <Presentation size={18} aria-hidden />
        ) : (
          <FileText size={18} aria-hidden />
        )}
        <span>{entry.kind === "presentation" ? "Presentation" : "Document"}</span>
      </div>
      <strong>{entry.design_template.replaceAll("_", " ")}</strong>
      <div className="template-layout-list">
        {entry.layout_archetypes.slice(0, 4).map((layout) => (
          <span key={layout}>{layout}</span>
        ))}
      </div>
    </div>
  );
}
