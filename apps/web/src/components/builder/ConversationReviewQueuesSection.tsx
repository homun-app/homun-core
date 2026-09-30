import { useState } from "react";
import {
  ClipboardCheck,
  RefreshCw,
  CheckCircle2,
  Bot,
  SquareTerminal,
  FilePenLine,
  Sparkles,
  ShieldCheck,
} from "lucide-react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import { useEngineReviewQueues } from "@/hooks/useEngineReviewQueues";
import { approveAgentRun, type AgentRun } from "@/lib/engine-agent-run-client";
import { terminalAction } from "@/lib/engine-terminal-client";
import { approveFileEdit } from "@/lib/engine-file-edit-client";
import { skillEngineAction } from "@/lib/engine-mcp-client";
import "./conversation-unified-models.css";

/**
 * Code di revisione del motore: tutto ciò che attende una decisione umana —
 * run agentici, comandi terminale, modifiche file e skill proposte (quarantena).
 * Fonte: solo motore.
 */
export function ConversationReviewQueuesSection({ actorId }: { actorId?: string }) {
  const queues = useEngineReviewQueues(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const total =
    queues.runs.length + queues.terminal.length + queues.edits.length + queues.skills.length;

  async function act<T>(key: string, operation: () => Promise<T>) {
    if (busy) return;
    setBusy(key);
    setActionError(null);
    try {
      await operation();
      queues.refresh();
    } catch (cause) {
      setActionError(cause);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      <header className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid size-10 place-items-center rounded-xl bg-[#182b26] text-[#8fe3d0]">
            <ClipboardCheck className="size-5" aria-hidden />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-[#1c2d22]">Code di revisione</h3>
            <p className="text-xs text-[#647a6d]">
              Tutto ciò che i collaboratori agentici hanno in sospeso su una decisione umana.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {queues.lastRefreshedAt && (
            <span className="text-[11px] text-[#9db3ad]">
              {queues.lastRefreshedAt.toLocaleTimeString("it-IT")}
            </span>
          )}
          <button
            type="button"
            className="cv-unified-btn is-subtle text-xs"
            onClick={() => queues.refresh()}
          >
            <RefreshCw className="size-3.5" aria-hidden /> Aggiorna
          </button>
        </div>
      </header>

      <HomunErrorNotice error={queues.error} />
      <HomunErrorNotice error={actionError} />

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        <QueueStat icon={<Bot className="size-3.5" aria-hidden />} label="Run agentici"
          count={queues.runs.length} loading={queues.loading} />
        <QueueStat icon={<SquareTerminal className="size-3.5" aria-hidden />} label="Comandi"
          count={queues.terminal.length} loading={queues.loading} />
        <QueueStat icon={<FilePenLine className="size-3.5" aria-hidden />} label="Modifiche file"
          count={queues.edits.length} loading={queues.loading} />
        <QueueStat icon={<Sparkles className="size-3.5" aria-hidden />} label="Skill proposte"
          count={queues.skills.length} loading={queues.loading} />
      </div>

      {!queues.loading && total === 0 && !queues.error && (
        <div className="rounded-xl border border-[#dce4d5] bg-white p-8 text-center">
          <span className="mx-auto mb-2 grid size-10 place-items-center rounded-full bg-[#dcebd9] text-[#235940]">
            <CheckCircle2 className="size-5" aria-hidden />
          </span>
          <p className="text-sm font-medium text-[#1c2d22]">Nessuna richiesta in attesa</p>
          <p className="mt-1 text-xs text-[#647a6d]">
            Run, comandi, modifiche e skill proposte: tutto a posto.
          </p>
        </div>
      )}

      {queues.runs.length > 0 && (
        <QueueSection title="Run agentici" count={queues.runs.length}>
          {queues.runs.map(({ workId, workTitle, run }) => (
            <article
              key={run.id}
              className="rounded-xl border border-[#dce4d5] bg-white p-3.5"
            >
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-[13px] text-[#1c2d22]">{workTitle}</strong>
                <code className="rounded bg-[#182b26] px-2 py-0.5 text-[11px] text-[#8fe3d0]">
                  {run.id}
                </code>
                {isPolicyApproved(run) && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-[#b7d6b3] bg-[#edf2e7] px-2 py-0.5 text-[10px] font-medium text-[#235940]">
                    <ShieldCheck className="size-3" aria-hidden /> auto-approvazione prevista
                  </span>
                )}
              </div>
              {runCapabilityLabels(run).length > 0 && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-[#9db3ad]">
                    Capacità richieste
                  </span>
                  {runCapabilityLabels(run).map((label) => (
                    <span
                      key={label}
                      className="rounded-full border border-[#dce4d5] bg-[#f6f8f3] px-2 py-0.5 text-[10px] font-medium text-[#235940]"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              )}
              <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-[#dce4d5] pt-2.5">
                <span className="text-[11px] text-[#647a6d]">
                  Il run parte solo con la tua approvazione.
                </span>
                <button
                  type="button"
                  className="cv-unified-btn is-primary text-xs"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`${run.id}:approve`, () =>
                      approveAgentRun(workId, run, `ui-approve-${run.id}`))
                  }
                >
                  Approva ed esegui
                </button>
              </div>
            </article>
          ))}
        </QueueSection>
      )}

      {queues.terminal.length > 0 && (
        <QueueSection title="Comandi terminale" count={queues.terminal.length}>
          {queues.terminal.map(({ workId, workTitle, job }) => (
            <article key={job.id} className="rounded-xl border border-[#dce4d5] bg-white p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-[13px] text-[#1c2d22]">{workTitle}</strong>
                <span className="rounded-full border border-[#dce4d5] bg-[#edf2e7] px-2 py-0.5 text-[10px] font-medium text-[#647a6d]">
                  {job.image ? "Container · immagine fissata" : "Nessuna immagine"}
                </span>
              </div>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-[#182b26] p-2.5 text-[11px] leading-relaxed text-[#d7e8e0]">
                <code>{job.command}</code>
              </pre>
              <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-[#dce4d5] pt-2.5">
                <span className="text-[11px] text-[#647a6d]">Il comando esatto, niente di più.</span>
                <button
                  type="button"
                  className="cv-unified-btn is-primary text-xs"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(`${job.id}:approve`, () => terminalAction(workId, job, "approve"))
                  }
                >
                  Approva ed esegui il comando
                </button>
              </div>
            </article>
          ))}
        </QueueSection>
      )}

      {queues.edits.length > 0 && (
        <QueueSection title="Modifiche file" count={queues.edits.length}>
          {queues.edits.map(({ workId, workTitle, edit }) => (
            <article key={edit.id} className="rounded-xl border border-[#dce4d5] bg-white p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-[13px] text-[#1c2d22]">{workTitle}</strong>
                <code className="rounded bg-[#182b26] px-2 py-0.5 text-[11px] text-[#8fe3d0]">
                  {edit.path}
                </code>
              </div>
              {edit.diff_preview && <DiffPreview diff={edit.diff_preview} />}
              <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-[#dce4d5] pt-2.5">
                <span className="text-[11px] text-[#647a6d]">
                  Il file cambia solo se approvi questo contenuto esatto.
                </span>
                <button
                  type="button"
                  className="cv-unified-btn is-primary text-xs"
                  disabled={busy !== null}
                  onClick={() => void act(`${edit.id}:approve`, () => approveFileEdit(workId, edit))}
                >
                  Approva e scrivi il file
                </button>
              </div>
            </article>
          ))}
        </QueueSection>
      )}

      {queues.skills.length > 0 && (
        <QueueSection title="Skill proposte" count={queues.skills.length}>
          {queues.skills.map((skill) => (
            <article key={skill.id} className="rounded-xl border border-[#dce4d5] bg-white p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-[13px] text-[#1c2d22]">{skill.name}</strong>
                <span className="rounded-full border border-[#dce4d5] bg-[#edf2e7] px-2 py-0.5 text-[10px] font-medium text-[#647a6d]">
                  proposta da {skill.author_type === "agent" ? "un agente" : "una persona"} · rev{" "}
                  {skill.revision}
                </span>
              </div>
              {skill.description && (
                <p className="mt-1.5 text-xs text-[#263832]">{skill.description}</p>
              )}
              {skill.body && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] font-medium text-[#647a6d] hover:text-[#263832]">
                    Contenuto proposto
                  </summary>
                  <pre className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[#edf2e7] p-2.5 text-[11px] leading-relaxed text-[#263832]">
                    <code>{skill.body}</code>
                  </pre>
                </details>
              )}
              <p className="mt-2 text-[11px] text-[#9db3ad]">
                In quarantena: non guida nessun run finché non la approvi.
              </p>
              <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-[#dce4d5] pt-2.5">
                <span />
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    className="cv-unified-btn is-subtle text-xs text-red-500 hover:text-red-600"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(`${skill.id}:reject`, () =>
                        skillEngineAction({ skillId: skill.id, action: "reject", expectedVersion: skill.revision }))
                    }
                  >
                    Respingi
                  </button>
                  <button
                    type="button"
                    className="cv-unified-btn is-primary text-xs"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(`${skill.id}:approve`, () =>
                        skillEngineAction({ skillId: skill.id, action: "approve", expectedVersion: skill.revision }))
                    }
                  >
                    Approva nel catalogo
                  </button>
                </div>
              </div>
            </article>
          ))}
        </QueueSection>
      )}

      {actorId && (
        <p className="pt-1 text-[11px] text-[#9db3ad]">
          Operazioni come {actorId} · Fonte: motore.
        </p>
      )}
    </div>
  );
}

function QueueStat({
  icon, label, count, loading,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  loading: boolean;
}) {
  const empty = !loading && count === 0;
  return (
    <div
      className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 ${
        empty ? "border-[#dce4d5] bg-white" : "border-[#b7d6b3] bg-[#dcebd9]"
      }`}
    >
      <span
        className={`grid size-7 shrink-0 place-items-center rounded-lg ${
          empty ? "bg-[#dcebd9] text-[#4c6a58]" : "bg-[#182b26] text-[#8fe3d0]"
        }`}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className={`text-lg leading-none font-semibold ${empty ? "text-[#9db3ad]" : "text-[#235940]"}`}>
          {loading ? "–" : count}
        </p>
        <p className="truncate text-[10px] text-[#647a6d]">{label}</p>
      </div>
    </div>
  );
}

function QueueSection({
  title, count, children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5" aria-label={`${title} in approvazione`}>
      <h4 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-[#1c2d22] uppercase">
        {title}
        <span className="rounded-full bg-[#182b26] px-2 py-0.5 text-[10px] font-semibold text-[#8fe3d0]">
          {count}
        </span>
      </h4>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function DiffPreview({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="mt-2 overflow-x-auto rounded-lg border border-[#dce4d5] bg-[#f6f8f3] p-2.5 text-[11px] leading-relaxed">
      <code>
        {lines.map((line, index) => (
          <span
            key={index}
            className={
              line.startsWith("+")
                ? "block bg-[rgba(31,122,77,0.08)] text-[#1f7a4d]"
                : line.startsWith("-")
                  ? "block bg-[rgba(179,69,63,0.07)] text-[#b3453f]"
                  : line.startsWith("@@")
                    ? "block text-[#9db3ad]"
                    : "block text-[#263832]"
            }
          >
            {line || " "}
          </span>
        ))}
      </code>
    </pre>
  );
}

function isPolicyApproved(run: { status: string }): boolean {
  const channel = (run as unknown as { _approval_channel?: string })._approval_channel;
  return typeof channel === "string" && channel.startsWith("policy:");
}

const RUN_CAPABILITY_LABELS: [field: string, label: string][] = [
  ["terminal", "Terminale"],
  ["memory", "Memoria"],
  ["skills", "Skill"],
  ["web_pages", "Pagine web"],
  ["browser", "Browser"],
  ["cron", "Cron"],
  ["delegation", "Delegazione"],
  ["code_execution", "Esecuzione codice"],
  ["goals", "Obiettivi"],
  ["session_management", "Sessioni"],
  ["gateway", "Gateway"],
  ["plugins", "Plugin"],
];

function runCapabilityLabels(run: AgentRun): string[] {
  return RUN_CAPABILITY_LABELS.filter(([field]) => run[field as keyof AgentRun] != null).map(
    ([, label]) => label,
  );
}
