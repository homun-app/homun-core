import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentRenderer } from './helpers/render-component.ts';

test('server picker limits new choices to four and excludes disabled declarations', async () => {
  const renderer = await componentRenderer('apps/web/src/components/builder/EngineAgentServerPicker.tsx', 'AgentServerChoices');
  try {
    const html = renderer.render({servers:Array.from({length:6},(_,i)=>({id:`s${i}`,name:`Server ${i}`,status:i===5?'disabled':'enabled'})), selected:['s0','s1','s2','s3'], disabled:false,onChange:()=>{}});
    assert.equal((html.match(/type="checkbox"/g) ?? []).length,5);
    assert.equal((html.match(/disabled=""/g) ?? []).length,1);
    assert.match(html,/approvazione separata/);
  } finally { await renderer.close(); }
});

test('external proposal shows exact arguments and requires explicit approval', async () => {
  const renderer = await componentRenderer('apps/web/src/components/builder/EngineAgentExternalApproval.tsx', 'AgentExternalProposal');
  try {
    const call = {id:'exact',server_name:'Calendar',tool:'create_event',tool_description:'Creates an event',arguments:{title:'Review'},status:'pending_approval'};
    const html = renderer.render({call,busy:false,onApprove:()=>{}});
    assert.match(html,/Calendar/); assert.match(html,/Creates an event/); assert.match(html,/Review/);
    assert.match(html,/Approva ed esegui/);
    const cancelled = renderer.render({call,busy:false,active:false,onApprove:()=>{}});
    assert.doesNotMatch(cancelled,/Approva ed esegui/);
    const done = renderer.render({call:{...call,status:'result_ready'},busy:false,onApprove:()=>{}});
    assert.doesNotMatch(done,/Approva ed esegui/); assert.match(done,/continuare/);
  } finally { await renderer.close(); }
});
