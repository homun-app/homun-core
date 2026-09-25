/** Gateway external channels management: Telegram, Slack and mobile pairing (H32/H33). */
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
import { Send, Check, X, ShieldCheck, RefreshCw, KeyRound, Smartphone } from "lucide-react";

export function ConversationGatewayChannelsSection() {
  const [pairings, setPairings] = useState<GatewayPairingRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // Approve existing code input
  const [inputCode, setInputCode] = useState("");
  // Generate code form
  const [platform, setPlatform] = useState("telegram");
  const [userId, setUserId] = useState("");
  const [username, setUsername] = useState("");
  const [lastGenerated, setLastGenerated] = useState<GatewayPairingRequest | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const list = await listGatewayPairings();
      setPairings(list);
    } catch (cause) {
      setError(cause);
    }
  }, []);

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
    if (busy || !userId.trim()) return;
    setBusy(true);
    try {
      const trimmedUser = username.trim();
      const created = await requestGatewayPairing({
        platform,
        userId: userId.trim(),
        ...(trimmedUser ? { username: trimmedUser } : {}),
      });
      setLastGenerated(created);
      setUserId("");
      setUsername("");
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  const approved = pairings.filter((p) => p.status === "approved");
  const pending = pairings.filter((p) => p.status === "pending" && p.expires_at > Date.now() / 1000);

  return (
    <div className="cv-settings-section" aria-label="Canali esterni e gateway">
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-base font-semibold text-[#1e382f]">Supervisione e Canali Esterni</h3>
          <p className="text-xs text-[#52635a]">
            Collega Telegram o Slack per ricevere notifiche su chiarimenti e deliverable pronti,
            rispondendo direttamente dal cellulare.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="text-xs px-2.5 py-1 rounded border border-[#dce3d5] bg-white text-[#2e473d] hover:bg-[#f0f4ed] flex items-center gap-1.5 transition"
          title="Aggiorna lista canali"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${busy ? "animate-spin" : ""}`} />
          <span>Aggiorna</span>
        </button>
      </div>

      <HomunErrorNotice error={error} />

      {/* Sezione 1: Canali attivi */}
      <div className="cv-settings-card mt-3">
        <div className="flex items-center gap-2 mb-2 font-medium text-xs text-[#1e382f]">
          <ShieldCheck className="w-4 h-4 text-emerald-600" />
          <span>Canali autorizzati ({approved.length})</span>
        </div>
        {approved.length === 0 ? (
          <p className="text-xs text-[#6e8277] m-0">
            Nessun canale esterno collegato. Le notifiche e le decisioni restano esclusive del browser.
          </p>
        ) : (
          <div className="space-y-2 mt-2">
            {approved.map((item) => (
              <div
                key={`${item.platform}-${item.user_id}`}
                className="flex items-center justify-between p-2.5 rounded-lg bg-white border border-[#dce3d5] text-xs"
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold uppercase tracking-wider text-[10px] px-1.5 py-0.5 rounded bg-[#e8f0e0] text-[#1e382f]">
                    {item.platform}
                  </span>
                  <span className="font-medium text-[#1f2e27]">
                    {item.username ? `@${item.username}` : item.user_id}
                  </span>
                  <span className="text-[#819087] text-[11px] font-mono">({item.user_id})</span>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleRevoke(item.platform, item.user_id)}
                  className="text-xs text-red-600 hover:text-red-800 font-medium px-2 py-0.5 rounded hover:bg-red-50 transition"
                >
                  Revoca
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sezione 2: Richieste di accoppiamento in attesa */}
      {pending.length > 0 && (
        <div className="cv-settings-card mt-3 border-amber-300 bg-amber-50/50">
          <div className="flex items-center gap-2 mb-2 font-medium text-xs text-amber-900">
            <KeyRound className="w-4 h-4 text-amber-600" />
            <span>Richieste di accoppiamento in attesa ({pending.length})</span>
          </div>
          <p className="text-xs text-amber-800 mb-2">
            Questi codici sono stati inviati da Telegram o Slack e attendono la tua autorizzazione.
          </p>
          <div className="space-y-2">
            {pending.map((req) => (
              <div
                key={req.code}
                className="flex items-center justify-between p-2.5 rounded-lg bg-white border border-amber-200 text-xs"
              >
                <div>
                  <span className="font-mono font-bold text-sm tracking-widest text-[#1e382f] mr-2">
                    {req.code}
                  </span>
                  <span className="text-[11px] uppercase px-1.5 py-0.5 rounded bg-gray-100 font-semibold mr-1.5">
                    {req.platform}
                  </span>
                  <span className="text-xs text-[#52635a]">
                    {req.username ? `@${req.username}` : req.user_id}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleApprove(req.code)}
                    className="cw-primary text-xs px-2.5 py-1 flex items-center gap-1"
                  >
                    <Check className="w-3.5 h-3.5" />
                    <span>Approva</span>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleDecline(req.code)}
                    className="cw-secondary text-xs px-2 py-1 text-gray-600 hover:text-red-700"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Sezione 3: Inserisci codice o Genera codice per Telegram/Slack */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
        {/* Box A: Inserisci codice da bot */}
        <div className="cv-settings-card">
          <strong className="block text-xs font-semibold text-[#1e382f] mb-1">
            Hai un codice ricevuto dal Bot?
          </strong>
          <p className="text-xs text-[#52635a] mb-2.5">
            Se hai avviato il bot su Telegram e ti ha fornito un codice a 8 caratteri, inseriscilo qui:
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              placeholder="Es. ABCDEFGH"
              maxLength={8}
              value={inputCode}
              onChange={(e) => setInputCode(e.target.value.toUpperCase())}
              className="cw-input text-xs font-mono uppercase tracking-widest flex-1 py-1.5 px-2.5"
            />
            <button
              type="button"
              disabled={busy || inputCode.trim().length < 8}
              onClick={() => void handleApprove(inputCode)}
              className="cw-primary text-xs py-1.5 px-3 flex items-center gap-1"
            >
              <Check className="w-3.5 h-3.5" />
              <span>Approva</span>
            </button>
          </div>
        </div>

        {/* Box B: Genera codice preventivo */}
        <div className="cv-settings-card">
          <strong className="block text-xs font-semibold text-[#1e382f] mb-1">
            Genera codice di accoppiamento
          </strong>
          <p className="text-xs text-[#52635a] mb-2">
            Crea un codice a 8 caratteri con validità di 1 ora da inviare al bot:
          </p>
          <form onSubmit={(e) => void handleGenerate(e)} className="space-y-2">
            <div className="flex items-center gap-2">
              <select
                value={platform}
                onChange={(e) => setPlatform(e.target.value)}
                className="cw-input text-xs py-1 px-2 w-28"
              >
                <option value="telegram">Telegram</option>
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
              </select>
              <input
                type="text"
                placeholder="ID o Username utente (es. 12345678)"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                required
                className="cw-input text-xs flex-1 py-1 px-2"
              />
            </div>
            <button
              type="submit"
              disabled={busy || !userId.trim()}
              className="cw-secondary text-xs w-full py-1.5 flex items-center justify-center gap-1.5"
            >
              <Smartphone className="w-3.5 h-3.5" />
              <span>Genera codice per {platform}</span>
            </button>
          </form>

          {lastGenerated && (
            <div className="mt-2.5 p-2 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-900">
              <span className="font-semibold block mb-0.5">Codice generato con successo:</span>
              <div className="flex items-center justify-between">
                <span className="font-mono font-bold text-base tracking-widest text-[#1e382f]">
                  {lastGenerated.code}
                </span>
                <span className="text-[11px] text-emerald-700">Scade tra 60 minuti</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
