import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentRenderer } from './helpers/render-component.ts';
import { downloadWorkOutput,listWorkOutputs } from '../apps/web/src/lib/engine-work-outputs-client.ts';

test('file delivery displays provenance and keeps review explicit',async()=>{
  const renderer=await componentRenderer('apps/web/src/components/builder/EngineWorkOutputs.tsx','WorkOutputList');
  try{
    const html=renderer.render({items:[{id:'out',filename:'report.txt',byte_size:12,run_id:'origin-run',sha256:'verified-hash'}],busy:false,onDownload:()=>{}});
    assert.match(html,/Scarica report.txt/);assert.match(html,/origin-run/);assert.match(html,/verified-hash/);assert.match(html,/Non sono risultati già approvati/);
  }finally{await renderer.close();}
});

test('download uses authenticated transport and preserves file bytes',async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async(url)=>{
    if(String(url).endsWith('/download')){assert.match(String(url),/works\/w%2F1\/outputs\/out%3A1\/download$/);return new Response(new Uint8Array([0,255,1]));}
    return Response.json({items:[]});
  };
  try{
    assert.deepEqual(await listWorkOutputs('w/1'),[]);
    const blob=await downloadWorkOutput('w/1',{id:'out:1'} as never);
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())],[0,255,1]);
  }finally{globalThis.fetch=old;}
});
