import { useState } from "react";
import { CheckCircle2, ShieldCheck } from "lucide-react";
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
 * Fonte: solo motore. Grafica Braun: superfici bianche, bordi hairline,
 * tipografia al posto delle decorazioni, un solo accento.
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
    <div className="space-y-5">
      <header className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-[#1c2d22]">Code di revisione</h3>
        <button
          type="button"
          className="text-xs text-[#647a6d] transition-colors hover:text-[#1c2d22]"
          onClick={() => queues.refresh()}
        >
          {queues.lastRefreshedAt
            ? `aggiornato ${queues.lastRefreshedAt.toLocaleTimeString("it-IT")}`
            : "aggiorna"}
        </button>
      </header>

      <HomunErrorNotice error={queues.error} />
      <HomunErrorNotice error={actionError} />

      <QueueStats
        loading={queues.loading}
        runs={queues.runs.length}
        terminal={queues.terminal.length}
        edits={queues.edits.length}
        skills={queues.skills.length}
      />

      {!queues.loading && total === 0 && !queues.error && (
        <p className="flex items-center gap-2 text-xs text-[#647a6d]">
          <CheckCircle2 className="size-4 shrink-0 text-[#235940]" aria-hidden />
          Nessuna richiesta in attesa.
        </p>
      )}

      {queues.runs.length > 0 && (
        <QueueSection title="Run agentici" count={queues.runs.length}>
          {queues.runs.map(({ workId, workTitle, run }) => (
            <article key={run.id} className="rq-card">
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <strong className="text-[13px] font-medium text-[#1c2d22]">{workTitle}</strong>
                <code className="font-mono text-[11px] text-[#9db3ad]">{run.id}</code>
                {isPolicyApproved(run) && (
                  <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-[#235940]">
                    <ShieldCheck className="size-3.5" aria-hidden /> auto-approvazione prevista
                  </span>
                )}
              </p>
              {runCapabilityLabels(run).length > 0 && (
                <p className="mt-1.5 text-xs text-[#647a6d]">
                  Capacità richieste: {runCapabilityLabels(run).join(", ")}.
                </p>
              )}
              <div className="rq-footer">
                <span className="rq-hint">Parte solo con la tua approvazione.</span>
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
            <article key={job.id} className="rq-card">
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <strong className="text-[13px] font-medium text-[#1c2d22]">{workTitle}</strong>
                <span className="ml-auto text-[11px] text-[#647a6d]">
                  {job.image ? "container · immagine fissata" : "nessuna immagine fissata"}
                </span>
              </p>
              <pre className="rq-code">
                <code>{job.command}</code>
              </pre>
              <div className="rq-footer">
                <span className="rq-hint">Il comando esatto, niente di più.</span>
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
            <article key={edit.id} className="rq-card">
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <strong className="text-[13px] font-medium text-[#1c2d22]">{workTitle}</strong>
                <code className="font-mono text-[11px] text-[#9db3ad]">{edit.path}</code>
              </p>
              {edit.diff_preview && <DiffPreview diff={edit.diff_preview} />}
              <div className="rq-footer">
                <span className="rq-hint">Il file cambia solo se approvi questo contenuto.</span>
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
            <article key={skill.id} className="rq-card">
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <strong className="text-[13px] font-medium text-[#1c2d22]">{skill.name}</strong>
                <span className="text-[11px] text-[#647a6d]">
                  proposta da {skill.author_type === "agent" ? "un agente" : "una persona"} · rev{" "}
                  {skill.revision}
                </span>
              </p>
              {skill.description && (
                <p className="mt-1.5 text-xs text-[#263832]">{skill.description}</p>
              )}
              {skill.body && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-[11px] text-[#647a6d] hover:text-[#1c2d22]">
                    Contenuto proposto
                  </summary>
                  <pre className="rq-code rq-code--scroll mt-1.5">
                    <code>{skill.body}</code>
                  </pre>
                </details>
              )}
              <div className="rq-footer">
                <span className="rq-hint">In quarantena finché non la approvi.</span>
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
        <p className="text-[11px] text-[#9db3ad]">
          Operazioni come {actorId} · Fonte: motore.
        </p>
      )}
    </div>
  );
}

/** Lettura a strumenti: quattro colonne divise da hairline, il numero parla. */
function QueueStats({
  loading, runs, terminal, edits, skills,
}: {
  loading: boolean;
  runs: number;
  terminal: number;
  edits: number;
  skills: number;
}) {
  return (
    <dl className="grid grid-cols-2 border-t border-b border-[#dce4d5] sm:grid-cols-4 sm:divide-x sm:divide-[#dce4d5]">
      <QueueStat loading={loading} label="Run agentici" count={runs} />
      <QueueStat loading={loading} label="Comandi" count={terminal} />
      <QueueStat loading={loading} label="Modifiche file" count={edits} />
      <QueueStat loading={loading} label="Skill proposte" count={skills} />
    </dl>
  );
}

function QueueStat({
  label, count, loading,
}: {
  label: string;
  count: number;
  loading: boolean;
}) {
  const quiet = loading || count === 0;
  return (
    <div className="px-3 py-2.5">
      <dd
        className={`text-xl leading-none font-light tabular-nums ${
          quiet ? "text-[#c5d2c8]" : "text-[#1c2d22]"
        }`}
      >
        {loading ? "–" : count}
      </dd>
      <dt className="mt-1 text-[10px] tracking-wide text-[#9db3ad] uppercase">{label}</dt>
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
    <section className="space-y-2" aria-label={`${title} in approvazione`}>
      <h4 className="text-[11px] font-medium tracking-widest text-[#9db3ad] uppercase">
        {title} · {count}
      </h4>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function DiffPreview({ diff }: { diff: string }) {
  return (
    <pre className="rq-code">
      <code>
        {diff.split("\n").map((line, index) => (
          <span
            key={index}
            className={
              line.startsWith("+")
                ? "block text-[#1f7a4d]"
                : line.startsWith("-")
                  ? "block text-[#b3453f]"
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
