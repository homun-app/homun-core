import test from "node:test";
import assert from "node:assert/strict";
import { effectiveFileAccess, type ProjectFile } from "../apps/web/src/lib/studio-files.ts";
const folder:ProjectFile={id:"folder",parentId:null,name:"Riservati",kind:"folder",size:0,access:"restricted",allowed:["person:giulia","bot:elio"]};
const child:ProjectFile={id:"child",parentId:"folder",name:"listino.pdf",kind:"file",size:10,access:"inherit",allowed:[]};
test("il file eredita le restrizioni della cartella",()=>assert.deepEqual(effectiveFileAccess("child",[folder,child],["person:giulia","bot:elio","bot:vera"]),["person:giulia","bot:elio"]));
test("un file non può ampliare l'accesso della cartella",()=>assert.deepEqual(effectiveFileAccess("child",[folder,{...child,access:"restricted",allowed:["bot:vera","bot:elio"]}],["person:giulia","bot:elio","bot:vera"]),["bot:elio"]));
test("revocare l'accesso al progetto prevale sui permessi locali",()=>assert.deepEqual(effectiveFileAccess("child",[folder,child],["bot:vera"]),[]));
test("strutture mancanti o cicliche non concedono accesso",()=>{assert.deepEqual(effectiveFileAccess("child",[child],["bot:elio"]),[]);assert.deepEqual(effectiveFileAccess("child",[{...folder,parentId:"folder"},child],["bot:elio"]),[]);});
