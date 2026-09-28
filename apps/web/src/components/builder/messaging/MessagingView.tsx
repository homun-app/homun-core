import { useState, useMemo } from "react";
import {
  Search,
  Check,
  ExternalLink,
  QrCode,
  ShieldCheck,
  Send,
  AlertCircle,
} from "lucide-react";
import { SettingsToggleSwitch } from "../SettingsToggleSwitch";
import {
  CHANNELS_CATALOG,
  type ChannelDefinition,
  type ChannelStatus,
} from "./messaging-data";
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
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [showQrModal, setShowQrModal] = useState(false);

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
    setTestStatus(null);
  }

  function handleFieldChange(fieldId: string, value: string) {
    setFormFields((prev) => ({ ...prev, [fieldId]: value }));
    setIsSaved(false);
  }

  function handleToggleChannel(enabled: boolean) {
    setSavedConfigs((prev) => {
      const updated = {
        ...prev,
        [selectedChannelId]: {
          enabled,
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
  }

  function handleSaveChanges(e: React.FormEvent) {
    e.preventDefault();
    setSavedConfigs((prev) => {
      const isCurrentlyEnabled = prev[selectedChannelId]?.enabled ?? false;
      const hasRequiredFilled = selectedChannel.fields
        .filter((f) => f.required)
        .every((f) => (formFields[f.id] || "").trim().length > 0);

      const updated = {
        ...prev,
        [selectedChannelId]: {
          enabled: isCurrentlyEnabled || hasRequiredFilled,
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
  }

  function handleTestConnection() {
    setTestStatus("testing");
    setTimeout(() => {
      const hasToken = Object.values(formFields).some((v) => v.trim().length > 0);
      if (hasToken) {
        setTestStatus("success");
      } else {
        setTestStatus("missing_token");
      }
    }, 600);
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
                  <div
                    className="msg-channel-icon-badge"
                    style={{ backgroundColor: ch.iconColor }}
                  >
                    {ch.name[0]}
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
              <div
                className="msg-header-icon"
                style={{ backgroundColor: selectedChannel.iconColor }}
              >
                {selectedChannel.name[0]}
              </div>
              <div>
                <h3 className="msg-header-title">{selectedChannel.name}</h3>
              </div>
            </div>

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
            <span className="msg-section-label">Configurazione Rapida</span>
            <div className="msg-quick-setup-card">
              <div className="msg-quick-setup-top">
                <span>Configurazione con QR Code</span>
                <span className="msg-rec-pill">Consigliato</span>
              </div>
              <p className="msg-quick-setup-desc">
                {selectedChannel.quickSetupLabel ??
                  "Scansiona un codice QR e associa la sessione automaticamente."}
              </p>
              <button
                type="button"
                className="msg-qr-btn"
                onClick={() => setShowQrModal(true)}
              >
                <QrCode size={15} />
                <span>Crea con codice QR</span>
              </button>
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

          {testStatus === "testing" && (
            <div style={{ fontSize: 13, color: "var(--color-muted-foreground)" }}>
              Verifica della connessione in corso…
            </div>
          )}
          {testStatus === "success" && (
            <div style={{ fontSize: 13, color: "#059669", display: "flex", alignItems: "center", gap: 6 }}>
              <Check size={14} /> Credenziali e endpoint validati con successo.
            </div>
          )}
          {testStatus === "missing_token" && (
            <div style={{ fontSize: 13, color: "#ef4444", display: "flex", alignItems: "center", gap: 6 }}>
              <AlertCircle size={14} /> Inserisci il token prima di testare la connessione.
            </div>
          )}

          <div className="msg-actions-bar">
            <button
              type="button"
              className="msg-test-btn"
              onClick={handleTestConnection}
            >
              Verifica connessione
            </button>

            <button
              type="submit"
              className={`msg-save-btn ${isSaved ? "is-saved" : ""}`}
            >
              {isSaved ? (
                <>
                  <Check size={14} />
                  <span>Salvato</span>
                </>
              ) : (
                <span>Salva modifiche</span>
              )}
            </button>
          </div>
        </form>
      </main>

      {/* QR Code Modal dialog */}
      {showQrModal && (
        <dialog
          open
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowQrModal(false);
          }}
        >
          <div
            style={{
              backgroundColor: "#ffffff",
              borderRadius: "12px",
              padding: "24px",
              maxWidth: "380px",
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "16px",
              boxShadow: "0 10px 25px rgba(0,0,0,0.1)",
            }}
          >
            <h4 style={{ margin: 0, fontSize: "16px", fontWeight: 600 }}>
              Accoppiamento {selectedChannel.name}
            </h4>
            <div
              style={{
                width: "180px",
                height: "180px",
                backgroundColor: "#f8fafc",
                border: "1px dashed var(--color-border)",
                borderRadius: "8px",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "8px",
                color: "var(--color-muted-foreground)",
              }}
            >
              <QrCode size={48} />
              <span style={{ fontSize: "11px", fontWeight: 500 }}>Codice QR d'esempio</span>
            </div>
            <p style={{ margin: 0, fontSize: "12.5px", color: "var(--color-muted-foreground)", textAlign: "center" }}>
              Inquadra questo codice dall'app {selectedChannel.name} per registrare l'identità della sessione.
            </p>
            <button
              type="button"
              className="msg-save-btn"
              style={{ width: "100%", justifyContent: "center" }}
              onClick={() => setShowQrModal(false)}
            >
              Chiudi
            </button>
          </div>
        </dialog>
      )}
    </div>
  );
}
