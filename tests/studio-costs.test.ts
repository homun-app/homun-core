import {test} from "node:test";
import assert from "node:assert/strict";
import {recordedCost,summarizeCosts,remainingBudget} from "../apps/web/src/lib/studio-costs.ts";
import {initialSimulation} from "../apps/web/src/lib/studio-simulation.ts";
const base={id:"a",title:"a",person:"elio",project:""};
test("nessuna misura non equivale a zero",()=>{assert.equal(recordedCost(base),null);assert.deepEqual(summarizeCosts([base,{...base,id:"b",demoCost:0}]),{total:0,unknown:1});});
test("simulazione prevale sull esempio senza doppio conteggio",()=>{assert.equal(recordedCost({...base,demoCost:2,simulation:{...initialSimulation(),spent:.5}}),.5);});
test("residuo sconosciuto senza consuntivo, non negativo oltre il limite",()=>{assert.equal(remainingBudget({...base,costLimit:2}),null);assert.equal(remainingBudget({...base,demoCost:3,costLimit:2}),0);assert.equal(remainingBudget({...base,demoCost:.5,costLimit:2}),1.5);});
