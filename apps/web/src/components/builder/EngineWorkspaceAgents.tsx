import type {EngineAgentProfile} from '@/lib/engine-agents-client';
/** Only persisted agent profiles; never substitute prototype collaborators. */
export function EngineWorkspaceAgents({agents}:{agents:EngineAgentProfile[]}){
 return <section className="cw-workspace" aria-label="Collaboratori del motore">
  <div className="cw-panel-top"><h2>La tua squadra</h2><span className="cw-hint">Fonte: motore</span></div>
  <p>I collaboratori proposti in chat entrano nella squadra dopo la tua conferma. Il loro profilo non concede automaticamente nuovi accessi o strumenti.</p>
  {agents.length===0&&<p>Non hai ancora creato collaboratori. Racconta a Homun il lavoro che vuoi affidare.</p>}
  {agents.map(agent=><section key={agent.id}><h3>{agent.name}</h3><p>{agent.role}</p><details><summary>Istruzioni del collaboratore</summary><p>{agent.instructions}</p></details></section>)}
 </section>;
}
