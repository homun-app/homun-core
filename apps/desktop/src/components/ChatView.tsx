import {
  Activity,
  ArrowUp,
  ChevronDown,
  Globe2,
  Mic,
  MoreHorizontal,
  Paperclip,
  Share2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type { ChatMessage, RuntimeHealth, TaskItem } from "../types";

interface ChatViewProps {
  approvalsCount: number;
  messages: ChatMessage[];
  health: RuntimeHealth[];
  onShowDetails: () => void;
  task: TaskItem;
}

export function ChatView({
  approvalsCount,
  messages,
  health,
  onShowDetails,
  task,
}: ChatViewProps) {
  return (
    <section className="chat-view" aria-labelledby="chat-title">
      <header className="chat-topbar">
        <button className="chat-title-button" type="button" onClick={onShowDetails}>
          <span id="chat-title">Assistant locale</span>
          <ChevronDown size={15} />
        </button>
        <div className="chat-top-actions">
          <button className="top-action primary-lite" type="button">
            <Sparkles size={15} />
            Locale attivo
          </button>
          <button className="icon-button" type="button" aria-label="Condividi">
            <Share2 size={17} />
          </button>
          <button className="icon-button" type="button" aria-label="Altre azioni">
            <MoreHorizontal size={18} />
          </button>
        </div>
      </header>

      <div className="chat-hero">
        <p className="eyebrow">Home</p>
        <h2>Cosa posso fare per te?</h2>
        <div className="runtime-pills compact" aria-label="Stato runtime">
          {health.slice(0, 2).map((item) => (
            <span className={`pill ${item.status}`} key={item.label}>{item.label}</span>
          ))}
        </div>
      </div>

      <div className="conversation" aria-label="Conversazione recente">
        {messages.map((message) => (
          <article className={`message ${message.role}`} key={message.id}>
            <p>{message.text}</p>
            <footer>
              <span>{message.timestamp}</span>
              {message.metadata && <span>{message.metadata}</span>}
            </footer>
          </article>
        ))}
      </div>

      <div className="composer-dock">
        <button className="activity-strip" type="button" onClick={onShowDetails}>
          <Activity size={16} />
          <span>{task.title}</span>
          <small>{approvalsCount} approval</small>
        </button>

        <div className="suggestion-row" aria-label="Azioni rapide">
          {["Avvio lavoro", "Cerca e prenota", "Rivedi memoria", "Crea automazione"].map(
            (label) => (
              <button className="suggestion-chip" type="button" key={label}>
                <Sparkles size={15} />
                {label}
              </button>
            ),
          )}
        </div>

        <div className="prompt-panel" aria-label="Prompt operativo">
          <textarea
            aria-label="Richiesta per l'assistente"
            placeholder="Assegna un task o poni una domanda"
            defaultValue=""
          />
          <div className="composer-toolbar">
            <div className="composer-actions">
              <button className="icon-button" type="button" aria-label="Aggiungi allegato">
                <Paperclip size={17} />
              </button>
              <button className="tool-chip" type="button">
                <ShieldCheck size={16} />
                Local-first
              </button>
              <button className="tool-chip" type="button">
                <Globe2 size={16} />
                Browser
              </button>
            </div>
            <div className="composer-actions">
              <button className="icon-button" type="button" aria-label="Dettatura">
                <Mic size={17} />
              </button>
              <button className="send-button" type="button" aria-label="Invia">
                <ArrowUp size={18} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
