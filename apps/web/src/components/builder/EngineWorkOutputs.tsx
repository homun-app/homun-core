import { useEffect,useState } from 'react';
import { HomunErrorNotice } from '@/components/HomunErrorNotice';
import { listWorkOutputs,downloadWorkOutput,type WorkOutput } from '@/lib/engine-work-outputs-client';

import { Download, FileText, CheckCircle2 } from 'lucide-react';

export function WorkOutputList({items,busy,onDownload}:{items:WorkOutput[];busy:boolean;onDownload:(item:WorkOutput)=>void}) {
  if (items.length === 0) return null;
  return (
    <section className="cw-engine-outputs" aria-label="Output di fase e materiali del Vault">
      <div className="cw-engine-summary__section-heading">
        <h3>Artefatti prodotti</h3>
        <span className="cw-intake-note">{items.length} {items.length === 1 ? "file" : "file"}</span>
      </div>
      <p className="cw-engine-summary__hint">
        Copie salvate per la tua verifica. Non sono risultati già approvati. Conservati nel Vault di progetto per future lavorazioni.
      </p>
      <ul className="cw-engine-outputs__list">
        {items.map((item) => (
          <li key={item.id} className="cw-engine-outputs__item">
            <div className="cw-engine-outputs__item-header">
              <span className="cw-engine-outputs__icon">
                <FileText size={14} />
              </span>
              <div className="cw-engine-outputs__item-info">
                <strong>{item.filename}</strong>
                <span className="cw-engine-outputs__meta">
                  {(item.byte_size / 1024).toFixed(1)} KB · <CheckCircle2 size={11} className="inline mr-1" /> Salvato nel Vault
                </span>
              </div>
            </div>
            <div className="cw-engine-outputs__actions">
              <button
                type="button"
                className="cw-secondary cw-engine-outputs__dl-btn"
                disabled={busy}
                onClick={() => onDownload(item)}
              >
                <Download size={12} /> Scarica {item.filename}
              </button>
            </div>
            <details className="cw-engine-outputs__provenance">
              <summary>Dettagli tecnici</summary>
              <div>
                <p><strong>Run ID:</strong> {item.run_id}</p>
                <code>SHA256: {item.sha256}</code>
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
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
