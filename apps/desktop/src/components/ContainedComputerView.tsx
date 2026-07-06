import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, MonitorPlay, Power } from "lucide-react";
import { coreBridge, type ContainedComputerLive } from "../lib/coreBridge";

// The live "Computer" surface (ADR 0010): a real, headed browser runs inside the
// contained Linux computer and is streamed here over noVNC — visible in-app,
// never a window that takes over the host desktop. Input goes straight to the
// embedded view, so this doubles as the takeover surface.
export function ContainedComputerView() {
  const { t } = useTranslation();
  const [live, setLive] = useState<ContainedComputerLive | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchLive = (seed: boolean) =>
      coreBridge
        .containedComputerLive()
        .then((value) => {
          if (!cancelled) setLive(value);
        })
        .catch(() => {
          if (!cancelled && seed) setError(true);
        });
    fetchLive(true);
    // Keepalive: this whole page IS the live view, so being mounted means the user is
    // watching. Re-fetching touches the container's idle clock server-side (the WS
    // migration's push does not), so the reaper won't recycle it out from under the
    // user while they watch. One small request every 20s; stops on unmount.
    const id = window.setInterval(() => void fetchLive(false), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
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
            windows on the desktop (ADR 0010).
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
            <strong>Gateway unreachable</strong>
            <small>Start the app/gateway and retry.</small>
          </div>
        )}

        {!error && live === null && (
          <div className="cc-placeholder">
            <Loader2 size={18} className="spin" />
            <small>Checking the contained computer…</small>
          </div>
        )}

        {!error && live && !novncSrc && (
          <div className="cc-placeholder">
            <strong>Contained computer is off</strong>
            <small>
              {t("common.startAndEnableThenReload")}
            </small>
            <pre className="cc-cmd">
              cd runtimes/contained-computer &amp;&amp; ./up.sh{"\n"}
              # start the gateway with HOMUN_CONTAINED_COMPUTER=1
            </pre>
            <small>
              The real browser runs in the container and appears here, without ever
              taking over your screen.
            </small>
          </div>
        )}

        {novncSrc && (
          <iframe
            className="cc-frame"
            title="Contained computer (noVNC)"
            src={novncSrc}
            allow="clipboard-read; clipboard-write"
          />
        )}
      </div>
    </section>
  );
}
