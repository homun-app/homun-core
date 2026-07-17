import { useTranslation } from "react-i18next";
import type { BrandKit } from "../lib/coreBridge";

/** Compact header pill standing in for the old permanent brand rail: brand kit is
 *  set-once config, so it only needs a glanceable summary (logo/mark + name + the
 *  3 brand colours) plus an entry point into the BrandDrawer for editing. */
export function BrandChip({ kit, onEdit }: { kit: BrandKit; onEdit: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="brand-chip"
      onClick={onEdit}
      title={t("presentations:editBrand")}
    >
      {kit.logo_data_url ? (
        <img className="brand-chip-logo" src={kit.logo_data_url} alt="" />
      ) : (
        <span className="brand-chip-mark" style={{ background: kit.primary_color }} />
      )}
      <span className="brand-chip-name">{kit.organization || t("presentations:brandChipFallback")}</span>
      <span className="brand-chip-dots">
        {[kit.primary_color, kit.secondary_color, kit.accent_color].map((c, i) => (
          <i key={i} style={{ background: c }} />
        ))}
      </span>
    </button>
  );
}
