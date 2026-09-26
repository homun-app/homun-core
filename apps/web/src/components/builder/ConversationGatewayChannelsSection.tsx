/**
 * Gateway external channels management: Telegram, WhatsApp, Slack.
 * Compliant with NIST SP 800-63-4 pairing flow.
 */
import { useEffect, useState, useCallback } from "react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import {
  listGatewayPairings,
  requestGatewayPairing,
  approveGatewayPairing,
  declineGatewayPairing,
  revokeGatewayPairing,
  type GatewayPairingRequest,
} from "@/lib/engine-gateway-client";
import { listEngineAgents, type EngineAgentProfile } from "@/lib/engine-agents-client";
import {
  Send,
  Check,
  X,
  ShieldCheck,
  RefreshCw,
  KeyRound,
  Smartphone,
  MessageSquare,
  Hash,
  Info,
  Clock,
  ExternalLink,
  Bot,
  UserCheck,
} from "lucide-react";
import { SettingsToggleSwitch } from "./SettingsToggleSwitch";
import { SettingsCustomSelect } from "./SettingsCustomSelect";
import "./conversation-gateway-channels.css";

type ChannelTab = "telegram" | "whatsapp" | "slack";

type Props = {
  resultNotifications?: boolean;
  onToggleResultNotifications?: (val: boolean) => void;
};

export function ConversationGatewayChannelsSection({
  resultNotifications,
  onToggleResultNotifications,
}: Props = {}) {
  const [pairings, setPairings] = useState<GatewayPairingRequest[]>([]);
  const [agents, setAgents] = useState<EngineAgentProfile[]>([]);
  const [channelBindings, setChannelBindings] = useState<
    Record<string, { agentId: string; purpose: string }>
  >(() => {
    try {
      const saved = localStorage.getItem("homun_channel_agent_bindings");
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [activeTab, setActiveTab] = useState<ChannelTab>("telegram");

  // Pair code input
  const [inputCode, setInputCode] = useState("");
  // Advanced generation form
  const [showAdvanceGen, setShowAdvanceGen] = useState(false);
  const [genUserId, setGenUserId] = useState("");
  const [genUsername, setGenUsername] = useState("");
  const [lastGenerated, setLastGenerated] = useState<GatewayPairingRequest | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [list, ags] = await Promise.all([
        listGatewayPairings(),
        listEngineAgents().catch(() => [] as EngineAgentProfile[]),
      ]);
      setPairings(list);
      setAgents(ags);
    } catch (cause) {
      setError(cause);
    }
  }, []);

  function handleSetChannelAgent(channelKey: string, agentId: string) {
    setChannelBindings((prev) => {
      const updated = {
        ...prev,
        [channelKey]: {
          agentId,
          purpose: prev[channelKey]?.purpose ?? "Supervisione Esecutiva & Approvazioni",
        },
      };
      try {
        localStorage.setItem("homun_channel_agent_bindings", JSON.stringify(updated));
      } catch {
        // ignore
      }
      return updated;
    });
  }

  function handleSetChannelPurpose(channelKey: string, purpose: string) {
    setChannelBindings((prev) => {
      const updated = {
        ...prev,
        [channelKey]: {
          agentId: prev[channelKey]?.agentId ?? "",
          purpose,
        },
      };
      try {
        localStorage.setItem("homun_channel_agent_bindings", JSON.stringify(updated));
      } catch {
        // ignore
      }
      return updated;
    });
  }

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleApprove(code: string) {
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await approveGatewayPairing(code);
      setInputCode("");
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function handleDecline(code: string) {
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await declineGatewayPairing(code);
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(platformName: string, uid: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await revokeGatewayPairing({ platform: platformName, userId: uid });
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !genUserId.trim()) return;
    setBusy(true);
    try {
      const trimmedUser = genUsername.trim();
      const created = await requestGatewayPairing({
        platform: activeTab,
        userId: genUserId.trim(),
        ...(trimmedUser ? { username: trimmedUser } : {}),
      });
      setLastGenerated(created);
      setGenUserId("");
      setGenUsername("");
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  const approved = pairings.filter((p) => p.status === "approved");
  const pending = pairings.filter(
    (p) => p.status === "pending" && p.expires_at > Date.now() / 1000,
  );

  const isChannelConnected = (platform: string) =>
    approved.some((p) => p.platform.toLowerCase() === platform.toLowerCase());

  return (
    <div className="cv-gateway-wrap" aria-label="Canali esterni e supervisione">
      {/* Intestazione */}
      <div className="cv-gateway-header flex items-center justify-between">
        <div>
          <h3>Supervisione e Canali Esterni</h3>
          <p>
            Ricevi notifiche istantanee dal team di agenti su Telegram, WhatsApp o Slack quando un
            lavoro richiede il tuo chiarimento o è pronto per l’approvazione.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="cv-unified-btn is-subtle text-xs"
          title="Aggiorna lista canali"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
          <span>Aggiorna</span>
        </button>
      </div>

      <HomunErrorNotice error={error} />

      {onToggleResultNotifications && (
        <div className="p-3.5 rounded-xl bg-[#edf2e7] border border-[rgba(104,122,89,0.12)] flex items-center justify-between">
          <div className="space-y-0.5">
            <strong className="text-sm font-semibold text-[#1c2d22] block">
              Notifiche Consegne Concluse nello Spazio
            </strong>
            <span className="text-xs text-[#647a6d]">
              Mostra nel centro notifiche locale anche le consegne già approvate. Le richieste e i chiarimenti restano sempre visibili.
            </span>
          </div>
          <SettingsToggleSwitch
            checked={Boolean(resultNotifications)}
            onChange={onToggleResultNotifications}
            ariaLabel="Notifiche risultati conclusi"
          />
        </div>
      )}

      {/* Banner Esplicativo: Cosa accade */}
      <div className="cv-gateway-explainer">
        <div className="cv-gateway-explainer__icon">
          <Smartphone size={18} />
        </div>
        <div className="cv-gateway-explainer__text">
          <strong>Controllo remoto senza installare app aggiuntive</strong>
          <p>
            Gli agenti non mandano messaggi a caso: quando si fermano per un dubbio o completano una
            bozza importante, ricevi un messaggio diretto con i dettagli salienti. Puoi rispondere con
            un messaggio vocale o di testo e Homun aggiornerà la sessione in tempo reale.
          </p>
        </div>
      </div>

      {/* Richieste di accoppiamento in attesa (Pending) */}
      {pending.length > 0 && (
        <div className="cv-gateway-pending">
          <div className="cv-gateway-pending__title">
            <KeyRound size={15} />
            <span>Richieste di collegamento in attesa di autorizzazione ({pending.length})</span>
          </div>
          <div className="cv-gateway-pending__list">
            {pending.map((req) => (
              <div key={req.code} className="cv-gateway-pending__item">
                <div className="flex items-center gap-3">
                  <span className="font-mono font-bold text-sm tracking-widest text-[#8fe3d0] bg-[#182b26] px-2 py-1 rounded border border-[#253a33]">
                    {req.code}
                  </span>
                  <span className={`cv-gateway-wizard__badge ${req.platform.toLowerCase()}`}>
                    {req.platform}
                  </span>
                  <span className="text-xs text-[#f4f1ee]">
                    {req.username ? `@${req.username}` : req.user_id}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleApprove(req.code)}
                    className="cv-unified-btn is-primary text-xs"
                  >
                    <Check size={13} />
                    <span>Autorizza</span>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleDecline(req.code)}
                    className="cv-unified-btn is-subtle text-xs"
                  >
                    <X size={13} />
                    <span>Rifiuta</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Canali autorizzati attivi */}
      {approved.length > 0 && (
        <div className="cv-gateway-connected-card">
          <div className="cv-gateway-connected-card__head">
            <h4>
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Canali di supervisione attivi ({approved.length})</span>
            </h4>
            <span className="text-[11px] text-[#8fe3d0] bg-[#182b26] px-2 py-0.5 rounded border border-[#253a33]">
              Ascolto attivo
            </span>
          </div>
          <div className="cv-gateway-connected-list">
            {approved.map((item) => {
              const channelKey = `${item.platform}:${item.user_id}`;
              const binding = channelBindings[channelKey] || {
                agentId: "",
                purpose: "Supervisione Esecutiva & Approvazioni",
              };
              const assignedAgent = agents.find((a) => a.id === binding.agentId);

              return (
                <div key={channelKey} className="cv-gateway-connected-row flex flex-col gap-3">
                  <div className="flex items-center justify-between w-full">
                    <div className="cv-gateway-connected-info">
                      <div
                        className="cv-gateway-connected-avatar"
                        style={{
                          background:
                            item.platform === "telegram"
                              ? "rgba(34, 158, 217, 0.2)"
                              : item.platform === "whatsapp"
                              ? "rgba(37, 211, 102, 0.2)"
                              : "rgba(224, 30, 90, 0.2)",
                          color:
                            item.platform === "telegram"
                              ? "#38bdf8"
                              : item.platform === "whatsapp"
                              ? "#4ade80"
                              : "#f472b6",
                        }}
                      >
                        {item.platform === "telegram" ? (
                          <Send size={15} />
                        ) : item.platform === "whatsapp" ? (
                          <MessageSquare size={15} />
                        ) : (
                          <Hash size={15} />
                        )}
                      </div>
                      <div className="cv-gateway-connected-meta">
                        <strong>{item.username ? `@${item.username}` : item.user_id}</strong>
                        <span>ID: {item.user_id} · Canale {item.platform}</span>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleRevoke(item.platform, item.user_id)}
                      className="cv-unified-btn is-subtle text-xs text-red-400 hover:text-red-300"
                    >
                      Disconnetti
                    </button>
                  </div>

                  {/* Routing Agente Assegnato & Funzione */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-[rgba(255,255,255,0.04)] w-full">
                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-medium text-[#6f8982] uppercase tracking-wider flex items-center gap-1.5">
                        <Bot size={13} className="text-[#8fe3d0]" />
                        <span>Risponde</span>
                      </label>
                      <SettingsCustomSelect
                        value={binding.agentId}
                        onChange={(val) => handleSetChannelAgent(channelKey, val)}
                        options={[
                          { value: "", label: "Tutta la Squadra (Coordinatore)", icon: Bot },
                          ...agents.map((ag) => ({
                            value: ag.id,
                            label: ag.name,
                            desc: ag.role || "Specialista",
                            icon: Bot,
                          })),
                        ]}
                      />
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-[11px] font-medium text-[#6f8982] uppercase tracking-wider flex items-center gap-1.5">
                        <UserCheck size={13} className="text-[#38bdf8]" />
                        <span>Funzione Canale</span>
                      </label>
                      <SettingsCustomSelect
                        value={binding.purpose}
                        onChange={(val) => handleSetChannelPurpose(channelKey, val)}
                        options={[
                          {
                            value: "Supervisione Esecutiva & Approvazioni",
                            label: "Supervisione & Approvazioni",
                            desc: "Notifiche bloccanti e decisioni strategiche",
                          },
                          {
                            value: "Alert Tecnici & Aggiornamenti Codice",
                            label: "Alert Tecnici & Codice",
                            desc: "Notifiche pull request e build fallite",
                          },
                          {
                            value: "Accoglienza Clienti & Raccolta Requisiti",
                            label: "Intake Clienti & Front-Desk",
                            desc: "Interviste iniziali e chiarimenti",
                          },
                          {
                            value: "Canale Privato di Notifica",
                            label: "Notifiche Private",
                            desc: "Solo aggiornamenti personali silenziosi",
                          },
                        ]}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Navigazione Piattaforma (Telegram, WhatsApp, Slack) */}
      <div className="cv-gateway-nav" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "telegram"}
          className={`cv-gateway-tab ${activeTab === "telegram" ? "is-active" : ""}`}
          onClick={() => setActiveTab("telegram")}
        >
          <span
            className={`cv-gateway-tab__status-dot ${
              isChannelConnected("telegram") ? "is-online" : ""
            }`}
          />
          <Send size={14} />
          <span>Telegram {isChannelConnected("telegram") ? "(Connesso)" : ""}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "whatsapp"}
          className={`cv-gateway-tab ${activeTab === "whatsapp" ? "is-active" : ""}`}
          onClick={() => setActiveTab("whatsapp")}
        >
          <span
            className={`cv-gateway-tab__status-dot ${
              isChannelConnected("whatsapp") ? "is-online" : ""
            }`}
          />
          <MessageSquare size={14} />
          <span>WhatsApp {isChannelConnected("whatsapp") ? "(Connesso)" : ""}</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "slack"}
          className={`cv-gateway-tab ${activeTab === "slack" ? "is-active" : ""}`}
          onClick={() => setActiveTab("slack")}
        >
          <span
            className={`cv-gateway-tab__status-dot ${
              isChannelConnected("slack") ? "is-online" : ""
            }`}
          />
          <Hash size={14} />
          <span>Slack {isChannelConnected("slack") ? "(Connesso)" : ""}</span>
        </button>
      </div>

      {/* Guida Step-by-Step in base alla piattaforma */}
      <div className="cv-gateway-wizard">
        <div className="cv-gateway-wizard__head">
          <div className="cv-gateway-wizard__title">
            <h4>
              {activeTab === "telegram"
                ? "Configurazione Bot Telegram"
                : activeTab === "whatsapp"
                ? "Configurazione WhatsApp Business / Web"
                : "Configurazione App & Webhook Slack"}
            </h4>
            <span className={`cv-gateway-wizard__badge ${activeTab}`}>{activeTab}</span>
          </div>
          {isChannelConnected(activeTab) && (
            <span className="text-xs text-emerald-400 font-medium flex items-center gap-1">
              <Check size={13} />
              <span>Già associato</span>
            </span>
          )}
        </div>

        {activeTab === "telegram" && (
          <div className="cv-gateway-steps">
            <div className="cv-gateway-step">
              <div className="cv-gateway-step__num">1</div>
              <div className="cv-gateway-step__body">
                <strong>Avvia il bot su Telegram</strong>
                <p>
                  Cerca il bot di Homun su Telegram (oppure crea il tuo bot personale in 1 minuto
                  con <code>@BotFather</code> inviando il comando <code>/newbot</code>).
                </p>
              </div>
            </div>

            <div className="cv-gateway-step">
              <div className="cv-gateway-step__num">2</div>
              <div className="cv-gateway-step__body">
                <strong>Invia il comando di accoppiamento</strong>
                <p>
                  Avvia la conversazione con il bot e invia il comando <code>/pair</code> o{" "}
                  <code>/start</code>. Il bot ti risponderà con un codice di sicurezza a 8 caratteri.
                </p>
              </div>
            </div>

            <div className="cv-gateway-step">
              <div className="cv-gateway-step__num">3</div>
              <div className="cv-gateway-step__body">
                <strong>Incolla il codice qui sotto</strong>
                <p>
                  Inserisci il codice ricevuto per completare l’autorizzazione bidirezionale crittografata.
                </p>
              </div>
            </div>
          </div>
        )}

        {activeTab === "whatsapp" && (
          <div className="cv-gateway-steps">
            <div className="cv-gateway-step">
              <div className="cv-gateway-step__num">1</div>
              <div className="cv-gateway-step__body">
                <strong>Metodo di collegamento</strong>
                <p>
                  Homun supporta il gateway WhatsApp tramite Cloud API ufficiale o gateway locale
                  collegato al tuo numero aziendale.
                </p>
              </div>
            </div>

            <div className="cv-gateway-step">
              <div className="cv-gateway-step__num">2</div>
              <div className="cv-gateway-step__body">
                <strong>Registra il numero</strong>
                <p>
                  Inserisci il tuo numero di cellulare con prefisso internazionale per ricevere il codice
                  di verifica direttamente in chat WhatsApp.
                </p>
              </div>
            </div>

            <div className="cv-gateway-step">
              <div className="cv-gateway-step__num">3</div>
              <div className="cv-gateway-step__body">
                <strong>Conferma la sessione</strong>
                <p>
                  Inserisci il codice a 8 caratteri inviato dal servizio per abilitare la ricezione
                  degli alert prioritari sul tuo WhatsApp.
                </p>
              </div>
            </div>
          </div>
        )}

        {activeTab === "slack" && (
          <div className="cv-gateway-steps">
            <div className="cv-gateway-step">
              <div className="cv-gateway-step__num">1</div>
              <div className="cv-gateway-step__body">
                <strong>Installa l'integrazione Homun</strong>
                <p>
                  Aggiungi l'app Homun al tuo workspace Slack o configura una Incoming Webhook
                  nel canale desiderato (es. <code>#homun-team</code>).
                </p>
              </div>
            </div>

            <div className="cv-gateway-step">
              <div className="cv-gateway-step__num">2</div>
              <div className="cv-gateway-step__body">
                <strong>Richiedi accoppiamento canale</strong>
                <p>
                  Nel canale di Slack, digita <code>/homun pair</code>. Riceverai un codice monouso
                  generato dall'integrazione.
                </p>
              </div>
            </div>

            <div className="cv-gateway-step">
              <div className="cv-gateway-step__num">3</div>
              <div className="cv-gateway-step__body">
                <strong>Autorizza il canale</strong>
                <p>
                  Incolla il codice qui sotto per consentire agli agenti di postare avanzamenti e
                  richieste direttamente nel canale di squadra.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Box Inserimento Codice Bot */}
        <div className="cv-gateway-pairbox">
          <label className="text-xs font-semibold text-[#f4f1ee]">
            Inserisci il codice di accoppiamento ricevuto da {activeTab}
          </label>
          <div className="cv-gateway-pairbox__row">
            <input
              type="text"
              placeholder="ES. 8K4P9X2M"
              maxLength={8}
              value={inputCode}
              onChange={(e) => setInputCode(e.target.value.toUpperCase())}
              className="cv-gateway-code-input"
            />
            <button
              type="button"
              disabled={busy || inputCode.trim().length < 8}
              onClick={() => void handleApprove(inputCode)}
              className="cv-unified-btn is-primary text-xs py-2 px-4"
            >
              <Check size={14} />
              <span>Verifica e Collega</span>
            </button>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-[rgba(255,255,255,0.06)]">
            <span className="text-[11px] text-[#9db3ad]">
              Il codice scade dopo 15 minuti dalla generazione per ragioni di sicurezza.
            </span>
            <button
              type="button"
              onClick={() => setShowAdvanceGen(!showAdvanceGen)}
              className="text-[11px] text-[#8fe3d0] hover:underline bg-transparent border-none p-0 cursor-pointer"
            >
              {showAdvanceGen ? "Nascondi opzioni avanzate" : "Hai bisogno di generare tu il codice?"}
            </button>
          </div>

          {/* Form Avanzato di generazione codice preventivo */}
          {showAdvanceGen && (
            <div className="mt-3 pt-3 border-t border-[rgba(255,255,255,0.08)]">
              <p className="text-xs text-[#9db3ad] mb-2">
                Se il tuo bot richiede che sia Homun a emettere il codice preventivo da comunicare in
                chat, compilalo qui:
              </p>
              <form onSubmit={(e) => void handleGenerate(e)} className="flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Tuo username o numero (es. @nome o +39...)"
                  value={genUserId}
                  onChange={(e) => setGenUserId(e.target.value)}
                  required
                  className="cw-input text-xs flex-1 py-1.5 px-2.5"
                />
                <button
                  type="submit"
                  disabled={busy || !genUserId.trim()}
                  className="cv-unified-btn is-subtle text-xs py-1.5"
                >
                  <Smartphone size={13} />
                  <span>Genera codice Homun</span>
                </button>
              </form>

              {lastGenerated && (
                <div className="mt-2.5 p-3 bg-[#182b26] border border-[#253a33] rounded-lg text-xs">
                  <span className="text-[#8fe3d0] font-semibold block mb-1">
                    Codice preventivo generato:
                  </span>
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-bold text-base tracking-widest text-[#f4f1ee]">
                      {lastGenerated.code}
                    </span>
                    <span className="text-[11px] text-[#9db3ad] flex items-center gap-1">
                      <Clock size={12} />
                      Scade tra 60 minuti
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
