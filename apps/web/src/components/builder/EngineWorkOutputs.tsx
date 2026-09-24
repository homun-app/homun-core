import { useEffect,useState } from 'react';
import { HomunErrorNotice } from '@/components/HomunErrorNotice';
import { listWorkOutputs,downloadWorkOutput,type WorkOutput } from '@/lib/engine-work-outputs-client';

export function WorkOutputList({items,busy,onDownload}:{items:WorkOutput[];busy:boolean;onDownload:(item:WorkOutput)=>void}) {
  return items.length>0 ? <section aria-label="File prodotti da Homun">
    <h3>File prodotti</h3><p>Copie salvate per la tua verifica. Non sono risultati già approvati.</p>
    <ul>{items.map(item=><li key={item.id}>
      <strong>{item.filename}</strong> · {item.byte_size} byte
      <button className="cw-secondary" disabled={busy} onClick={()=>onDownload(item)}>Scarica {item.filename}</button>
      <details><summary>Provenienza</summary><p>Run: {item.run_id}</p><code>SHA256: {item.sha256}</code></details>
    </li>)}</ul>
  </section>:null;
}
export function EngineWorkOutputs({workId}:{workId:string}) {
  const [items,setItems]=useState<WorkOutput[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<unknown>(null);
  useEffect(()=>{
    let live=true;let timer:ReturnType<typeof setTimeout>;
    async function read(){
      try{const next=await listWorkOutputs(workId);if(live){setItems(next);setError(null);}}
      catch(cause){if(live){setItems([]);setError(cause);}}
      finally{if(live)timer=setTimeout(()=>void read(),2000);}
    }
    void read();return()=>{live=false;clearTimeout(timer);};
  },[workId]);
  async function download(item:WorkOutput){
    if(busy)return;setBusy(true);setError(null);
    try{
      const blob=await downloadWorkOutput(workId,item);const url=URL.createObjectURL(blob);
      const link=document.createElement('a');link.href=url;link.download=item.filename;link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(cause){setError(cause);}finally{setBusy(false);}
  }
  return <><WorkOutputList items={items} busy={busy} onDownload={item=>void download(item)} /><HomunErrorNotice error={error}/></>;
}
