import { test } from "node:test";
import assert from "node:assert/strict";
import { teamSupervision } from "../apps/web/src/lib/studio-supervision.ts";
const members = [{id:"elio"},{id:"vera"},{id:"user:giulia"}];
const resolve = (teams: {members:string[];leader?:string}[]) => teamSupervision("elio",teams,members,"user:fabio");
test("human coordinator supervises and approves",()=>assert.deepEqual(resolve([{members:["elio","user:giulia"],leader:"user:giulia"}]),{supervisor:"user:giulia",approver:"user:giulia"}));
test("agent coordinator never gains human final approval",()=>assert.deepEqual(resolve([{members:["elio","vera"],leader:"vera"}]),{supervisor:"vera",approver:"user:fabio"}));
test("ambiguous teams, no coordinator and self review fall back to owner",()=>{
 for(const teams of [[],[{members:["elio"],leader:"elio"}],[{members:["elio"],leader:"vera"}],[{members:["elio","vera"],leader:"vera"},{members:["elio","user:giulia"],leader:"user:giulia"}]]) assert.equal(resolve(teams).supervisor,"user:fabio");
});
