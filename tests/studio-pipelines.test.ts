import {test} from "node:test";
import assert from "node:assert/strict";
import {createProcedureRun,reconcileProcedureTasks,procedureIssue,type Procedure} from "../apps/web/src/lib/studio-pipelines.ts";
const p:Procedure={id:"p",name:"Prova",project:"",trigger:"manual",time:"09:00",days:[],interval:60,event:"",active:false,steps:["a","b","c"].map(id=>({id,title:id,person:id,materials:"",approval:true}))};
test("ogni esecuzione ha incarichi distinti e dipendenze ordinate",()=>{const a=createProcedureRun(p,"one"),b=createProcedureRun(p,"two");assert.equal(a[1].dependsOn,a[0].id);assert.notEqual(a[0].id,b[0].id);assert.equal(a[1].status,"blocked");});
test("approvazione sblocca il successivo, riapertura propaga il blocco",()=>{let t=createProcedureRun(p,"one");t[0].status="review";t[0].steps!.forEach(s=>s.done=true);assert.equal(reconcileProcedureTasks(t)[1].status,"blocked");t[0].status="done";t=reconcileProcedureTasks(t);assert.equal(t[1].status,"todo");t[1].status="done";t[1].steps!.forEach(s=>s.done=true);t=reconcileProcedureTasks(t);assert.equal(t[2].status,"todo");t[0].status="doing";t=reconcileProcedureTasks(t);assert.equal(t[1].status,"blocked");assert.equal(t[2].status,"blocked");});
test("configurazioni incomplete non generano incarichi",()=>{assert.ok(procedureIssue({...p,trigger:"schedule"}));assert.throws(()=>createProcedureRun({...p,steps:[]},"x"));assert.ok(procedureIssue({...p,trigger:"interval",interval:0}));});
test("intervalli richiedono giorni e finestra valida",()=>{
 assert.ok(procedureIssue({...p,trigger:"interval",days:[]}));
 assert.ok(procedureIssue({...p,trigger:"interval",days:["Lun"],from:"18:00",until:"09:00"}));
 assert.equal(procedureIssue({...p,trigger:"interval",days:["Lun","Mar"],from:"09:00",until:"18:00"}),"");
});
test("approvatore esplicito passa agli incarichi",()=>{
 const run=createProcedureRun({...p,steps:[{...p.steps[0]!,approver:"user:giulia"}]},"approval");
 assert.equal(run[0]!.approver,"user:giulia");
});
