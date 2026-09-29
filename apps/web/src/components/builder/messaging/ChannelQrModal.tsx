import { useState, useEffect, useRef, useCallback } from "react";
import QRCode from "qrcode";
import {
  ExternalLink,
  Check,
  AlertCircle,
  Loader2,
  X,
  RefreshCw,
  Sparkles,
  Send,
  QrCode,
  Bot,
} from "lucide-react";
import { ChannelBrandIcon } from "./ChannelBrandIcon";
import {
  testEngineChannelPlatform,
  startTelegramOnboarding,
  getTelegramOnboardingStatus,
  applyTelegramOnboarding,
  cancelTelegramOnboarding,
} from "../../../lib/engine-channels-client";

export interface ChannelQrModalProps {
  isOpen: boolean;
  onClose: () => void;
  channelId: string;
  channelName: string;
  currentFields: Record<string, string>;
  initialTab?: "homun_custom" | "quick_qr";
  onSaveTokenAndFields: (fields: Record<string, string>) => Promise<void>;
}

export function ChannelQrModal({
  isOpen,
  onClose,
  channelId,
  channelName,
  currentFields,
  initialTab = "quick_qr",
  onSaveTokenAndFields,
}: ChannelQrModalProps) {
  const [activeTab, setActiveTab] = useState<"homun_custom" | "quick_qr">(initialTab);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deepLink, setDeepLink] = useState<string | null>(null);
  const [pairingId, setPairingId] = useState<string | null>(null);
  const [onboardingPhase, setOnboardingPhase] = useState<"idle" | "waiting" | "ready" | "applied">("idle");
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [isVerifyingManual, setIsVerifyingManual] = useState(false);

  const pairingIdRef = useRef<string | null>(null);
  pairingIdRef.current = pairingId;

  // Helper to generate QR code data URL
  async function generateQr(link: string): Promise<string> {
    return QRCode.toDataURL(link, {
      width: 240,
      margin: 1,
      color: { dark: "#0f172a", light: "#ffffff" },
    });
  }

  // Start automated Telegram bot creation session
  const initTelegramOnboarding = useCallback(async () => {
    setLoading(true);
    setError(null);
    setQrDataUrl(null);
    setOnboardingPhase("waiting");

    try {
      const res = await startTelegramOnboarding("Homun Agent");
      setPairingId(res.pairing_id);
      setDeepLink(res.deep_link);
      const qr = await generateQr(res.qr_payload || res.deep_link);
      setQrDataUrl(qr);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setOnboardingPhase("idle");
      setDeepLink(null);
      setQrDataUrl(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Sync activeTab when modal opens
  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab);
    }
  }, [isOpen, initialTab]);

  // Initialize modal state on open or tab change
  useEffect(() => {
    if (!isOpen) {
      if (pairingIdRef.current) {
        void cancelTelegramOnboarding(pairingIdRef.current);
      }
      setQrDataUrl(null);
      setError(null);
      setPairingId(null);
      setDeepLink(null);
      setOnboardingPhase("idle");
      setBotUsername(null);
      setOwnerUserId(null);
      setTokenInput("");
      return;
    }

    if (channelId === "telegram") {
      const existingToken = (currentFields["bot_token"] || "").trim();
      if (existingToken) {
        // User already has a token: verify and display existing bot
        setLoading(true);
        void (async () => {
          try {
            const res = await testEngineChannelPlatform("telegram", { bot_token: existingToken });
            if (res.ok) {
              const match = res.message.match(/@([A-Za-z0-9_]+)/);
              const uname = match ? match[1] : null;
              setBotUsername(uname ?? null);
              const link = uname ? `https://t.me/${uname}?start=homun_pair` : "https://t.me/BotFather";
              setDeepLink(link);
              const qr = await generateQr(link);
              setQrDataUrl(qr);
              setOnboardingPhase("applied");
            }
          } catch {
            // Keep idle
          } finally {
            setLoading(false);
          }
        })();
      } else if (activeTab === "quick_qr") {
        void initTelegramOnboarding();
      }
    } else {
      setLoading(true);
      void (async () => {
        try {
          const link = `https://homun.app/pair/${channelId}`;
          setDeepLink(link);
          const qr = await generateQr(link);
          setQrDataUrl(qr);
        } catch (err: unknown) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      })();
    }
  }, [isOpen, channelId, activeTab, currentFields, initTelegramOnboarding]);

  // Poll for Telegram onboarding readiness in quick_qr mode
  useEffect(() => {
    if (!isOpen || channelId !== "telegram" || activeTab !== "quick_qr" || onboardingPhase !== "waiting" || !pairingId) {
      return;
    }

    let isMounted = true;
    let timer: number | null = null;

    async function poll() {
      if (!pairingId || !isMounted) return;
      try {
        const res = await getTelegramOnboardingStatus(pairingId);
        if (!isMounted) return;

        if (res.status === "ready") {
          setOnboardingPhase("ready");
          setBotUsername(res.bot_username ?? null);
          setOwnerUserId(res.owner_user_id ?? null);

          // Apply to engine automatically
          try {
            const applied = await applyTelegramOnboarding(
              pairingId,
              res.owner_user_id ? [res.owner_user_id] : undefined,
            );
            if (applied.ok && isMounted) {
              setOnboardingPhase("applied");
              const fieldsToSave = applied.fields || {
                ...currentFields,
                allowed_user_ids: res.owner_user_id || "",
              };
              await onSaveTokenAndFields(fieldsToSave);
            }
          } catch (applyErr: unknown) {
            if (isMounted) setError(applyErr instanceof Error ? applyErr.message : String(applyErr));
          }
          return;
        }

        if (res.status === "expired") {
          if (isMounted) {
            setError("Sessione scaduta. Clicca Rigenera per riprovare.");
            setOnboardingPhase("idle");
          }
          return;
        }

        timer = window.setTimeout(() => void poll(), 2000);
      } catch {
        if (isMounted) {
          timer = window.setTimeout(() => void poll(), 2500);
        }
      }
    }

    timer = window.setTimeout(() => void poll(), 1500);

    return () => {
      isMounted = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [isOpen, channelId, activeTab, onboardingPhase, pairingId, currentFields, onSaveTokenAndFields]);

  // Handle manual token submission (Official Homun Bot flow)
  async function handleApplyCustomToken(e: React.FormEvent) {
    e.preventDefault();
    const token = tokenInput.trim();
    if (!token) return;

    setIsVerifyingManual(true);
    setError(null);
    try {
      const res = await testEngineChannelPlatform("telegram", { bot_token: token });
      if (!res.ok) {
        setError(res.message || "Token Telegram non valido.");
        setIsVerifyingManual(false);
        return;
      }

      await onSaveTokenAndFields({ ...currentFields, bot_token: token });

      const match = res.message.match(/@([A-Za-z0-9_]+)/);
      const uname = match ? match[1] : null;
      setBotUsername(uname ?? null);
      const link = uname ? `https://t.me/${uname}?start=homun_pair` : "https://t.me/BotFather";
      setDeepLink(link);
      const qr = await generateQr(link);
      setQrDataUrl(qr);
      setOnboardingPhase("applied");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsVerifyingManual(false);
    }
  }

  function handleSwitchTab(tab: "homun_custom" | "quick_qr") {
    setActiveTab(tab);
    setError(null);
    if (tab === "quick_qr" && !pairingId) {
      void initTelegramOnboarding();
    }
  }

  if (!isOpen) return null;

  return (
    <div
      className="msg-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Configurazione ${channelName}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="msg-modal-card" style={{ maxWidth: 440 }}>
        {/* Header */}
        <div className="msg-modal-header">
          <div className="msg-modal-title-wrap">
            <ChannelBrandIcon channelId={channelId} size={22} />
            <h4 className="msg-modal-title">
              {channelId === "telegram" ? "Configura Bot Telegram" : `Accoppiamento ${channelName}`}
            </h4>
          </div>
          <button
            type="button"
            className="msg-modal-close-btn"
            onClick={onClose}
            aria-label="Chiudi finestra"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tab switch for Telegram */}
        {channelId === "telegram" && (
          <div className="msg-modal-tabs">
            <button
              type="button"
              className={`msg-modal-tab-btn ${activeTab === "homun_custom" ? "is-active" : ""}`}
              onClick={() => handleSwitchTab("homun_custom")}
            >
              <Bot size={14} />
              <span>Bot Ufficiale Homun</span>
            </button>
            <button
              type="button"
              className={`msg-modal-tab-btn ${activeTab === "quick_qr" ? "is-active" : ""}`}
              onClick={() => handleSwitchTab("quick_qr")}
            >
              <QrCode size={14} />
              <span>Gateway Rapido (QR)</span>
            </button>
          </div>
        )}

        {/* TAB 1: Official Homun Bot Creation */}
        {channelId === "telegram" && activeTab === "homun_custom" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14, width: "100%" }}>
            {onboardingPhase !== "applied" ? (
              <>
                <p className="msg-modal-desc">
                  Crea un bot autentico con nome <strong>Homun</strong> e il tuo username dedicato. Sarà di tua esclusiva proprietà su Telegram senza intermediari.
                </p>

                <a
                  href="https://t.me/BotFather?start=newbot"
                  target="_blank"
                  rel="noreferrer noopener"
                  className="msg-open-botfather-btn"
                >
                  <Send size={15} />
                  <span>1. Apri @BotFather con /newbot</span>
                  <ExternalLink size={13} />
                </a>

                <div className="msg-steps-card">
                  <div className="msg-step-item">
                    <span className="msg-step-num">1</span>
                    <span>Assegna il nome che desideri (es. <strong>Homun</strong> o <strong>Mio Agente Homun</strong>).</span>
                  </div>
                  <div className="msg-step-item">
                    <span className="msg-step-num">2</span>
                    <span>Scegli uno username unico che finisca con <code>bot</code> (es. <strong><code>fabio_homun_bot</code></strong>).</span>
                  </div>
                  <div className="msg-step-item">
                    <span className="msg-step-num">3</span>
                    <span>Copia il token HTTP API che ti restituisce BotFather e incollalo qui:</span>
                  </div>
                </div>

                <form onSubmit={handleApplyCustomToken} className="msg-modal-token-form">
                  <input
                    type="password"
                    placeholder="Incolla il token (es. 123456789:ABCdefGhIJK...)"
                    className="msg-field-input"
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    autoComplete="off"
                  />
                  <button
                    type="submit"
                    disabled={isVerifyingManual || !tokenInput.trim()}
                    className="msg-save-btn"
                    style={{ width: "100%", justifyContent: "center", padding: "9px" }}
                  >
                    {isVerifyingManual ? (
                      <>
                        <Loader2 size={14} className="animate-spin" />
                        <span>Verifica token con Telegram…</span>
                      </>
                    ) : (
                      <>
                        <Sparkles size={14} />
                        <span>Verifica e Connetti Bot Homun</span>
                      </>
                    )}
                  </button>
                </form>
              </>
            ) : (
              /* Already connected Bot Homun */
              <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center", width: "100%" }}>
                {qrDataUrl && (
                  <div className="msg-modal-qr-box">
                    <img src={qrDataUrl} alt="QR Bot Homun" className="msg-modal-qr-img" />
                  </div>
                )}
                <div className="msg-modal-bot-badge" style={{ width: "100%" }}>
                  <Check size={16} className="text-emerald-600" />
                  <span>
                    Bot Homun connesso: <strong>@{botUsername || "homun_bot"}</strong>
                  </span>
                </div>
                <p className="msg-modal-desc">
                  Inquadra il codice QR con lo smartphone per iniziare subito a chattare con il tuo bot Homun su Telegram!
                </p>
                {deepLink && (
                  <a
                    href={deepLink}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="msg-open-botfather-btn"
                    style={{ textDecoration: "none", fontSize: 13 }}
                  >
                    <span>Apri chat con @{botUsername || "bot"}</span>
                    <ExternalLink size={13} />
                  </a>
                )}
              </div>
            )}
          </div>
        )}

        {/* TAB 2: Quick Gateway QR Onboarding */}
        {channelId === "telegram" && activeTab === "quick_qr" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center", width: "100%" }}>
            <div className="msg-modal-qr-box">
              {loading ? (
                <div className="msg-modal-qr-loading">
                  <Loader2 size={32} className="animate-spin text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Inizializzazione bot Gateway…</span>
                </div>
              ) : qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={`QR Code ${channelName}`}
                  className="msg-modal-qr-img"
                />
              ) : (
                <div className="msg-modal-qr-loading">
                  <AlertCircle size={28} className="text-destructive" />
                  <span className="text-xs text-destructive">Impossibile generare il QR</span>
                </div>
              )}
            </div>

            {onboardingPhase === "waiting" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "center", width: "100%" }}>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color: "#2563eb", background: "rgba(37,99,235,0.08)", padding: "4px 10px", borderRadius: 12, fontWeight: 500 }}>
                  <Loader2 size={12} className="animate-spin" />
                  <span>In attesa che tu prema <strong>Avvia</strong> su Telegram…</span>
                </div>
                <p className="msg-modal-desc" style={{ fontSize: 11.5 }}>
                  Genera una sessione gateway cloud di test. Su Telegram si aprirà il bot gestore Nous per assegnare il bot di prova. Per avere un bot ufficiale con nome Homun e username personalizzato, usa la scheda <strong>Bot Ufficiale Homun</strong>.
                </p>
              </div>
            )}

            {(onboardingPhase === "ready" || onboardingPhase === "applied") && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center", width: "100%" }}>
                <div className="msg-modal-bot-badge" style={{ width: "100%" }}>
                  <Check size={16} className="text-emerald-600" />
                  <span>
                    Bot pronto: <strong>@{botUsername || "homun_bot"}</strong>
                  </span>
                </div>
                {ownerUserId && (
                  <span style={{ fontSize: 12, color: "var(--color-muted-foreground)" }}>
                    Account proprietario autorizzato: <strong>{ownerUserId}</strong>
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Non-Telegram channels */}
        {channelId !== "telegram" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "center", width: "100%" }}>
            <div className="msg-modal-qr-box">
              {loading ? (
                <div className="msg-modal-qr-loading">
                  <Loader2 size={32} className="animate-spin text-muted-foreground" />
                  <span className="text-xs text-muted-foreground">Caricamento…</span>
                </div>
              ) : qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt={`QR Code ${channelName}`}
                  className="msg-modal-qr-img"
                />
              ) : (
                <div className="msg-modal-qr-loading">
                  <AlertCircle size={28} className="text-destructive" />
                  <span className="text-xs text-destructive">QR non disponibile</span>
                </div>
              )}
            </div>
            <p className="msg-modal-desc">
              Scansiona il codice QR per associare il canale {channelName} all&apos;agente Homun.
            </p>
          </div>
        )}

        {error && (
          <div className="msg-test-banner is-error" style={{ width: "100%", fontSize: 12 }}>
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}

        {/* Footer actions */}
        <div className="msg-modal-actions">
          {deepLink && activeTab === "quick_qr" && (
            <a
              href={deepLink}
              target="_blank"
              rel="noreferrer noopener"
              className="msg-test-btn"
              style={{ textDecoration: "none", fontSize: 12 }}
            >
              <span>Apri direttamente</span>
              <ExternalLink size={12} />
            </a>
          )}

          {channelId === "telegram" && activeTab === "quick_qr" && onboardingPhase !== "applied" && (
            <button
              type="button"
              className="msg-test-btn"
              onClick={initTelegramOnboarding}
              title="Crea nuovo QR"
            >
              <RefreshCw size={13} />
              <span>Rigenera</span>
            </button>
          )}

          <button
            type="button"
            className="msg-save-btn"
            onClick={onClose}
          >
            {onboardingPhase === "applied" ? "Fatto" : "Chiudi"}
          </button>
        </div>
      </div>
    </div>
  );
}
