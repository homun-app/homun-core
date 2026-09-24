import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentRenderer } from './helpers/render-component.ts';
import { listTerminalJobs, terminalAction } from '../apps/web/src/lib/engine-terminal-client.ts';

test('terminal consent renders exact command and disappears after cancellation', async () => {
  const renderer = await componentRenderer('apps/web/src/components/builder/EngineAgentTerminalApproval.tsx','TerminalProposal');
  try {
    const job={id:'j',command:'echo authorized',image:'sha256:exact',status:'pending_approval',timeout_seconds:300};
    const props={job,busy:false,active:true,act:()=>{}};
    const html=renderer.render(props);
    assert.match(html,/300 secondi/);assert.match(html,/mentre Homun è acceso/);assert.match(html,/echo authorized/);assert.match(html,/sha256:exact/);assert.match(html,/Approva ed esegui il comando/);
    assert.doesNotMatch(renderer.render({...props,active:false}),/Approva ed esegui il comando/);
    const running=renderer.render({...props,active:false,job:{...job,status:'running'}});
    assert.match(running,/Arresta il processo/);assert.match(running,/non conferma/);
    const done=renderer.render({...props,job:{...job,status:'exited',exit_code:7,timed_out:true,logs:{text:'partial',truncated:true,line_limit:1000}}});
    assert.match(done,/Durata superata/);assert.match(done,/uscita 7/);assert.match(done,/Output ridotto/);assert.doesNotMatch(done,/Arresta il processo/);
  } finally {await renderer.close();}
});

test('terminal reads are inert and approval sends only the reviewed digest',async()=>{
  const old=globalThis.fetch;const calls:{method:string;url:string;body:unknown}[]=[];
  globalThis.fetch=async(url,init)=>{calls.push({method:init?.method??'GET',url:String(url),body:init?.body?JSON.parse(String(init.body)):null});return Response.json({items:[],id:'j',status:'running'});};
  try {
    await listTerminalJobs('work/1');
    await terminalAction('work/1',{id:'job/1',digest:'reviewed'} as never,'approve');
    assert.equal(calls[0].method,'GET');assert.equal(calls[0].body,null);
    assert.match(calls[1].url,/works\/work%2F1\/terminal-jobs\/job%2F1\/approve$/);
    assert.deepEqual(calls[1].body,{digest:'reviewed'});
  } finally {globalThis.fetch=old;}
});
