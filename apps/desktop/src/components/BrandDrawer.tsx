import { type ChangeEvent, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ImageIcon, Save, Upload } from "lucide-react";
import type { BrandKit } from "../lib/coreBridge";

const COLOR_KEYS = ["primary_color", "secondary_color", "accent_color"] as const;

/** Brand kit is set-once config, not a permanent panel: this is the slide-in drawer
 *  the header chip (BrandChip) opens on demand. Same fields/behavior as the old
 *  always-visible rail — only the disposition changed. Scrim + Esc + click-outside
 *  all close it, matching the other modal/detail overlays in this file's family
 *  (TemplateDetailModal) for a consistent dismiss pattern. */
export function BrandDrawer({
  open,
  kit,
  onChange,
  onSave,
  saving,
  saved,
  onClose,
}: {
  open: boolean;
  kit: BrandKit;
  onChange: <K extends keyof BrandKit>(key: K, value: BrandKit[K]) => void;
  onSave: () => void;
  saving: boolean;
  saved: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
          onChange("logo_data_url", src);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        try {
          onChange("logo_data_url", canvas.toDataURL("image/png"));
        } catch {
          onChange("logo_data_url", src); // tainted canvas → keep the original
        }
      };
      img.onerror = () => onChange("logo_data_url", src);
      img.src = src;
    };
    reader.readAsDataURL(file);
  };

  return (
    <>
      <div
        className={`brand-drawer-scrim${open ? " open" : ""}`}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside
        className={`brand-drawer${open ? " open" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="brand-drawer-title"
        // The drawer stays mounted and is only slid off-screen via translateX, so
        // when closed its inputs would still be tab-reachable and AT-exposed.
        // `inert` (React 19 passes it straight to the DOM) removes focusability AND
        // AT exposure together — the real fix, superseding a manual aria-hidden.
        inert={!open}
      >
        <header className="brand-drawer-header">
          <h2 id="brand-drawer-title">{t("presentations:eyebrow")}</h2>
          <button type="button" className="set-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="brandkit-grid">
          <label className="brandkit-field">
            <span>{t("presentations:organization")}</span>
            <input
              value={kit.organization}
              onChange={(e) => onChange("organization", e.target.value)}
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
                  onChange={(e) => onChange(key, e.target.value)}
                />
                <input value={kit[key]} onChange={(e) => onChange(key, e.target.value)} />
              </div>
            </label>
          ))}

          <label className="brandkit-field">
            <span>{t("presentations:heading_font")}</span>
            <input
              value={kit.heading_font}
              onChange={(e) => onChange("heading_font", e.target.value)}
              placeholder="Inter"
            />
          </label>
          <label className="brandkit-field">
            <span>{t("presentations:body_font")}</span>
            <input
              value={kit.body_font}
              onChange={(e) => onChange("body_font", e.target.value)}
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
                <button
                  type="button"
                  className="auto-btn"
                  onClick={() => onChange("logo_data_url", "")}
                >
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
          <button className="auto-btn-accent" onClick={onSave} disabled={saving}>
            <Save size={14} aria-hidden /> {saved ? t("presentations:saved") : t("presentations:save")}
          </button>
        </div>
      </aside>
    </>
  );
}
