import {test} from "node:test";
import assert from "node:assert/strict";
import {hasDelivery,acceptDelivery} from "../apps/web/src/lib/studio-handoffs.ts";
const parent={id:"p",title:"Preventivo",person:"marta",project:"",status:"blocked" as const,steps:[{id:"listino",title:"Listino",done:false,blocker:"user:giulia"}]};
const file=new File(["prezzi"],"listino.txt");
const response={id:"r",title:"Invia listino",person:"user:giulia",project:"",status:"done" as const,requestFor:"p:listino",resultFiles:[file]};
test("an input attachment is not automatically a delivery",()=>assert.equal(hasDelivery({...parent,files:[file]}),false));
test("file-only delivery releases the dependency and retains the same file",()=>{
 const next=acceptDelivery(parent,"listino",response);
 assert.equal(next.steps![0]!.done,true);
 assert.equal(next.files![0],file);
 assert.equal(next.deliveries![0]!.taskId,"r");
});
test("unrelated or unfinished deliveries cannot unlock work",()=>{
 assert.equal(acceptDelivery(parent,"listino",{...response,status:"review"}),parent);
 assert.equal(acceptDelivery(parent,"other",response),parent);
});
test("a revised delivery reopens the receiving work", async()=>{
 const {reconcileDeliveries}=await import("../apps/web/src/lib/studio-handoffs.ts");
 const accepted=acceptDelivery(parent,"listino",response);
 const revised=reconcileDeliveries([accepted,{...response,status:"doing"}]);
 assert.equal(revised[0]!.status,"blocked");
 assert.equal(revised[0]!.steps![0]!.done,false);
});
