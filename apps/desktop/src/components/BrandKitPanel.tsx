import { useEffect, useState } from "react";
import { coreBridge, type BrandKit } from "../lib/coreBridge";
import type { PluginHost } from "../plugins/registry";
import { BrandChip } from "./BrandChip";
import { BrandDrawer } from "./BrandDrawer";
import { TemplateCatalogGallery } from "./TemplateGallery";
import { DEFAULT_KIT } from "./presentationsShared";

/** The Presentations plugin's panel: the persistent BRAND KIT (colours, fonts, logo)
 *  that the on-brand deck/document generators apply. Stored gateway-side.
 *  Thin compositor (S1b split): owns `kit`/`drawerOpen` state and wires the
 *  full-width TemplateCatalogGallery to the header chip + slide-in drawer. */
export function BrandKitPanel({ host }: { host: PluginHost }) {
  const [kit, setKit] = useState<BrandKit>(DEFAULT_KIT);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Kit state stays lifted here (not inside the drawer): the gallery needs
  // `brandKit` live for its recolor preview regardless of drawer open/closed.
  const [drawerOpen, setDrawerOpen] = useState(false);

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
    <div className="presentations-panel presentation-studio-v2">
      <TemplateCatalogGallery
        host={host}
        brandKit={kit}
        brandChip={<BrandChip kit={kit} onEdit={() => setDrawerOpen(true)} />}
      />
      <BrandDrawer
        open={drawerOpen}
        kit={kit}
        onChange={set}
        onSave={() => void save()}
        saving={saving}
        saved={saved}
        onClose={() => setDrawerOpen(false)}
      />
    </div>
  );
}
