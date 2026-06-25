import { type ChangeEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, ImageIcon, Presentation, Save, Search, Upload } from "lucide-react";
import { coreBridge, type BrandKit, type TemplateCatalogEntry } from "../lib/coreBridge";
import { fileLocalPathFromBridge } from "../lib/gatewayConfig";
import type { PluginHost } from "../plugins/registry";

const DEFAULT_KIT: BrandKit = {
  organization: "",
  primary_color: "#2b6cb0",
  secondary_color: "#1a202c",
  accent_color: "#ed8936",
  heading_font: "Inter",
  body_font: "Inter",
  logo_data_url: "",
};

const COLOR_KEYS = ["primary_color", "secondary_color", "accent_color"] as const;

/** The Presentations plugin's panel: the persistent BRAND KIT (colours, fonts, logo)
 *  that the on-brand deck/document generators apply. Stored gateway-side. */
export function BrandKitPanel({ host }: { host: PluginHost }) {
  const { t } = useTranslation();
  const [kit, setKit] = useState<BrandKit>(DEFAULT_KIT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void coreBridge
      .brandKit()
      .then((k) => {
        if (active) setKit({ ...DEFAULT_KIT, ...k });
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const set = <K extends keyof BrandKit>(key: K, value: BrandKit[K]) =>
    setKit((prev) => ({ ...prev, [key]: value }));

  const onLogo = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result ?? "");
      // Rasterise the logo to PNG so it embeds EVERYWHERE — including the editable
      // .pptx (PowerPoint can't embed SVG; an SVG logo would render in the HTML/PDF
      // preview but silently drop from the .pptx). Any format in → PNG out.
      const img = new Image();
      img.onload = () => {
        const maxW = 720;
        let w = img.naturalWidth || 600;
        let h = img.naturalHeight || 200;
        if (w > maxW) {
          h = Math.round((h * maxW) / w);
          w = maxW;
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          set("logo_data_url", src);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        try {
          set("logo_data_url", canvas.toDataURL("image/png"));
        } catch {
          set("logo_data_url", src); // tainted canvas → keep the original
        }
      };
      img.onerror = () => set("logo_data_url", src);
      img.src = src;
    };
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    try {
      const k = await coreBridge.saveBrandKit(kit);
      setKit({ ...DEFAULT_KIT, ...k });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section className="brandkit">
        <p className="auto-empty">…</p>
      </section>
    );
  }

  return (
    <div className="presentations-panel presentation-studio">
      <section className="brandkit presentation-brand-rail" aria-labelledby="brandkit-title">
        <header className="presentation-rail-header">
          <div>
            <p className="eyebrow">{t("presentations:eyebrow")}</p>
            <h2 id="brandkit-title">{t("presentations:title")}</h2>
            <p className="lead-copy">{t("presentations:lead")}</p>
          </div>
        </header>

        <div className="brandkit-grid">
          <label className="brandkit-field">
            <span>{t("presentations:organization")}</span>
            <input
              value={kit.organization}
              onChange={(e) => set("organization", e.target.value)}
              placeholder="Acme S.r.l."
            />
          </label>

          {COLOR_KEYS.map((key) => (
            <label className="brandkit-field" key={key}>
              <span>{t(`presentations:${key}`)}</span>
              <div className="brandkit-color">
                <input
                  type="color"
                  value={kit[key] || "#000000"}
                  onChange={(e) => set(key, e.target.value)}
                />
                <input value={kit[key]} onChange={(e) => set(key, e.target.value)} />
              </div>
            </label>
          ))}

          <label className="brandkit-field">
            <span>{t("presentations:heading_font")}</span>
            <input
              value={kit.heading_font}
              onChange={(e) => set("heading_font", e.target.value)}
              placeholder="Inter"
            />
          </label>
          <label className="brandkit-field">
            <span>{t("presentations:body_font")}</span>
            <input
              value={kit.body_font}
              onChange={(e) => set("body_font", e.target.value)}
              placeholder="Inter"
            />
          </label>

          <label className="brandkit-field brandkit-field-wide">
            <span>{t("presentations:logo")}</span>
            <div className="brandkit-logo">
              {kit.logo_data_url ? (
                <img src={kit.logo_data_url} alt="logo" />
              ) : (
                <div className="brandkit-logo-empty">
                  <ImageIcon size={18} aria-hidden />
                </div>
              )}
              <label className="auto-btn brandkit-logo-upload">
                <Upload size={13} aria-hidden />
                {t("presentations:uploadLogo")}
                <input type="file" accept="image/*" onChange={onLogo} />
              </label>
              {kit.logo_data_url && (
                <button type="button" className="auto-btn" onClick={() => set("logo_data_url", "")}>
                  {t("presentations:removeLogo")}
                </button>
              )}
            </div>
          </label>
        </div>

        <div
          className="brandkit-preview"
          style={{ background: kit.primary_color, fontFamily: kit.heading_font }}
        >
          {kit.logo_data_url && (
            <img src={kit.logo_data_url} alt="" className="brandkit-preview-logo" />
          )}
          <div className="brandkit-preview-title">
            {kit.organization || t("presentations:previewTitle")}
          </div>
          <div className="brandkit-preview-accent" style={{ background: kit.accent_color }} />
        </div>

        <div className="brandkit-actions">
          <button className="auto-btn-accent" onClick={() => void save()} disabled={saving}>
            <Save size={14} aria-hidden /> {saved ? t("presentations:saved") : t("presentations:save")}
          </button>
        </div>
      </section>

      <TemplateCatalogGallery host={host} />
    </div>
  );
}

function TemplateCatalogGallery({ host }: { host: PluginHost }) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<TemplateCatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "presentation" | "document">("all");
  const [sourceFilter, setSourceFilter] = useState<"all" | "local" | "slidescarnival" | "homun">("all");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateCatalogEntry | null>(null);
  const [startingTemplateId, setStartingTemplateId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void coreBridge.templateCatalog().then((catalog) => {
      if (active) setTemplates(catalog.templates);
    });
    return () => {
      active = false;
    };
  }, []);

  const visible = templates.filter((entry) => {
    const matchesKind = filter === "all" || entry.kind === filter;
    const matchesSource =
      sourceFilter === "all" ||
      (sourceFilter === "local" && entry.is_imported) ||
      (sourceFilter === "slidescarnival" && entry.source_provider === "slidescarnival") ||
      (sourceFilter === "homun" && !entry.is_imported && entry.source_provider !== "slidescarnival");
    const haystack = [
      entry.name,
      entry.description,
      entry.id,
      entry.provider,
      entry.source_provider,
      entry.design_template,
      entry.design_theme,
      entry.design_profile,
      ...(entry.selection_notes ?? []),
      ...entry.tags,
      ...entry.use_cases,
      ...entry.audience,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const needle = query.trim().toLowerCase();
    return matchesKind && matchesSource && (!needle || haystack.includes(needle));
  });

  async function refreshTemplates() {
    const catalog = await coreBridge.templateCatalog();
    setTemplates(catalog.templates);
  }

  async function importPptxTemplate(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImportError(null);
    const sourcePath = fileLocalPathFromBridge(file) || (file as File & { path?: string }).path || "";
    if (!sourcePath) {
      setImportError("Import PPTX is available in the desktop app for local files.");
      return;
    }
    const name = file.name.replace(/\.(pptx|potx)$/i, "");
    setImporting(true);
    try {
      await coreBridge.importPptxTemplate({
        source_path: sourcePath,
        name,
        source_provider: "user_upload",
        attribution_required: false,
        redistribution_policy: "owned_by_user",
        tags: ["imported", "pptx"],
      });
      await refreshTemplates();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not import PPTX template.");
    } finally {
      setImporting(false);
    }
  }

  async function useTemplate(entry: TemplateCatalogEntry) {
    setImportError(null);
    setStartingTemplateId(entry.id);
    try {
      const attachment = entry.is_imported
        ? await coreBridge
            .templateSourceAttachment(entry.id)
            .then((source) => ({
              localPath: source.local_path,
              displayName: source.display_name,
              mimeType: source.mime_type,
              sizeBytes: source.size_bytes,
            }))
        : undefined;
      await host.startTemplateWorkflow({ template: entry, attachment });
      setSelectedTemplate(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not start the template workflow.");
    } finally {
      setStartingTemplateId(null);
    }
  }

  return (
    <section className="template-gallery presentation-template-workspace" aria-labelledby="template-gallery-title">
      <header className="template-gallery-header">
        <div>
          <p className="eyebrow">{t("presentations:templatesEyebrow")}</p>
          <h3 id="template-gallery-title">{t("presentations:templatesTitle")}</h3>
          <p className="template-gallery-status">
            {t("presentations:templatesCount", { visible: visible.length, total: templates.length })}
          </p>
        </div>
        <div className="template-gallery-controls">
          <label className="auto-btn template-import-button">
            <Upload size={14} aria-hidden />
            {importing ? t("presentations:importing") : t("presentations:importPptx")}
            <input
              type="file"
              accept=".pptx,.potx,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.ms-powerpoint.template.macroEnabled.12"
              onChange={(event) => void importPptxTemplate(event)}
              disabled={importing}
            />
          </label>
          <div className="template-gallery-tabs" role="tablist" aria-label={t("presentations:templatesTitle")}>
            {(["all", "presentation", "document"] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={filter === key ? "active" : ""}
                onClick={() => setFilter(key)}
              >
                {t(`presentations:filter_${key}`)}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="template-gallery-toolbar">
        <label className="template-search">
          <Search size={14} aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("presentations:searchPlaceholder")}
          />
        </label>
        <div className="template-source-tabs" aria-label="Template source">
          {(["all", "local", "slidescarnival", "homun"] as const).map((key) => (
            <button
              key={key}
              type="button"
              className={sourceFilter === key ? "active" : ""}
              onClick={() => setSourceFilter(key)}
            >
              {t(`presentations:source_${key}`)}
            </button>
          ))}
        </div>
      </div>
      {importError && <p className="template-import-error">{importError}</p>}

      {visible.length === 0 ? (
        <div className="template-empty">
          <Presentation size={22} aria-hidden />
          <strong>{t("presentations:noTemplatesTitle")}</strong>
          <span>{t("presentations:noTemplatesBody")}</span>
        </div>
      ) : (
        <div className="template-gallery-grid">
          {visible.map((entry) => {
            const selectionNotes = entry.selection_notes ?? [];
            const sourceBadges = templateSourceBadges(entry);
            const starting = startingTemplateId === entry.id;
            return (
              <article className="template-card" key={entry.id}>
                <button
                  type="button"
                  className="template-card-preview-button"
                  onClick={() => setSelectedTemplate(entry)}
                  aria-label={t("presentations:openTemplateDetails", { name: entry.name })}
                >
                  <TemplateCardPreview entry={entry} />
                </button>
                <div className="template-card-body">
                  <div className="template-card-title-row">
                    <h4>{entry.name}</h4>
                    <span>{entry.kind === "presentation" ? "PPTX" : "DOCX"}</span>
                  </div>
                  <p>{entry.description}</p>
                  {sourceBadges.length > 0 && (
                    <div className="template-card-source">
                      {sourceBadges.map((badge) => (
                        <span key={badge}>{badge}</span>
                      ))}
                    </div>
                  )}
                  {selectionNotes.length > 0 && (
                    <div className="template-card-fit" aria-label="Template selection notes">
                      {selectionNotes.slice(0, 2).map((note) => (
                        <span key={note}>{note}</span>
                      ))}
                    </div>
                  )}
                  <div className="template-card-meta">
                    {[entry.design_theme, entry.design_profile, ...entry.design_components.slice(0, 2)]
                      .filter(Boolean)
                      .map((item) => (
                        <span key={item}>{String(item).replaceAll("_", " ")}</span>
                      ))}
                  </div>
                </div>
                <button
                  type="button"
                  className="template-use"
                  onClick={() => void useTemplate(entry)}
                  title={t("presentations:useTemplate")}
                  disabled={Boolean(startingTemplateId)}
                >
                  <Presentation size={14} aria-hidden />
                  {starting ? t("presentations:starting") : t("presentations:useTemplate")}
                </button>
              </article>
            );
          })}
        </div>
      )}
      {selectedTemplate && (
        <TemplateDetailModal
          entry={selectedTemplate}
          busy={startingTemplateId === selectedTemplate.id}
          onClose={() => setSelectedTemplate(null)}
          onUse={() => void useTemplate(selectedTemplate)}
        />
      )}
    </section>
  );
}

function TemplateDetailModal({
  entry,
  busy,
  onClose,
  onUse,
}: {
  entry: TemplateCatalogEntry;
  busy: boolean;
  onClose: () => void;
  onUse: () => void;
}) {
  const { t } = useTranslation();
  const sourceBadges = templateSourceBadges(entry);
  const chips = [...entry.use_cases, ...entry.audience].slice(0, 6);
  return (
    <div className="template-detail-overlay" role="dialog" aria-modal="true" aria-labelledby="template-detail-title">
      <div className="template-detail-scrim" onClick={onClose} />
      <div className="template-detail-modal">
        <header className="template-detail-head">
          <div>
            <p className="eyebrow">{t("presentations:templateInfo")}</p>
            <h3 id="template-detail-title">{entry.name}</h3>
          </div>
          <button type="button" className="set-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="template-detail-summary">
          <div>
            <p>{entry.description}</p>
            <div className="template-card-source">
              {sourceBadges.map((badge) => (
                <span key={badge}>{badge}</span>
              ))}
            </div>
            <div className="template-card-meta">
              {[...chips, entry.design_theme, entry.design_profile]
                .filter(Boolean)
                .map((item) => (
                  <span key={String(item)}>{String(item).replaceAll("_", " ")}</span>
                ))}
            </div>
          </div>
          <button
            type="button"
            className="primary-btn template-detail-use"
            onClick={onUse}
            disabled={busy}
          >
            {busy ? t("presentations:starting") : t("presentations:useTemplate")}
          </button>
        </div>
        <div className="template-detail-preview">
          <TemplateCardPreview entry={entry} />
        </div>
        <div className="template-detail-strip" aria-label="Template slides">
          {entry.layout_archetypes.slice(0, 5).map((layout, index) => (
            <button type="button" className={index === 0 ? "active" : ""} key={layout}>
              <TemplateCardPreview entry={{ ...entry, layout_archetypes: [layout] }} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function templateSourceBadges(entry: TemplateCatalogEntry) {
  const badges: string[] = [];
  if (entry.is_imported) badges.push("Local");
  if (entry.source_provider === "slidescarnival") {
    badges.push("SlidesCarnival");
  } else if (entry.source_provider) {
    badges.push(entry.source_provider.replaceAll("_", " "));
  }
  if (entry.attribution_required) badges.push("Attribution required");
  return badges;
}

function TemplateCardPreview({ entry }: { entry: TemplateCatalogEntry }) {
  const canRenderBuiltin = entry.preview_ref?.startsWith("builtin:template-preview/");
  const canRenderImage = entry.preview_ref
    ? /^(https?:\/\/|\/api\/templates\/preview|template-pack:\/\/)/.test(entry.preview_ref)
    : false;
  const imageSrc = entry.preview_ref
    ? coreBridge.templatePreviewUrl(entry.preview_ref)
    : "";

  if (canRenderImage) {
    return (
      <div className="template-card-preview image-preview">
        <img src={imageSrc} alt="" loading="lazy" />
      </div>
    );
  }

  if (!canRenderBuiltin) {
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

  const theme = templateThemeClass(entry.design_theme);
  const layouts = entry.layout_archetypes.slice(0, entry.kind === "presentation" ? 4 : 5);

  return (
    <div className={`template-card-preview ${theme}`}>
      <div className="template-preview-chrome">
        <span />
        <span />
        <span />
      </div>
      <div className="template-preview-canvas">
        <div className="template-preview-header">
          {entry.kind === "presentation" ? (
            <Presentation size={15} aria-hidden />
          ) : (
            <FileText size={15} aria-hidden />
          )}
          <strong>{entry.name}</strong>
        </div>
        <div className="template-preview-title">{entry.design_template.replaceAll("_", " ")}</div>
        <div className="template-preview-blocks">
          {layouts.map((layout, index) => (
            <div className={`template-preview-block block-${index % 4}`} key={`${entry.id}-${layout}`}>
              <span>{layout}</span>
            </div>
          ))}
        </div>
        <div className="template-preview-components">
          {entry.design_components.slice(0, 3).map((component) => (
            <i key={component}>{component.replaceAll("_", " ")}</i>
          ))}
        </div>
      </div>
    </div>
  );
}

function templateThemeClass(theme: string | null) {
  switch (theme) {
    case "high_contrast":
      return "theme-high-contrast";
    case "minimal_mono":
      return "theme-minimal-mono";
    case "warm_editorial":
      return "theme-warm-editorial";
    case "soft_gradient":
      return "theme-soft-gradient";
    case "clean_corporate":
    default:
      return "theme-clean-corporate";
  }
}
