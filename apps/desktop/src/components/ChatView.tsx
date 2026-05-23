import { ArrowUp, Globe2, Mic, Paperclip, ShieldCheck, Sparkles } from "lucide-react";
import type { ChatMessage, RuntimeHealth } from "../types";

interface ChatViewProps {
  messages: ChatMessage[];
  health: RuntimeHealth[];
}

export function ChatView({ messages, health }: ChatViewProps) {
  return (
    <section className="chat-view" aria-labelledby="chat-title">
      <header className="topbar">
        <div>
          <p className="eyebrow">Home</p>
          <h2 id="chat-title">Cosa posso fare per te?</h2>
        </div>
        <div className="runtime-pills" aria-label="Stato runtime">
          {health.slice(0, 3).map((item) => (
            <span className={`pill ${item.status}`} key={item.label}>
              {item.label}
            </span>
          ))}
        </div>
      </header>

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
