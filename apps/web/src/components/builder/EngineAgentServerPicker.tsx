/** Selecting capabilities never approves an external action. */
import { useEffect, useState } from 'react';
import { listEngineServers, type ExternalServer } from '@/lib/engine-mcp-client';
import { HomunErrorNotice } from '@/components/HomunErrorNotice';

type Choices = {selected: string[]; disabled: boolean; onChange: (ids: string[]) => void};
export function AgentServerChoices({servers, selected, disabled, onChange}: Choices & {servers: ExternalServer[]}) {
  const enabled = servers.filter(server => server.status === 'enabled');
  if (!enabled.length) return null;
  return <fieldset disabled={disabled}>
    <legend>Strumenti esterni disponibili per questo lavoro</legend>
    <p>Scegli fino a quattro server. Ogni azione esterna richiede una tua approvazione separata.</p>
    {enabled.map(server => <label key={server.id}>
      <input type="checkbox" checked={selected.includes(server.id)}
        disabled={disabled || (selected.length >= 4 && !selected.includes(server.id))}
        onChange={event => onChange(event.target.checked ? [...selected, server.id].slice(0,4) : selected.filter(id => id !== server.id))} />
      {server.name}
    </label>)}
  </fieldset>;
}
export function EngineAgentServerPicker(props: Choices) {
  const [servers, setServers] = useState<ExternalServer[]>([]);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    listEngineServers().then(items => { if (live) setServers(items); }).catch(cause => { if (live) setError(cause); });
    return () => { live = false; };
  }, []);
  return <><AgentServerChoices {...props} servers={servers} /><HomunErrorNotice error={error} /></>;
}
