import { useState, useRef, useId, useLayoutEffect, type ReactNode } from "react";
import { ArrowUp, Paperclip, X } from "lucide-react";
import {
  PromptInput,
  PromptInputProvider,
  PromptInputBody,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
  usePromptInputAttachments,
  usePromptInputController,
} from "../ai-elements/prompt-input";

export type ChatReference = {
  id: string;
  name: string;
  kind: "member" | "project";
  description?: string;
  profile?: ReactNode;
};

export function StudioChatInput({
  label,
  onSend,
  children,
  references,
  disabled = false,
}: {
  label: string;
  disabled?: boolean;
  onSend: (text: string, files: File[], references?: ChatReference[]) => void;
  references?: ChatReference[];
  children?: ReactNode;
}) {
  return (
    <PromptInputProvider>
      <Composer disabled={disabled} label={label} onSend={onSend} references={references || []}>
        {children}
      </Composer>
    </PromptInputProvider>
  );
}
function Composer({
  label,
  onSend,
  children,
  references = [],
  disabled = false,
}: Parameters<typeof StudioChatInput>[0]) {
  const attachments = usePromptInputAttachments();
  const { textInput } = usePromptInputController();
  const nextCursor = useRef<number | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const menuId = useId();
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(
    null,
  );
  const [highlight, setHighlight] = useState(0);
  const [chosen, setChosen] = useState<ChatReference[]>([]);
  const [profile, setProfile] = useState<ChatReference | null>(null);
  const matches = references.filter((r) =>
    `${r.name} ${r.description || ""}`
      .toLocaleLowerCase()
      .includes(mention?.query.toLocaleLowerCase() || ""),
  );
  const detect = (element: HTMLTextAreaElement) => {
    const end = element.selectionStart;
    const match = element.value.slice(0, end).match(/(?:^|\s)@([^@\n]*)$/);
    setMention(
      match ? { start: end - (match[1] || "").length - 1, end, query: match[1] || "" } : null,
    );
    setHighlight(0);
  };
  useLayoutEffect(() => {
    if (nextCursor.current !== null) {
      input.current?.focus();
      input.current?.setSelectionRange(nextCursor.current, nextCursor.current);
      nextCursor.current = null;
    }
  }, [textInput.value]);
  function choose(ref: ChatReference) {
    if (!mention) return;
    const insertion = `@${ref.name} `;
    textInput.setInput(
      textInput.value.slice(0, mention.start) + insertion + textInput.value.slice(mention.end),
    );
    setChosen((all) =>
      all.some((r) => r.id === ref.id && r.kind === ref.kind) ? all : [...all, ref],
    );
    setMention(null);
    nextCursor.current = mention.start + insertion.length;
  }
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <PromptInput
      className="st-sdk-composer"
      multiple
      maxFiles={20}
      maxFileSize={25 * 1024 * 1024}
      onError={({ message }) => setError(message)}
      onSubmit={async (message) => {
        if (disabled || busy || (!message.text.trim() && !message.files.length))
          throw new Error("Empty message");
        setBusy(true);
        setError("");
        try {
          // AI Elements owns file selection/paste/drop; adapt its local parts to the prototype's File contract.
          const files = await Promise.all(
            message.files.map(async (part) => {
              if (!/^(data:|blob:)/.test(part.url)) throw new Error("Expected local attachment");
              const blob = await (await fetch(part.url)).blob();
              return new File([blob], part.filename || "allegato", { type: part.mediaType });
            }),
          );
          onSend(
            message.text,
            files,
            chosen.filter((r) => message.text.includes(`@${r.name}`)),
          );
          setChosen([]);
          setMention(null);
          setProfile(null);
        } catch (e) {
          setError("Invio non riuscito. Gli allegati sono ancora qui: riprova.");
          throw e;
        } finally {
          setBusy(false);
        }
      }}
    >
      {!!attachments.files.length && (
        <div className="st-chat-attachments">
          {attachments.files.map((file) => (
            <span key={file.id}>
              <Paperclip size={13} />
              {file.filename}
              <button
                type="button"
                aria-label={`Rimuovi allegato ${file.filename}`}
                onClick={() => attachments.remove(file.id)}
              >
                <X size={14} />
              </button>
            </span>
          ))}
        </div>
      )}
      {mention && references.length > 0 && (
        <div
          className="st-mention-menu"
          id={menuId}
          role="listbox"
          aria-label="Riferimenti disponibili"
        >
          <small>Collaboratori e progetti · ↑ ↓ per scegliere · Invio per inserire</small>
          {!matches.length && <p>Nessun risultato</p>}
          {matches.map((ref, i) => (
            <button
              type="button"
              role="option"
              aria-selected={highlight === i}
              id={`${menuId}-${i}`}
              key={`${ref.kind}:${ref.id}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(ref)}
            >
              <strong>{ref.name}</strong>
              <small>
                {ref.kind === "project" ? "Progetto" : "Collaboratore"} · {ref.description}
              </small>
            </button>
          ))}
        </div>
      )}
      <PromptInputBody>
        <PromptInputTextarea
          ref={input}
          onChange={(e) => detect(e.currentTarget)}
          onClick={(e) => detect(e.currentTarget)}
          aria-controls={mention ? menuId : undefined}
          aria-activedescendant={
            mention && matches.length
              ? `${menuId}-${Math.min(highlight, matches.length - 1)}`
              : undefined
          }
          onKeyDown={(e) => {
            if (!mention || e.nativeEvent.isComposing) return;
            if (e.key === "Escape") {
              e.preventDefault();
              setMention(null);
              return;
            }
            if (matches.length && ["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) {
              e.preventDefault();
              if (e.key === "Enter") choose(matches[Math.min(highlight, matches.length - 1)]!);
              else
                setHighlight(
                  (i) => (i + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length,
                );
            }
          }}
          aria-label={label}
          placeholder="Chiedi, crea, organizza…"
          disabled={disabled || busy}
        />
      </PromptInputBody>
      {!!chosen.filter((r) => textInput.value.includes(`@${r.name}`)).length && (
        <div className="st-chat-followups">
          {chosen
            .filter((r) => textInput.value.includes(`@${r.name}`))
            .map((r) => (
              <button
                type="button"
                key={`${r.kind}:${r.id}`}
                onClick={() => setProfile(profile?.id === r.id ? null : r)}
              >
                {r.kind === "project" ? "▱" : "@"} {r.name}
              </button>
            ))}
        </div>
      )}
      {profile && (
        <div className="st-mention-profile">
          {profile.profile || (
            <p>
              {profile.name} · {profile.description}
            </p>
          )}
          <button type="button" onClick={() => setProfile(null)}>
            Chiudi scheda
          </button>
        </div>
      )}
      {children}
      <PromptInputFooter>
        <PromptInputTools>
          <PromptInputButton
            aria-label="Allega file"
            title="Allega file · puoi anche trascinarli o incollarli"
            disabled={disabled || busy}
            onClick={() => attachments.openFileDialog()}
          >
            <Paperclip size={17} />
          </PromptInputButton>
        </PromptInputTools>
        <small className="st-muted">Demo locale · nessun modello collegato</small>
        <PromptInputSubmit
          aria-label="Invia messaggio"
          disabled={disabled || busy || (!textInput.value.trim() && !attachments.files.length)}
        >
          <ArrowUp size={18} />
        </PromptInputSubmit>
      </PromptInputFooter>
      {error && <p role="alert">{error}</p>}
    </PromptInput>
  );
}
