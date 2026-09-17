import {test} from "node:test";
import assert from "node:assert/strict";
import {filterConversation,messageProjectIds,type ConversationMessage} from "../apps/web/src/lib/studio-conversations.ts";
const messages:ConversationMessage[]=[
{id:"general",text:"Ciao",files:[],taskIds:[],projectIds:[],createdAt:""},
{id:"a",text:"",files:[],taskIds:["a"],projectIds:["p"],createdAt:""},
{id:"b",text:"",files:[],taskIds:["b"],projectIds:["p","q"],createdAt:""},
];
test("general excludes referenced messages",()=>assert.deepEqual(filterConversation(messages,{general:true,taskIds:[],projectIds:[]}).map(m=>m.id),["general"]));
test("filters combine groups and accept multiple choices",()=>assert.deepEqual(filterConversation(messages,{general:false,taskIds:["a","b"],projectIds:["q"]}).map(m=>m.id),["b"]));
test("no filters retains all conversation messages",()=>assert.equal(filterConversation(messages,{general:false,taskIds:[],projectIds:[]}).length,3));
test("task projects are inherited once and standalone tasks do not add a project",()=>assert.deepEqual(messageProjectIds(["p","q"],["a","b"],[{id:"a",project:"p"},{id:"b",project:""}]),["p","q"]));
