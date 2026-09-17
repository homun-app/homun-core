import {test} from "node:test";
import assert from "node:assert/strict";
import {defaultRule,initialSimulation,transition,windowOpen,nextWindow,wouldCycle} from "../apps/web/src/lib/studio-simulation.ts";
test("materiale mancante blocca senza spendere, arrivo sblocca",()=>{const r={...defaultRule,needsFile:true};const s=transition(initialSimulation(),"start",r);assert.equal(s.phase,"waiting");assert.equal(s.spent,0);assert.equal(transition(s,"file",r).phase,"running");});
test("evento duplicato non duplica il lavoro",()=>{const r={...defaultRule,trigger:"event" as const};const a=transition(initialSimulation(),"file",r);const b=transition(a,"duplicate",r);assert.equal(b.runs,1);assert.equal(b.spent,.1);});
test("un intervallo non sovrappone esecuzioni",()=>{const r={...defaultRule,trigger:"interval" as const};const a=transition(initialSimulation(),"start",r);assert.equal(transition(a,"tick",r).runs,1);});
test("approvazione precede consegna",()=>{const a=transition(initialSimulation(),"start",defaultRule);const b=transition(a,"finish",defaultRule);assert.equal(b.phase,"review");assert.equal(transition(b,"approve",defaultRule).phase,"delivered");});
test("approvazione senza risultato non ha effetto",()=>assert.equal(transition(initialSimulation(),"approve",defaultRule).phase,"waiting"));
test("consegna diretta solo se configurata",()=>{const r={...defaultRule,approval:false};assert.equal(transition(transition(initialSimulation(),"start",r),"finish",r).phase,"delivered");});
test("dipendenza e file devono essere entrambi disponibili",()=>{const r={...defaultRule,needsFile:true,dependency:"vera",trigger:"task" as const};const a=transition(initialSimulation(),"dependency",r);assert.equal(a.runs,0);assert.equal(transition(a,"file",r).runs,1);});
test("budget evita la spesa successiva",()=>{const r={...defaultRule,budget:.1};let s=transition(initialSimulation(),"start",r);s=transition(s,"finish",r);s=transition(s,"approve",r);s=transition(s,"start",r);assert.equal(s.phase,"paused");assert.equal(s.spent,.1);});
test("pausa impedisce eventi e tick",()=>{const r={...defaultRule,trigger:"interval" as const};let s=transition(initialSimulation(),"pause",r);s=transition(s,"file",r);s=transition(s,"tick",r);assert.equal(s.phase,"paused");assert.equal(s.runs,0);});
test("ripresa non recupera le esecuzioni saltate",()=>{const s=transition({...initialSimulation(),phase:"paused",minute:5000},"resume",defaultRule);assert.equal(s.runs,0);assert.ok(s.next>=5000);});
test("nuovo materiale invalida approvazione",()=>{const s=transition({...initialSimulation(),phase:"delivered",result:true},"changed",defaultRule);assert.equal(s.phase,"waiting");assert.equal(s.result,false);assert.equal(s.version,2);});
test("errore conserva costi e richiede retry",()=>{let s=transition(initialSimulation(),"start",defaultRule);s=transition(s,"fail",defaultRule);assert.equal(transition(s,"start",defaultRule).runs,1);s=transition(s,"retry",defaultRule);assert.equal(s.runs,2);assert.equal(s.spent,.2);});
test("weekend chiuso e prossimo lunedi",()=>{assert.equal(windowOpen(5*1440+600,defaultRule),false);assert.equal(nextWindow(5*1440+600,defaultRule),7*1440+540);});
test("nessun avvio fuori orario",()=>{const s=transition({...initialSimulation(),minute:18*60},"start",defaultRule);assert.equal(s.runs,0);assert.equal(s.next,1440+540);});
test("regola non feriale ammette sabato",()=>assert.equal(windowOpen(5*1440+600,{...defaultRule,weekdays:false}),true));
test("azioni impossibili non completano un lavoro",()=>assert.equal(transition(initialSimulation(),"finish",defaultRule).phase,"waiting"));
test("avvio manuale non parte al solo arrivo del file",()=>{const s=transition(initialSimulation(),"file",defaultRule);assert.equal(s.runs,0);assert.equal(s.file,true);});
test("configurazione dipendenza mancante non parte",()=>assert.equal(transition(initialSimulation(),"start",{...defaultRule,trigger:"task"}).runs,0));
test("intervallo invalido non parte",()=>assert.equal(transition(initialSimulation(),"start",{...defaultRule,every:0}).runs,0));
test("finestra invertita non parte",()=>assert.equal(transition(initialSimulation(),"start",{...defaultRule,from:18,until:9}).runs,0));
test("costo negativo non accredita denaro",()=>assert.equal(transition(initialSimulation(),"start",{...defaultRule,runCost:-1}).spent,0));
test("materiali cambiati non rimuovono pausa",()=>assert.equal(transition({...initialSimulation(),phase:"paused"},"changed",defaultRule).phase,"paused"));
test("evento ripetuto dopo consegna non duplica",()=>{const r={...defaultRule,trigger:"event" as const,approval:false};let s=transition(initialSimulation(),"file",r);s=transition(s,"finish",r);s=transition(s,"duplicate",r);assert.equal(s.runs,1);assert.equal(s.phase,"delivered");});
test("intervallo dopo consegna avvia una nuova esecuzione",()=>{const r={...defaultRule,trigger:"interval" as const,approval:false};let s=transition(initialSimulation(),"start",r);s=transition(s,"finish",r);s=transition(s,"tick",r);assert.equal(s.runs,2);});

test("dipendenza ciclica diretta rifiutata",()=>assert.equal(wouldCycle([], "a","a"),true));
test("dipendenza ciclica indiretta rifiutata",()=>assert.equal(wouldCycle([{id:"b",rule:{dependency:"a"}}],"a","b"),true));
test("dipendenza lineare ammessa",()=>assert.equal(wouldCycle([{id:"b",rule:{dependency:"c"}},{id:"c"}],"a","b"),false));
test("prossimo controllo non rimane nel passato",()=>{const s=transition(initialSimulation(),"start",{...defaultRule,trigger:"interval"});assert.ok(s.next>s.minute);});
test("fuori finestra non consuma budget",()=>{const s=transition({...initialSimulation(),minute:6*1440+540},"start",defaultRule);assert.equal(s.spent,0);});
test("errore non si ripete da solo ad ogni intervallo",()=>{const r={...defaultRule,trigger:"interval" as const};let s=transition(initialSimulation(),"start",r);s=transition(s,"fail",r);s=transition(s,"tick",r);assert.equal(s.runs,1);assert.equal(s.phase,"error");});
test("500 sequenze generate mantengono costi, contatori e stati coerenti",()=>{
 const events=["tick","start","file","duplicate","dependency","finish","approve","pause","resume","fail","retry","changed"] as const;
 let seed=123456;
 for(let i=0;i<500;i++){
   const r={...defaultRule,trigger:(["manual","interval","event","task"] as const)[i%4]!,dependency:i%4===3?"vera":"",needsFile:i%2===0,budget:.3};
   let s=initialSimulation();
   for(let j=0;j<30;j++){
     seed=(seed*1664525+1013904223)>>>0;
     const old=s;s=transition(s,events[seed%events.length]!,r);
     assert.ok(s.spent>=old.spent);assert.ok(s.spent<=r.budget+.000001);
     assert.ok(s.runs>=old.runs&&s.runs<=old.runs+1);
     assert.ok(Math.abs(s.spent-s.runs*r.runCost)<.000001);
     assert.ok(s.minute>=old.minute);assert.ok(s.log.length<=40);
     if(s.phase==="running"){assert.ok(!r.needsFile||s.file);assert.ok(!r.dependency||s.result);}
   }
 }
});
