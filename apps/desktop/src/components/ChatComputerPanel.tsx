import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, MonitorPlay } from "lucide-react";
import { coreBridge, type ContainedComputerLive } from "../lib/coreBridge";

// Manus-style inline "Computer" panel: a collapsible live view of the contained
// browser, pinned in the chat so the user SEES what the agent is doing while it
// uses the browse_web tool — instead of just reading "🔧 Uso il browser". Shown
// only when contained-computer mode is live; otherwise renders nothing.
export function ChatComputerPanel() {
  const [live, setLive] = useState<ContainedComputerLive | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    coreBridge
      .containedComputerLive()
      .then((value) => {
        if (!cancelled) setLive(value);
      })
      .catch(() => {
        if (!cancelled) setLive({ enabled: false, novnc_url: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!live?.enabled || !live.novnc_url) return null;

  const src = `${live.novnc_url}${live.novnc_url.includes("?") ? "&" : "?"}autoconnect=true&resize=scale&reconnect=true`;

  return (
    <div className="chat-computer-panel">
      <button
        className="chat-computer-head"
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <MonitorPlay size={15} />
        <span>Computer</span>
        <small>browser reale contenuto · live</small>
      </button>
      {open && (
        <iframe
          className="chat-computer-frame"
          title="Computer contenuto (live)"
          src={src}
          allow="clipboard-read; clipboard-write"
        />
      )}
    </div>
  );
}
