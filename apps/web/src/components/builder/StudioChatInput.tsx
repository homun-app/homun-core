import { useState, useRef, useId, useLayoutEffect, type ReactNode } from "react";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
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

import { AutonomySelector } from "./AutonomySelector";
import { AgentModelSelector } from "./AgentModelSelector";
import { ComposerPlusMenu } from "./ComposerPlusMenu";
import type { AutonomyLevel } from "./conversation-preferences";

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
  engineBusy = false,
  onCancel,
  autonomyLevel,
  onAutonomyLevelChange,
  modelConnectionId,
  onModelConnectionIdChange,
}: {
  label: string;
  disabled?: boolean;
  /** True while Homun is mid-turn: the send control becomes Cancel. */
  engineBusy?: boolean;
  onCancel?: (() => void) | undefined;
  onSend: (text: string, files: File[], references?: ChatReference[]) => void;
  references?: ChatReference[];
  children?: ReactNode;
  autonomyLevel?: AutonomyLevel | undefined;
  onAutonomyLevelChange?: ((level: AutonomyLevel) => void) | undefined;
  modelConnectionId?: string | undefined;
  onModelConnectionIdChange?: ((connectionId: string) => void) | undefined;
}) {
  return (
    <PromptInputProvider>
      <Composer
        disabled={disabled}
        engineBusy={engineBusy}
        onCancel={onCancel}
        label={label}
        onSend={onSend}
        references={references || []}
        autonomyLevel={autonomyLevel}
        onAutonomyLevelChange={onAutonomyLevelChange}
        modelConnectionId={modelConnectionId}
        onModelConnectionIdChange={onModelConnectionIdChange}
      >
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
  engineBusy = false,
  onCancel,
  autonomyLevel,
  onAutonomyLevelChange,
  modelConnectionId,
  onModelConnectionIdChange,
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
  function handleMentionAgent() {
    const cur = textInput.value;
    const insertion = cur.length > 0 && !cur.endsWith(" ") ? " @" : "@";
    textInput.setInput(cur + insertion);
    nextCursor.current = (cur + insertion).length;
    setTimeout(() => {
      if (input.current) {
        input.current.focus();
        detect(input.current);
      }
    }, 10);
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
          className="!min-h-[36px] !py-1 text-sm"
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
          placeholder="Chiedi, crea o assegna un compito…"
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
          <ComposerPlusMenu
            autonomyLevel={autonomyLevel}
            onAutonomyLevelChange={onAutonomyLevelChange}
            onAttachFiles={() => attachments.openFileDialog()}
            onMentionAgent={handleMentionAgent}
            disabled={disabled || busy}
          />
          {onAutonomyLevelChange && (
            <AutonomySelector
              value={autonomyLevel}
              onChange={onAutonomyLevelChange}
              disabled={disabled || busy}
            />
          )}
          <PromptInputButton
            aria-label="Allega file"
            title="Allega file · puoi anche trascinarli o incollarli"
            disabled={disabled || busy}
            onClick={() => attachments.openFileDialog()}
            className="st-composer-attach-btn"
          >
            <Paperclip size={15} />
          </PromptInputButton>
        </PromptInputTools>

        <div className="st-composer-footer-right">
          {onModelConnectionIdChange && (
            <AgentModelSelector
              value={modelConnectionId ?? ""}
              onChange={onModelConnectionIdChange}
              compact={true}
              side="top"
              disabled={disabled || busy}
            />
          )}
          {!onModelConnectionIdChange && (
            <small className="st-muted">Demo locale · nessun modello collegato</small>
          )}
          <PromptInputSubmit
            aria-label={engineBusy && onCancel ? "Annulla" : "Invia messaggio"}
            status={engineBusy && onCancel ? "streaming" : undefined}
            onStop={engineBusy && onCancel ? onCancel : undefined}
            disabled={
              disabled ||
              busy ||
              (!(engineBusy && onCancel) &&
                !textInput.value.trim() &&
                !attachments.files.length)
            }
          >
            {engineBusy && onCancel ? (
              <Square size={14} className="fill-current" />
            ) : (
              <ArrowUp size={16} />
            )}
          </PromptInputSubmit>
        </div>
      </PromptInputFooter>
      {error && <p role="alert">{error}</p>}
    </PromptInput>
  );
}
