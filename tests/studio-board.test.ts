import {test} from "node:test";
import assert from "node:assert/strict";
import {moveIssue,moveWork} from "../apps/web/src/lib/studio-board.ts";
import {reconcileProcedureTasks,createProcedureRun} from "../apps/web/src/lib/studio-pipelines.ts";
const human={id:"a",title:"Telefonare al fornitore",person:"user:fabio",project:"",status:"doing" as const};
test("manual work can finish without manufacturing a document",()=>assert.equal(moveWork([human],"a","done")[0]!.status,"done"));
test("blocked work and another reviewer cannot be bypassed",()=>{
 assert.ok(moveIssue({...human,steps:[{id:"s",title:"Risposta",done:false,blocker:"bot:elio"}]},"done"));
 assert.ok(moveIssue({...human,approver:"user:giulia"},"done"));
});
test("moving work updates canonical order and preserves other tasks",()=>{
 const tasks=[human,{...human,id:"b"}];
 assert.deepEqual(moveWork(tasks,"b","todo","a").map(t=>t.id),["b","a"]);
 assert.equal(tasks[1]!.status,"doing");
});
test("approving from board releases the next pipeline step",()=>{
 const tasks=createProcedureRun({id:"p",name:"Test",project:"",trigger:"manual",time:"09:00",days:[],interval:30,event:"",active:false,steps:[{id:"a",title:"A",person:"elio",materials:"",approval:true},{id:"b",title:"B",person:"vera",materials:"",approval:true}]},"run");
 tasks[0]={...tasks[0]!,status:"review",result:"Risultato",steps:[{id:"execute",title:"A",done:true}]};
 const next=reconcileProcedureTasks(moveWork(tasks,tasks[0]!.id,"done"));
 assert.equal(next.find(t=>t.id==="run-b")!.status,"todo");
});
test("stage requires a method before starting or submitting work",()=>{
 const task={...human,person:"elio",training:{activity:"Analisi",scope:"Log",mode:"stage" as const},result:"Sintesi"};
 assert.match(moveIssue(task,"doing"),/metodo/);
 assert.match(moveIssue(task,"review"),/metodo/);
 assert.equal(moveIssue({...task,steps:[{id:"s",title:"Controllare i log",done:false}]},"doing"),"");
});
test("training review remains required even when an old automation skips approval",()=>{
 const task={...human,person:"elio",training:{activity:"Analisi",scope:"Log",mode:"review" as const},result:"Sintesi",rule:{approval:false} as any};
 assert.match(moveIssue(task,"done"),/revisione/);
 assert.equal(moveIssue({...task,status:"review"},"done"),"");
});
