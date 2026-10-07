import { useEffect, useMemo, useState } from "react";
import { HomunErrorNotice } from "@/components/HomunErrorNotice";
import {
  listEngineSkills,
  skillEngineAction,
  syncEngineSkills,
  type Skill,
} from "@/lib/engine-mcp-client";
import "./conversation-unified-models.css";

/**
 * Catalogo skill del motore: ricerca, stati, quarantena e sync dal repository.
 * Fonte: solo motore. Grafica Braun: hairline, tipografia, un solo accento.
 */
export function ConversationSkillsSettingsSection({ actorId }: { actorId?: string }) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | Skill["status"]>("all");
  const [busy, setBusy] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    try {
      setSkills(await listEngineSkills(statusFilter === "all" || statusFilter === "archived"));
      setError(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  async function act(operation: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((skill) => {
      if (statusFilter !== "all" && skill.status !== statusFilter) return false;
      if (!q) return true;
      return (
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [skills, query, statusFilter]);

  const counts = useMemo(() => ({
    all: skills.length,
    approved: skills.filter((s) => s.status === "approved").length,
    staged: skills.filter((s) => s.status === "staged").length,
    archived: skills.filter((s) => s.status === "archived").length,
  }), [skills]);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-[#1c2d22]">Catalogo skill</h3>
          <p className="mt-0.5 text-xs text-[#647a6d]">
            Procedure approvate che guidano i run · quarantena per le proposte · sync dal repository homun-skills.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="cv-unified-btn is-subtle text-xs"
            disabled={busy}
            onClick={() => void act(async () => {
              const result = await syncEngineSkills();
              const parts = [
                result.created?.length ? `+${result.created.length} nuove` : null,
                result.updated?.length ? `${result.updated.length} aggiornate` : null,
                result.kept_human?.length ? `${result.kept_human.length} umane preservate` : null,
              ].filter(Boolean);
              setSyncNote(parts.length ? `Sync: ${parts.join(" · ")}` : "Sync: già allineato");
            })}
          >
            Sincronizza da repository
          </button>
        </div>
      </header>

      <HomunErrorNotice error={error} />
      {syncNote && (
        <p role="status" className="text-xs text-[#235940]">{syncNote}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Cerca per nome, descrizione o tag…"
          aria-label="Cerca nel catalogo skill"
          className="min-w-56 flex-1 rounded-md border border-[#dce4d5] bg-white px-3 py-1.5 text-xs text-[#1c2d22] outline-none placeholder:text-[#9db3ad] focus:border-[#b7d6b3]"
        />
        <div className="flex items-center gap-1 text-[11px]">
          {(["all", "approved", "staged", "archived"] as const).map((status) => (
            <button
              key={status}
              type="button"
              onClick={() => setStatusFilter(status)}
              className={`rounded-full border px-2.5 py-1 transition-colors ${
                statusFilter === status
                  ? "border-[#1c2d22] bg-white text-[#1c2d22]"
                  : "border-transparent text-[#647a6d] hover:text-[#1c2d22]"
              }`}
            >
              {status === "all" ? "Tutte" : status === "approved" ? "Approvate" : status === "staged" ? "In quarantena" : "Archiviate"}
              {" "}
              <span className="tabular-nums text-[#9db3ad]">{counts[status]}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-[#9db3ad]">Caricamento…</p>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-[#647a6d]">Nessuna skill {query ? "corrisponde alla ricerca" : "in questo stato"}.</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((skill) => (
            <SkillRow key={skill.id} skill={skill} busy={busy}
              approve={() => void act(() => skillEngineAction({ skillId: skill.id, action: "approve", expectedVersion: skill.revision }))}
              reject={() => void act(() => skillEngineAction({ skillId: skill.id, action: "reject", expectedVersion: skill.revision }))} />
          ))}
        </div>
      )}

      {actorId && (
        <p className="text-[11px] text-[#9db3ad]">Operazioni come {actorId} · Fonte: motore.</p>
      )}
    </div>
  );
}

function SkillRow({
  skill, busy, approve, reject,
}: {
  skill: Skill;
  busy: boolean;
  approve: () => void;
  reject: () => void;
}) {
  const author = skill.author_type === "agent" ? "agente" : "persona";
  const usage = skill.usage_count > 0
    ? `usata ${skill.usage_count}×`
    : "mai usata";
  return (
    <article className="rq-card">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <strong className="font-mono text-[12px] font-medium text-[#1c2d22]">{skill.name}</strong>
        <span className="text-[11px] text-[#647a6d]">
          rev {skill.revision} · di {skill.author_id || `un ${author}`} · {usage}
          {skill.resources.length > 0 ? ` · ${skill.resources.length} risorse` : ""}
        </span>
        {skill.status === "staged" && (
          <span className="ml-auto text-[11px] font-medium text-[#b3453f]">in quarantena</span>
        )}
        {skill.status === "archived" && (
          <span className="ml-auto text-[11px] text-[#9db3ad]">archiviata</span>
        )}
      </p>
      {skill.description && (
        <p className="mt-1 text-xs text-[#263832]">{skill.description}</p>
      )}
      {skill.body && (
        <details className="mt-1.5">
          <summary className="cursor-pointer text-[11px] text-[#647a6d] hover:text-[#1c2d22]">
            Contenuto
          </summary>
          <pre className="rq-code rq-code--scroll mt-1.5">
            <code>{skill.body}</code>
          </pre>
        </details>
      )}
      {skill.status === "staged" && (
        <div className="rq-footer">
          <span className="rq-hint">Non guida nessun run finché non la approvi.</span>
          <div className="flex gap-1.5">
            <button type="button" className="cv-unified-btn is-subtle text-xs text-red-500 hover:text-red-600"
              disabled={busy} onClick={reject}>
              Respingi
            </button>
            <button type="button" className="cv-unified-btn is-primary text-xs"
              disabled={busy} onClick={approve}>
              Approva
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
