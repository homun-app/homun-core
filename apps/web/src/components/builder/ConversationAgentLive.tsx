/** Blocco live sotto i messaggi: thinking ripiegato, tool in uso, testo in streaming. */
import { useState } from "react";
import { Bot, ChevronDown, Loader2, Wrench } from "lucide-react";
import type { ConversationStreamState } from "@/hooks/useConversationEventStream";

export function ConversationAgentLive({ stream }: { stream: ConversationStreamState }) {
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const active = stream.runActive || stream.answerText.length > 0;
  if (!active) return null;

  const visible = stream.visibleText.trim();
  return (
    <article className="cw-message agent" aria-live="polite" aria-label="Risposta agente in corso">
      <small className="flex items-center gap-1.5">
        {stream.runActive ? (
          <Loader2 size={12} className="animate-spin" aria-hidden />
        ) : (
          <Bot size={12} aria-hidden />
        )}
        {stream.runActive ? "sta lavorando…" : "risposta"}
      </small>

      {stream.thinking && (
        <div className="mt-1">
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] text-[#9db3ad] hover:text-[#647a6d]"
            onClick={() => setThinkingOpen(!thinkingOpen)}
          >
            <ChevronDown
              size={12}
              className={thinkingOpen ? "rotate-180 transition-transform" : "transition-transform"}
              aria-hidden
            />
            ragionamento
          </button>
          {thinkingOpen && (
            <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[#f6f8f3] border border-[#dce4d5] p-2.5 text-[11px] leading-relaxed text-[#647a6d] font-mono">
              {stream.thinking}
            </pre>
          )}
        </div>
      )}

      {stream.tools.length > 0 && (
        <div className="mt-1.5">
          <button
            type="button"
            className="flex items-center gap-1 text-[11px] text-[#235940] hover:text-[#1c2d22]"
            onClick={() => setToolsOpen(!toolsOpen)}
          >
            <Wrench size={12} aria-hidden />
            {stream.tools.length} strumenti
            <ChevronDown
              size={12}
              className={toolsOpen ? "rotate-180 transition-transform" : "transition-transform"}
              aria-hidden
            />
          </button>
          {(toolsOpen || stream.runActive) && (
            <ul className="mt-1 space-y-1">
              {stream.tools.map((tool, index) => (
                <li key={index} className="flex items-baseline gap-2 text-[11px]">
                  <code className="rounded bg-[#f6f8f3] border border-[#dce4d5] px-1.5 py-0.5 font-mono text-[#235940]">
                    {tool.tool}
                  </code>
                  <span className="truncate text-[#647a6d]">{tool.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {visible && (
        <p className={`whitespace-pre-wrap leading-relaxed ${stream.runActive ? "cw-message-partial" : ""}`}>
          {visible}
          {stream.runActive && (
            <span className="cw-stream-caret" aria-hidden style={{
              display: "inline-block", width: 7, height: 14, marginLeft: 2,
              background: "#235940", animation: "cw-blink 1s steps(2) infinite",
            }} />
          )}
        </p>
      )}
    </article>
  );
}
