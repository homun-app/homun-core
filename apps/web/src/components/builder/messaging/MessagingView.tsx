import { useState, useMemo, useEffect, useCallback } from "react";
import {
  Search,
  Check,
  ExternalLink,
  QrCode,
  AlertCircle,
  Loader2,
  Send,
  Sparkles,
} from "lucide-react";
import { SettingsToggleSwitch } from "../SettingsToggleSwitch";
import {
  CHANNELS_CATALOG,
  type ChannelDefinition,
  type ChannelStatus,
} from "./messaging-data";
import { ChannelBrandIcon } from "./ChannelBrandIcon";
import { ChannelQrModal } from "./ChannelQrModal";
import {
  listEngineChannelPlatforms,
  updateEngineChannelPlatform,
  deleteEngineChannelPlatform,
  testEngineChannelPlatform,
} from "../../../lib/engine-channels-client";
import "./messaging-view.css";

type SavedChannelConfig = {
  enabled: boolean;
  fields: Record<string, string>;
};

export function MessagingView() {
  const [selectedChannelId, setSelectedChannelId] = useState("telegram");
  const [searchQuery, setSearchQuery] = useState("");
  const [savedConfigs, setSavedConfigs] = useState<Record<string, SavedChannelConfig>>(() => {
    try {
      const raw = localStorage.getItem("homun_messaging_channels_config");
      return raw ? JSON.parse(raw) : {
        telegram: { enabled: false, fields: {} },
      };
    } catch {
      return {};
    }
  });

  const [formFields, setFormFields] = useState<Record<string, string>>(() => {
    return savedConfigs[selectedChannelId]?.fields ?? {};
  });
  const [isSaved, setIsSaved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [testState, setTestState] = useState<{
    status: "idle" | "testing" | "success" | "error";
    message?: string;
  }>({ status: "idle" });
  const [showQrModal, setShowQrModal] = useState(false);
  const [qrModalTab, setQrModalTab] = useState<"homun_custom" | "quick_qr">("homun_custom");

  // Sync with real engine gateway platforms
  const loadEnginePlatforms = useCallback(async () => {
    try {
      const platforms = await listEngineChannelPlatforms();
      if (platforms && platforms.length > 0) {
        const merged: Record<string, SavedChannelConfig> = {};
        for (const p of platforms) {
          merged[p.id] = {
            enabled: p.enabled,
            fields: p.fields || {},
          };
        }
        setSavedConfigs((prev) => {
          const next = { ...prev, ...merged };
          try {
            localStorage.setItem("homun_messaging_channels_config", JSON.stringify(next));
          } catch {
            // ignore
          }
          return next;
        });
        if (merged[selectedChannelId]?.fields) {
          setFormFields(merged[selectedChannelId].fields);
        }
      }
    } catch {
      // Backend engine offline or unreachable, retain cached state
    }
  }, [selectedChannelId]);

  useEffect(() => {
    loadEnginePlatforms();
  }, [loadEnginePlatforms]);

  const selectedChannel = useMemo<ChannelDefinition>(() => {
    return (
      CHANNELS_CATALOG.find((c) => c.id === selectedChannelId) ??
      CHANNELS_CATALOG[0]!
    );
  }, [selectedChannelId]);

  function handleSelectChannel(id: string) {
    setSelectedChannelId(id);
    setFormFields(savedConfigs[id]?.fields ?? {});
    setIsSaved(false);
    setTestState({ status: "idle" });
  }

  function handleFieldChange(fieldId: string, value: string) {
    setFormFields((prev) => ({ ...prev, [fieldId]: value }));
    setIsSaved(false);
    if (testState.status !== "idle") {
      setTestState({ status: "idle" });
    }
  }

  async function handleToggleChannel(enabled: boolean) {
    const currentFields = formFields;
    setSavedConfigs((prev) => {
      const updated = {
        ...prev,
        [selectedChannelId]: {
          enabled,
          fields: currentFields,
        },
      };
      try {
        localStorage.setItem("homun_messaging_channels_config", JSON.stringify(updated));
      } catch {
        // ignore
      }
      return updated;
    });

    try {
      await updateEngineChannelPlatform(selectedChannelId, {
        enabled,
        fields: currentFields,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestState({ status: "error", message: `Salvataggio stato fallito: ${msg}` });
    }
  }

  async function handleDisconnectChannel() {
    try {
      await deleteEngineChannelPlatform(selectedChannelId);
      setSavedConfigs((prev) => {
        const next = { ...prev };
        delete next[selectedChannelId];
        try {
          localStorage.setItem("homun_messaging_channels_config", JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
      setFormFields({});
      setTestState({ status: "idle" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestState({ status: "error", message: `Rimozione canale fallita: ${msg}` });
    }
  }

  async function handleSaveChanges(e: React.FormEvent) {
    e.preventDefault();
    setIsSaving(true);
    const isCurrentlyEnabled = savedConfigs[selectedChannelId]?.enabled ?? false;
    const hasRequiredFilled = selectedChannel.fields
      .filter((f) => f.required)
      .every((f) => (formFields[f.id] || "").trim().length > 0);
    const newEnabled = isCurrentlyEnabled || hasRequiredFilled;

    try {
      await updateEngineChannelPlatform(selectedChannelId, {
        enabled: newEnabled,
        fields: formFields,
      });
      setSavedConfigs((prev) => {
        const updated = {
          ...prev,
          [selectedChannelId]: {
            enabled: newEnabled,
            fields: formFields,
          },
        };
        try {
          localStorage.setItem("homun_messaging_channels_config", JSON.stringify(updated));
        } catch {
          // ignore
        }
        return updated;
      });
      setIsSaved(true);
      setTimeout(() => setIsSaved(false), 2500);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestState({ status: "error", message: `Salvataggio fallito: ${msg}` });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleTestConnection() {
    setTestState({ status: "testing" });
    try {
      const res = await testEngineChannelPlatform(selectedChannelId, formFields);
      if (res.ok) {
        setTestState({ status: "success", message: res.message });
      } else {
        setTestState({ status: "error", message: res.message });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTestState({ status: "error", message: `Impossibile contattare il motore: ${msg}` });
    }
  }

  async function handleSaveTokenFromQr(newFields: Record<string, string>) {
    setFormFields(newFields);
    await updateEngineChannelPlatform(selectedChannelId, {
      enabled: true,
      fields: newFields,
    });
    setSavedConfigs((prev) => ({
      ...prev,
      [selectedChannelId]: {
        enabled: true,
        fields: newFields,
      },
    }));
  }

  const filteredChannels = useMemo(() => {
    if (!searchQuery.trim()) return CHANNELS_CATALOG;
    const q = searchQuery.toLowerCase().trim();
    return CHANNELS_CATALOG.filter(
      (c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)
    );
  }, [searchQuery]);

  const channelStatuses = useMemo<Record<string, ChannelStatus>>(() => {
    const map: Record<string, ChannelStatus> = {};
    for (const ch of CHANNELS_CATALOG) {
      const conf = savedConfigs[ch.id];
      if (conf?.enabled) {
        map[ch.id] = "active";
      } else if (conf?.fields && Object.values(conf.fields).some((v) => v.trim())) {
        map[ch.id] = "needs_setup";
      } else {
        map[ch.id] = "disabled";
      }
    }
    return map;
  }, [savedConfigs]);

  const currentStatus = channelStatuses[selectedChannel.id] ?? "disabled";

  return (
    <div className="msg-container" role="region" aria-label="Directory Canali e Messaggistica">
      {/* Left Sidebar: Channel List */}
      <aside className="msg-sidebar" aria-label="Elenco canali">
        <div className="msg-search-wrap">
          <Search size={14} className="msg-search-icon" />
          <input
            type="text"
            className="msg-search-input"
            placeholder="Cerca canale… (es. matrix)"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <nav className="msg-channel-list">
          {filteredChannels.map((ch) => {
            const status = channelStatuses[ch.id] ?? "disabled";
            const isSelected = ch.id === selectedChannelId;
            return (
              <button
                key={ch.id}
                type="button"
                className={`msg-channel-row ${isSelected ? "is-active" : ""}`}
                onClick={() => handleSelectChannel(ch.id)}
              >
                <div className="msg-channel-row-left">
                  <div className="msg-channel-icon-wrap">
                    <ChannelBrandIcon channelId={ch.id} size={18} />
                  </div>
                  <span className="msg-channel-name">{ch.name}</span>
                </div>

                <div
                  className={`msg-status-dot ${
                    status === "active"
                      ? "is-active"
                      : status === "needs_setup"
                      ? "is-needs-setup"
                      : ""
                  }`}
                  title={
                    status === "active"
                      ? "Attivo"
                      : status === "needs_setup"
                      ? "Richiede configurazione"
                      : "Disattivato"
                  }
                />
              </button>
            );
          })}
        </nav>
      </aside>

      {/* Right Main Pane: Channel Configuration */}
      <main className="msg-content">
        <header className="msg-header">
          <div className="msg-header-top">
            <div className="msg-header-title-row">
              <div className="msg-header-icon">
                <ChannelBrandIcon channelId={selectedChannel.id} size={32} />
              </div>
              <div>
                <h3 className="msg-header-title">{selectedChannel.name}</h3>
              </div>
            </div>

            {(savedConfigs[selectedChannel.id]?.enabled ||
              Object.values(savedConfigs[selectedChannel.id]?.fields ?? {}).some((v) => v.trim())) && (
              <button
                type="button"
                className="msg-test-btn msg-disconnect-btn"
                onClick={handleDisconnectChannel}
                title="Rimuove la configurazione salvata del canale dal motore"
              >
                Scollega
              </button>
            )}

            <SettingsToggleSwitch
              checked={savedConfigs[selectedChannel.id]?.enabled ?? false}
              onChange={handleToggleChannel}
              ariaLabel={`Abilita ${selectedChannel.name}`}
            />
          </div>

          <div className="msg-header-badges">
            {currentStatus === "active" ? (
              <span className="msg-badge is-ok">Attivo</span>
            ) : currentStatus === "needs_setup" ? (
              <span className="msg-badge is-warning">Richiede configurazione</span>
            ) : (
              <span className="msg-badge is-neutral">Disabilitato</span>
            )}
            <span className="msg-badge is-neutral">Gateway supervisione</span>
          </div>

          <p className="msg-subtitle">{selectedChannel.subtitle}</p>
        </header>

        {/* Quick Setup Block */}
        {selectedChannel.quickSetupAvailable && (
          <section className="msg-section">
            <span className="msg-section-label">Configurazione Rapida Bot</span>
            <div className="msg-quick-setup-card">
              <div className="msg-quick-setup-top">
                <Sparkles size={16} className="text-amber-500" />
                <span>Configurazione Istantanea Bot</span>
                <span className="msg-rec-pill">Consigliato</span>
              </div>
              <p className="msg-quick-setup-desc">
                Inquadra il codice QR con l'app di Telegram sul tuo telefono: il tuo bot dedicato verrà creato e collegato a Homun in automatico, senza configurazione manuale.
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="msg-qr-btn"
                  onClick={() => {
                    setQrModalTab("quick_qr");
                    setShowQrModal(true);
                  }}
                >
                  <QrCode size={14} />
                  <span>Connetti con Codice QR</span>
                </button>
                <button
                  type="button"
                  className="msg-test-btn"
                  onClick={() => {
                    setQrModalTab("homun_custom");
                    setShowQrModal(true);
                  }}
                >
                  <Send size={14} />
                  <span>Configura manualmente (BotFather)</span>
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Guide Block */}
        <section className="msg-section">
          <span className="msg-section-label">Come ottenere le credenziali</span>
          <p className="msg-guide-text">{selectedChannel.credentialsGuide}</p>
          {selectedChannel.guideUrl && (
            <a
              href={selectedChannel.guideUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="msg-guide-link"
            >
              <span>Apri la guida ufficiale alla configurazione</span>
              <ExternalLink size={12} />
            </a>
          )}
        </section>

        {/* Form Fields */}
        <form onSubmit={handleSaveChanges} className="msg-fields">
          <span className="msg-section-label">Credenziali e Parametri</span>

          {selectedChannel.fields.map((field) => (
            <div key={field.id} className="msg-field-row">
              <label htmlFor={`field-${field.id}`} className="msg-field-label">
                {field.label}
                {field.required && <span style={{ color: "#ef4444", marginLeft: 4 }}>*</span>}
              </label>

              <div className="msg-field-input-wrap">
                <input
                  id={`field-${field.id}`}
                  type={field.type}
                  className="msg-field-input"
                  placeholder={field.placeholder}
                  value={formFields[field.id] ?? ""}
                  onChange={(e) => handleFieldChange(field.id, e.target.value)}
                  autoComplete="off"
                />
              </div>

              {field.helpText && <span className="msg-field-help">{field.helpText}</span>}
            </div>
          ))}

          {testState.status === "testing" && (
            <div className="msg-test-banner is-testing">
              <Loader2 size={14} className="animate-spin" />
              <span>Verifica connessione e validazione token in corso…</span>
            </div>
          )}
          {testState.status === "success" && (
            <div className="msg-test-banner is-success">
              <Check size={14} />
              <span>{testState.message || "Credenziali e endpoint validati con successo dal motore."}</span>
            </div>
          )}
          {testState.status === "error" && (
            <div className="msg-test-banner is-error">
              <AlertCircle size={14} />
              <span>{testState.message || "Errore di connessione o token non valido."}</span>
            </div>
          )}

          <div className="msg-actions-bar">
            <button
              type="button"
              className="msg-test-btn"
              disabled={testState.status === "testing"}
              onClick={handleTestConnection}
            >
              {testState.status === "testing" ? (
                <>
                  <Loader2 size={13} className="animate-spin" />
                  <span>Verifica in corso…</span>
                </>
              ) : (
                <span>Verifica connessione</span>
              )}
            </button>

            <button
              type="submit"
              disabled={isSaving}
              className={`msg-save-btn ${isSaved ? "is-saved" : ""}`}
            >
              {isSaved ? (
                <>
                  <Check size={14} />
                  <span>Salvato</span>
                </>
              ) : isSaving ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  <span>Salvataggio…</span>
                </>
              ) : (
                <span>Salva modifiche</span>
              )}
            </button>
          </div>
        </form>
      </main>

      {/* Real QR Code Modal */}
      <ChannelQrModal
        isOpen={showQrModal}
        onClose={() => setShowQrModal(false)}
        channelId={selectedChannel.id}
        channelName={selectedChannel.name}
        currentFields={formFields}
        initialTab={qrModalTab}
        onSaveTokenAndFields={handleSaveTokenFromQr}
      />
    </div>
  );
}
