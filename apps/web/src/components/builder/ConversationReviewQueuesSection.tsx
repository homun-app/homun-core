import { useState } from 'react';
import { HomunErrorNotice } from '@/components/HomunErrorNotice';
import { useEngineReviewQueues } from '@/hooks/useEngineReviewQueues';
import { approveAgentRun } from '@/lib/engine-agent-run-client';
import { terminalAction } from '@/lib/engine-terminal-client';
import { approveFileEdit } from '@/lib/engine-file-edit-client';
import { skillEngineAction } from '@/lib/engine-mcp-client';

/**
 * Code di revisione del motore: tutto ciò che attende una decisione umana —
 * run agentici, comandi terminale, modifiche file e skill proposte (quarantena).
 * Fonte: solo motore.
 */
export function ConversationReviewQueuesSection({ actorId }: { actorId?: string }) {
  const queues = useEngineReviewQueues(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);

  const total = queues.runs.length + queues.terminal.length + queues.edits.length + queues.skills.length;

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
    <div className="space-y-6">
      <header className="space-y-1">
        <h3 className="text-base font-semibold">Code di revisione</h3>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Tutto ciò che i collaboratori agentici hanno in sospeso su una tua decisione.
          {queues.lastRefreshedAt &&
            ` Aggiornato alle ${queues.lastRefreshedAt.toLocaleTimeString('it-IT')}.`}
        </p>
      </header>

      {queues.loading && <p role="status">Caricamento code dal motore…</p>}
      <HomunErrorNotice error={queues.error} />
      <HomunErrorNotice error={actionError} />

      {!queues.loading && total === 0 && !queues.error && (
        <p role="status" className="text-sm">
          Nessuna richiesta in attesa: run, comandi, modifiche e skill sono a posto.
        </p>
      )}

      {queues.runs.length > 0 && (
        <section aria-label="Run agentici in approvazione" className="space-y-2">
          <h4 className="text-sm font-medium">Run agentici ({queues.runs.length})</h4>
          {queues.runs.map(({ workId, workTitle, run }) => (
            <article key={run.id} className="rounded border border-neutral-200 p-3 space-y-1 dark:border-neutral-800">
              <p className="text-sm">
                <strong>{workTitle}</strong> — run <code>{run.id}</code>
                {isPolicyApproved(run) && (
                  <span className="ml-2 text-xs text-neutral-500">
                    approvazione automatica prevista dalla policy
                  </span>
                )}
              </p>
              <div className="flex gap-2">
                <button
                  className="cw-primary"
                  disabled={busy !== null}
                  onClick={() => void act(`${run.id}:approve`, () => approveAgentRun(workId, run, `ui-approve-${run.id}`))}
                >
                  Approva ed esegui
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {queues.terminal.length > 0 && (
        <section aria-label="Comandi terminale in approvazione" className="space-y-2">
          <h4 className="text-sm font-medium">Comandi terminale ({queues.terminal.length})</h4>
          {queues.terminal.map(({ workId, workTitle, job }) => (
            <article key={job.id} className="rounded border border-neutral-200 p-3 space-y-1 dark:border-neutral-800">
              <p className="text-sm">
                <strong>{workTitle}</strong> — <code>{job.command}</code>
              </p>
              <p className="text-xs text-neutral-500">
                Sandbox: {job.image ? 'container con immagine fissata' : 'nessuna immagine'}
              </p>
              <button
                className="cw-primary"
                disabled={busy !== null}
                onClick={() => void act(`${job.id}:approve`, () => terminalAction(workId, job, 'approve'))}
              >
                Approva ed esegui il comando
              </button>
            </article>
          ))}
        </section>
      )}

      {queues.edits.length > 0 && (
        <section aria-label="Modifiche file in approvazione" className="space-y-2">
          <h4 className="text-sm font-medium">Modifiche file ({queues.edits.length})</h4>
          {queues.edits.map(({ workId, workTitle, edit }) => (
            <article key={edit.id} className="rounded border border-neutral-200 p-3 space-y-1 dark:border-neutral-800">
              <p className="text-sm">
                <strong>{workTitle}</strong> — <code>{edit.path}</code>
              </p>
              {edit.diff_preview && (
                <details>
                  <summary>Differenza proposta</summary>
                  <pre className="text-xs overflow-x-auto">{edit.diff_preview}</pre>
                </details>
              )}
              <button
                className="cw-primary"
                disabled={busy !== null}
                onClick={() => void act(`${edit.id}:approve`, () => approveFileEdit(workId, edit))}
              >
                Approva e scrivi il file
              </button>
            </article>
          ))}
        </section>
      )}

      {queues.skills.length > 0 && (
        <section aria-label="Skill in quarantena" className="space-y-2">
          <h4 className="text-sm font-medium">Skill proposte ({queues.skills.length})</h4>
          {queues.skills.map((skill) => (
            <article key={skill.id} className="rounded border border-neutral-200 p-3 space-y-1 dark:border-neutral-800">
              <p className="text-sm">
                <strong>{skill.name}</strong>
                <span className="ml-2 text-xs text-neutral-500">
                  proposta da {skill.author_type === 'agent' ? 'un agente' : 'una persona'} · rev {skill.revision}
                </span>
              </p>
              {skill.description && <p className="text-sm">{skill.description}</p>}
              {skill.body && (
                <details>
                  <summary>Contenuto proposto</summary>
                  <pre className="text-xs whitespace-pre-wrap max-h-64 overflow-y-auto">{skill.body}</pre>
                </details>
              )}
              <p className="text-xs text-neutral-500">
                In quarantena: non guida nessun run finché non la approvi.
              </p>
              <div className="flex gap-2">
                <button
                  className="cw-primary"
                  disabled={busy !== null}
                  onClick={() => void act(`${skill.id}:approve`, () =>
                    skillEngineAction({ skillId: skill.id, action: 'approve', expectedVersion: skill.revision }))}
                >
                  Approva nel catalogo
                </button>
                <button
                  className="cw-secondary"
                  disabled={busy !== null}
                  onClick={() => void act(`${skill.id}:reject`, () =>
                    skillEngineAction({ skillId: skill.id, action: 'reject', expectedVersion: skill.revision }))}
                >
                  Respingi
                </button>
              </div>
            </article>
          ))}
        </section>
      )}

      {actorId && <p className="text-xs text-neutral-500">Operazioni come {actorId}.</p>}
    </div>
  );
}

function isPolicyApproved(run: { status: string }): boolean {
  // Le approvazioni automatiche sono visibili nel run esteso; il tipo pubblico
  // non le espone, quindi il pannello le mostra quando presenti.
  const channel = (run as unknown as { _approval_channel?: string })._approval_channel;
  return typeof channel === 'string' && channel.startsWith('policy:');
}
