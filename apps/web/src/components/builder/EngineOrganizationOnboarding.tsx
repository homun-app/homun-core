import { useEffect, useState } from 'react';
import { HomunErrorNotice } from '@/components/HomunErrorNotice';
import { organizationRequest, type OrganizationContext, type OrganizationState, type OrganizationProposal } from '@/lib/engine-organization-client';
import { HomunClientError } from '@/lib/homun-errors';
import './engine-organization.css';

const labels: Record<keyof OrganizationContext, string> = {
  company: 'Di cosa si occupa la tua azienda?', people: 'Persone e responsabilità',
  tools: 'Strumenti che usate oggi', goals: 'Difficoltà e obiettivi da migliorare',
};

export function EngineOrganizationOnboarding({ onChanged }: { onChanged?: (() => Promise<void>) | undefined }) {
  const [open, setOpen] = useState(false);
  return <section className="organization-onboarding">
    <button type="button" className="cw-secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
      {open ? 'Chiudi contesto e squadra' : 'Costruisci la tua squadra'}
    </button>
    {open && <OrganizationEditor onChanged={onChanged} />}
  </section>;
}

function OrganizationEditor({ onChanged }: { onChanged?: (() => Promise<void>) | undefined }) {
  const [state, setState] = useState<OrganizationState | null>(null);
  const [draft, setDraft] = useState<OrganizationContext | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { let active = true; organizationRequest<OrganizationState>().then(value => {
    if (active) { setState(value); setDraft(value.context); }
  }).catch(e => { if (active) setError(e); }); return () => { active = false; }; }, []);
  const dirty = draft && state && JSON.stringify(draft) !== JSON.stringify(state.context);
  async function act(action: 'save' | 'propose' | 'confirm') {
    if (!state || !draft) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      let revision = state.revision;
      if (action !== 'confirm' && (dirty || revision === 0)) {
        const result = await organizationRequest<OrganizationState>('/context', { ...draft, command_id: crypto.randomUUID(), expected_revision: revision });
        revision = result.revision;
        setState({ ...result, proposal: null });
      }
      if (action === 'save') setSaved(true);
      else {
        const proposal = await organizationRequest<OrganizationProposal>(`/${action}`, {
          command_id: crypto.randomUUID(), expected_revision: revision,
          ...(action === 'confirm' ? { proposal_id: state.proposal?.id } : {}),
        });
        setState({ revision, context: draft, proposal });
        if (action === 'confirm') await onChanged?.();
      }
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  const proposal = state?.proposal;
  return <div className="organization-editor">
    <h2>Una squadra per il tuo lavoro</h2>
    <p>Fonte: motore · Facoltativo. Descrivi il contesto, rivedi la proposta e scegli se creare i collaboratori.</p>
    <p>Le persone descritte restano contesto: inviti e collaborazione con altre persone arriveranno in seguito.</p>
    <HomunErrorNotice error={error} />
    {!draft ? <p>Caricamento del contesto…</p> : <>
      {(Object.keys(labels) as (keyof OrganizationContext)[]).map(key => <label key={key}>
        {labels[key]}<textarea rows={3} maxLength={key === 'company' || key === 'goals' ? 6000 : 4000}
          disabled={busy} value={draft[key]} onChange={e => { setDraft({ ...draft, [key]: e.target.value }); setSaved(false); }} />
      </label>)}
      <div className="organization-actions">
        <button type="button" className="cw-secondary" disabled={busy} onClick={() => void act('save')}>Salva contesto</button>
        <button type="button" className="cw-secondary" disabled={busy || !Object.values(draft).some(v => v.trim())} onClick={() => void act('propose')}>
          {busy ? 'Attendi…' : 'Proponi la squadra'}
        </button>
      </div>
      <p role="status">{saved ? 'Contesto salvato. Lo ritroverai qui alla riapertura.' : dirty ? 'Modifiche da salvare.' : `Contesto salvato · versione ${state?.revision}`}</p>
      {proposal?.status === 'failed' && <HomunErrorNotice error={new HomunClientError(proposal.error_code === 'organization_provider_failed' ? 'provider_unavailable' : 'validation_error', `Proposta non disponibile (${proposal.error_code}). Puoi correggere il contesto o riprovare.`)} />}
      {proposal?.team && <article>
        <h3>{proposal.team.name}</h3><p>{proposal.team.description}</p>
        <p>Creare un profilo non collega strumenti né concede accessi. Ogni lavoro e i suoi permessi si concordano separatamente.</p>
        {proposal.team.agents.map((agent, i) => <section key={i} className="organization-role">
          <h4>{agent.name} · {agent.role}</h4><p>{agent.instructions}</p>
          <p>Capacità dichiarate: {agent.capabilities.join(', ') || 'Da definire'}</p>
          <p>Strumenti necessari, da verificare: {agent.tools_required.join(', ') || 'Nessuno indicato'}</p>
        </section>)}
        {proposal.team.questions.length > 0 && <><h4>Da chiarire</h4><ul>{proposal.team.questions.map((v,i) => <li key={i}>{v}</li>)}</ul></>}
        {proposal.team.limitations.length > 0 && <><h4>Limiti</h4><ul>{proposal.team.limitations.map((v,i) => <li key={i}>{v}</li>)}</ul></>}
        {proposal.status === 'confirmed' ? <p role="status">Squadra creata. I collaboratori sono disponibili in Squadra.</p> :
          <button type="button" className="cw-secondary" disabled={busy || !!dirty || proposal.status !== 'pending_confirmation'} onClick={() => void act('confirm')}>
            Conferma e crea {proposal.team.agents.length} collaboratori e il team
          </button>}
      </article>}
    </>}
  </div>;
}
