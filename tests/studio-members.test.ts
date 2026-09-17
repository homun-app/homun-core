import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesMember } from "../apps/web/src/lib/studio-members.ts";
test("searches responsibility, specialization and activity without requiring a name",()=>{
 const member={id:"elio",name:"Elio",role:"Qualità",responsibility:"Individua errori nei log",specializations:["Pianificazione"],activities:[{id:"a",title:"Controllare fatture",scope:"",mode:"stage" as const}]};
 for(const q of ["errori log","qualita","pianificazione","fatture"]) assert.ok(matchesMember(member,q));
 assert.equal(matchesMember(member,"marketing"),false);
});
test("search over a large directory remains specific",()=>{
 const members=Array.from({length:120},(_,i)=>({id:String(i),name:"Agente "+i,responsibility:i===73?"Ricerca fornitori meccanici":"Gestione documenti"}));
 assert.deepEqual(members.filter(m=>matchesMember(m,"fornitori meccanici")).map(m=>m.id),["73"]);
});
