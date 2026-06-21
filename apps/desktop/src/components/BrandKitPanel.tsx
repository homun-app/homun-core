import { type ChangeEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageIcon, Save } from "lucide-react";
import { coreBridge, type BrandKit } from "../lib/coreBridge";

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
export function BrandKitPanel() {
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
    <section className="brandkit" aria-labelledby="brandkit-title">
      <header className="learning-header">
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
            <input type="file" accept="image/*" onChange={onLogo} />
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
  );
}
