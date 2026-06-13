import { useEffect, useState } from "react";
import { Loader2, MonitorPlay, Power } from "lucide-react";
import { coreBridge, type ContainedComputerLive } from "../lib/coreBridge";

// The live "Computer" surface (ADR 0010): a real, headed browser runs inside the
// contained Linux computer and is streamed here over noVNC — visible in-app,
// never a window that takes over the host desktop. Input goes straight to the
// embedded view, so this doubles as the takeover surface.
export function ContainedComputerView() {
  const [live, setLive] = useState<ContainedComputerLive | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    coreBridge
      .containedComputerLive()
      .then((value) => {
        if (!cancelled) setLive(value);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const novncSrc =
    live?.enabled && live.novnc_url
      ? `${live.novnc_url}${live.novnc_url.includes("?") ? "&" : "?"}autoconnect=true&resize=scale&reconnect=true&show_dot=true`
      : null;

  return (
    <section className="contained-computer-view" aria-labelledby="cc-title">
      <header className="page-heading">
        <div>
          <h2 id="cc-title">Computer</h2>
          <small>
            Browser reale in un computer contenuto, streamato qui — non apre
            finestre sul desktop (ADR 0010).
          </small>
        </div>
        <span className={`cc-status ${novncSrc ? "on" : "off"}`}>
          {novncSrc ? <MonitorPlay size={15} /> : <Power size={15} />}
          {novncSrc ? "Live" : "Spento"}
        </span>
      </header>

      <div className="cc-stage">
        {error && (
          <div className="cc-placeholder">
            <strong>Gateway non raggiungibile</strong>
            <small>Avvia l'app/gateway e riprova.</small>
          </div>
        )}

        {!error && live === null && (
          <div className="cc-placeholder">
            <Loader2 size={18} className="spin" />
            <small>Verifica del computer contenuto…</small>
          </div>
        )}

        {!error && live && !novncSrc && (
          <div className="cc-placeholder">
            <strong>Computer contenuto spento</strong>
            <small>
              Avvialo e abilita la modalità, poi ricarica:
            </small>
            <pre className="cc-cmd">
              cd runtimes/contained-computer &amp;&amp; ./up.sh{"\n"}
              # avvia il gateway con HOMUN_CONTAINED_COMPUTER=1
            </pre>
            <small>
              Il browser reale girerà nel container e comparirà qui, senza mai
              prendere il controllo del tuo schermo.
            </small>
          </div>
        )}

        {novncSrc && (
          <iframe
            className="cc-frame"
            title="Computer contenuto (noVNC)"
            src={novncSrc}
            allow="clipboard-read; clipboard-write"
          />
        )}
      </div>
    </section>
  );
}
