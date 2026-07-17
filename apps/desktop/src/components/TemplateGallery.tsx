import { type ChangeEvent, type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, Loader2, Presentation, Search, Trash2, Upload } from "lucide-react";
import { coreBridge, type BrandKit, type TemplateCatalogEntry } from "../lib/coreBridge";
import { EmptyState } from "./StateViews";
import { fileLocalPathFromBridge } from "../lib/gatewayConfig";
import type { PluginHost } from "../plugins/registry";
import { TemplateCard, TemplateLivePreview, TemplateRasterOrContractPreview } from "./TemplateCard";
import {
  TEMPLATE_CATEGORY_ORDER,
  categoryLabelKey,
  templateDisplayDescription,
  templateDisplayName,
} from "./presentationsShared";

const TEMPLATE_SOURCE_LINKS = [
  {
    name: "SlidesCarnival",
    url: "https://www.slidescarnival.com/",
    descriptionKey: "presentations:sourceSlidesCarnivalBody",
    tags: ["free", "education", "business"],
  },
  {
    name: "Microsoft Create",
    url: "https://create.microsoft.com/en-us/templates/presentations",
    descriptionKey: "presentations:sourceMicrosoftBody",
    tags: ["pptx", "office", "business"],
  },
  {
    name: "Slidesgo",
    url: "https://slidesgo.com/",
    descriptionKey: "presentations:sourceSlidesgoBody",
    tags: ["free", "themes", "visual"],
  },
  {
    name: "Envato Elements",
    url: "https://elements.envato.com/presentation-templates",
    descriptionKey: "presentations:sourceEnvatoBody",
    tags: ["paid", "premium", "commercial"],
  },
] as const;

/** The full-width template catalog: purpose tabs (S1b) replace the old
 *  format/source tabs, cards are full-bleed (TemplateCard), and the brand
 *  chip is handed in from BrandKitPanel so it can sit in this header. */
export function TemplateCatalogGallery({
  host,
  brandKit,
  brandChip,
}: {
  host: PluginHost;
  brandKit: BrandKit;
  brandChip: ReactNode;
}) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<TemplateCatalogEntry[]>([]);
  const [query, setQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string>("all");
  const [importing, setImporting] = useState(false);
  const [importingName, setImportingName] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateCatalogEntry | null>(null);
  const [startingTemplateId, setStartingTemplateId] = useState<string | null>(null);
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void coreBridge.templateCatalog().then((catalog) => {
      if (active) setTemplates(catalog.templates);
    });
    return () => {
      active = false;
    };
  }, []);

  // Purpose tabs (S1b): built from the whitelist order but filtered down to
  // categories actually present, so a thin/partial catalog never shows dead tabs.
  const presentCategories = new Set(templates.map((entry) => entry.category));
  const categoryTabs: string[] = [
    "all",
    ...TEMPLATE_CATEGORY_ORDER.filter((category) => presentCategories.has(category)),
  ];
  // Stable dependency for the reset effect below: a Set is a new object every
  // render, so depend on its sorted member list instead (only changes when the
  // actual set of present categories changes, e.g. the only pack of the active
  // tab got deleted).
  const presentCategoriesKey = Array.from(presentCategories).sort().join(",");

  // If the active tab's last remaining pack is deleted (or the catalog reloads
  // without it), the tab silently disappears from categoryTabs while
  // activeCategory still points at it, filtering `visible` to nothing with no
  // active tab highlighted — fall back to "all".
  useEffect(() => {
    if (activeCategory !== "all" && !presentCategories.has(activeCategory)) {
      setActiveCategory("all");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presentCategoriesKey, activeCategory]);

  const visible = templates.filter((entry) => {
    const matchesCategory = activeCategory === "all" || entry.category === activeCategory;
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
    return matchesCategory && (!needle || haystack.includes(needle));
  });

  // Global in-flight guard shared across all cards (see TemplateCard `disabled`).
  const anyBusy = Boolean(startingTemplateId) || Boolean(deletingTemplateId);

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
    setImportingName(name);
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
      setImportingName(null);
    }
  }

  async function deleteTemplate(entry: TemplateCatalogEntry) {
    if (!entry.is_imported) return;
    setImportError(null);
    setDeletingTemplateId(entry.id);
    try {
      const catalog = await coreBridge.deleteTemplate(entry.id);
      setTemplates(catalog.templates);
      if (selectedTemplate?.id === entry.id) setSelectedTemplate(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Could not remove the template.");
    } finally {
      setDeletingTemplateId(null);
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
          {brandChip}
          <TemplateSourceDirectory />
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
        <div className="template-gallery-tabs" role="tablist" aria-label={t("presentations:templatesTitle")}>
          {categoryTabs.map((category) => (
            <button
              key={category}
              type="button"
              className={activeCategory === category ? "active" : ""}
              onClick={() => setActiveCategory(category)}
            >
              {category === "all" ? t("presentations:filter_all") : t(categoryLabelKey(category))}
            </button>
          ))}
        </div>
      </div>
      {importError && <p className="template-import-error">{importError}</p>}

      {visible.length === 0 && !importingName ? (
        <EmptyState
          icon={<Presentation size={22} aria-hidden />}
          title={t("presentations:noTemplatesTitle")}
          description={t("presentations:noTemplatesBody")}
          card
        />
      ) : (
        <div className="template-gallery-grid">
          {importingName && <TemplateImportingCard name={importingName} />}
          {visible.map((entry) => (
            <TemplateCard
              key={entry.id}
              entry={entry}
              brandKit={brandKit}
              starting={startingTemplateId === entry.id}
              deleting={deletingTemplateId === entry.id}
              // Any in-flight use/delete disables Use/Remove on every card:
              // the workflow starters aren't re-entrant, so this prevents two
              // cards racing a startTemplateWorkflow into concurrent threads.
              disabled={anyBusy}
              onOpen={() => setSelectedTemplate(entry)}
              onUse={() => void useTemplate(entry)}
              onDelete={() => void deleteTemplate(entry)}
            />
          ))}
        </div>
      )}
      {selectedTemplate && (
        <TemplateDetailModal
          entry={selectedTemplate}
          brandKit={brandKit}
          busy={startingTemplateId === selectedTemplate.id}
          deleting={deletingTemplateId === selectedTemplate.id}
          busyGlobal={anyBusy}
          onClose={() => setSelectedTemplate(null)}
          onUse={() => void useTemplate(selectedTemplate)}
          onDelete={() => void deleteTemplate(selectedTemplate)}
        />
      )}
    </section>
  );
}

/** Demoted per S1b: external providers (SlidesCarnival etc.) are a "still can't
 *  find it?" escape hatch, not cards competing with the installed catalog for
 *  the user's first glance — collapsed behind a small disclosure next to
 *  Import PPTX instead of a dedicated section under the grid. */
function TemplateSourceDirectory() {
  const { t } = useTranslation();
  return (
    <details className="template-source-directory">
      <summary>
        <ExternalLink size={13} aria-hidden />
        {t("presentations:sourceDirectoryTitle")}
      </summary>
      <div className="template-source-directory-panel">
        <p>{t("presentations:sourceDirectoryBody")}</p>
        <div className="template-source-directory-list">
          {TEMPLATE_SOURCE_LINKS.map((source) => (
            <a href={source.url} target="_blank" rel="noreferrer" className="template-source-link" key={source.name}>
              <span>
                <strong>{source.name}</strong>
                <small>{t(source.descriptionKey)}</small>
              </span>
              <span className="template-source-link-tags">
                {source.tags.slice(0, 2).map((tag) => (
                  <i key={tag}>{tag}</i>
                ))}
              </span>
              <ExternalLink size={13} aria-hidden />
            </a>
          ))}
        </div>
      </div>
    </details>
  );
}

function TemplateImportingCard({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <article className="tcard tcard-pending" aria-live="polite">
      <div className="tcard-preview">
        <div className="template-card-preview template-preview-loading">
          <div className="template-preview-shimmer" />
          <div className="template-preview-loading-lines">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
      <div className="tcard-scrim">
        <div className="tcard-title-row">
          <h4>{name}</h4>
          <span className="tcard-badge">PPTX</span>
        </div>
        <p className="tcard-status">
          <Loader2 size={13} className="composer-spin" aria-hidden />
          {t("presentations:importing")}
        </p>
      </div>
    </article>
  );
}

function TemplateDetailModal({
  entry,
  brandKit,
  busy,
  deleting,
  busyGlobal,
  onClose,
  onUse,
  onDelete,
}: {
  entry: TemplateCatalogEntry;
  brandKit: BrandKit;
  busy: boolean;
  deleting: boolean;
  // Global in-flight guard (see `anyBusy` in TemplateCatalogGallery / TemplateCard):
  // without this the modal's own Use/Remove stay enabled while a DIFFERENT card's
  // startTemplateWorkflow is in flight, letting two concurrent calls clobber
  // startingTemplateId.
  busyGlobal: boolean;
  onClose: () => void;
  onUse: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const selectionNotes = entry.selection_notes ?? [];
  const sourceBadges = templateSourceBadges(entry);
  const chips = [...entry.use_cases, ...entry.audience].slice(0, 6);
  return (
    <div className="template-detail-overlay" role="dialog" aria-modal="true" aria-labelledby="template-detail-title">
      <div className="template-detail-scrim" onClick={onClose} />
      <div className="template-detail-modal">
        <header className="template-detail-head">
          <div>
            <p className="eyebrow">{t("presentations:templateInfo")}</p>
            <h3 id="template-detail-title">{templateDisplayName(entry, i18n.language)}</h3>
          </div>
          <button type="button" className="set-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="template-detail-summary">
          <div>
            <p>{templateDisplayDescription(entry, i18n.language)}</p>
            {selectionNotes.length > 0 && (
              <div className="template-card-fit" aria-label="Template selection notes">
                {selectionNotes.map((note) => (
                  <span key={note}>{note}</span>
                ))}
              </div>
            )}
            {entry.intake_questions.length > 0 && (
              <div className="template-detail-questions">
                <p className="eyebrow">{t("presentations:templateQuestionsEyebrow")}</p>
                <ul>
                  {entry.intake_questions.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              </div>
            )}
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
            disabled={busy || deleting || busyGlobal}
          >
            {busy ? t("presentations:starting") : t("presentations:useTemplate")}
          </button>
          {entry.is_imported && (
            <button
              type="button"
              className="auto-btn template-detail-remove"
              onClick={onDelete}
              disabled={busy || deleting || busyGlobal}
            >
              <Trash2 size={14} aria-hidden />
              {deleting ? t("presentations:removing") : t("presentations:removeTemplate")}
            </button>
          )}
        </div>
        <div className="template-detail-preview">
          {entry.preview_html_ref ? (
            <TemplateLivePreview entry={entry} interactive brandKit={brandKit} />
          ) : (
            <TemplateRasterOrContractPreview entry={entry} />
          )}
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
