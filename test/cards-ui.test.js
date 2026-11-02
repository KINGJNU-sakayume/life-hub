import test from 'node:test';
import assert from 'node:assert/strict';
import { TestD1 } from '../scripts/node-test/d1.mjs';
import { handleMcpRequest } from '../src/mcp/protocol.js';
import { TOOLS, callTool } from '../src/mcp/tools.js';
import { CARD_PREVIEW_HTML, CARD_PREVIEW_URI } from '../src/mcp/cards/widget.js';
import { READING_PREVIEW_URI } from '../src/mcp/reading-widget.js';

const when = () => Date.parse('2026-11-02T09:00:00Z');
const mk = (db, source) => ({ db, source, ownerId:'synthetic-owner', now: when, scopes:['hub:propose'], allowedOrigins:['https://hub.example'] });
const previews = [
 ['preview_reading_record', { title:'가상의 책 A', state:'reading', current_page:115 }, 'reading', 'letterbookxd', 'propose_reading_record'],
 ['preview_food_meal', { menu_name:'Synthetic ramen', place_name:'Imaginary shop', verdict:'LIKE' }, 'meal', 'food', 'propose_food_meal'],
 ['preview_food_wish', { wish_kind:'visit_place', name:'Imaginary cafe' }, 'wish', 'food', 'propose_food_wish'],
 ['preview_memory', { title:'Fictional festival', memo:'A synthetic memory', emotions:['행복'], time_text:'2026 autumn' }, 'memory', 'kyeokyeoi', 'propose_memory'],
 ['preview_region_visit', { place_text:'Imaginary province', region_hint:'서울 마포구' }, 'visit', 'kyeokyeoi', 'propose_region_visit'],
];

const request = (method, params={}, id=1) => new Request('https://hub.example/mcp', {
 method:'POST', headers:{'Content-Type':'application/json','MCP-Protocol-Version':'2025-06-18'},
 body:JSON.stringify({jsonrpc:'2.0',id,method,params}),
});
async function run(db,source,method,params) {
 const res = await handleMcpRequest(request(method,params),mk(db,source));
 return {status:res.status,body:await res.json()};
}

test('shared card HTML is portable, bounded, keyboard accessible and never calls writes on startup',()=>{
 assert.equal(CARD_PREVIEW_URI,'ui://life-hub/proposal-preview.html');
 assert.match(CARD_PREVIEW_HTML,/ui\/initialize/);
 assert.match(CARD_PREVIEW_HTML,/ui\/notifications\/tool-result/);
 assert.match(CARD_PREVIEW_HTML,/ui\/notifications\/initialized/);
 assert.match(CARD_PREVIEW_HTML,/ui\/notifications\/size-changed/);
 assert.match(CARD_PREVIEW_HTML,/MCP Apps/);
 assert.match(CARD_PREVIEW_HTML,/prefers-reduced-motion/);
 assert.match(CARD_PREVIEW_HTML,/focus-visible/);
 assert.match(CARD_PREVIEW_HTML,/role="status"/);
 assert.match(CARD_PREVIEW_HTML,/role="alert"/);
 assert.match(CARD_PREVIEW_HTML,/aria-pressed/);
 assert.match(CARD_PREVIEW_HTML,/\.textContent=/);
 assert.doesNotMatch(CARD_PREVIEW_HTML,/https?:\/\/[^'"]+\.(?:js|css|woff|png)/);
 assert.doesNotMatch(CARD_PREVIEW_HTML,/fetch\(|XMLHttpRequest|localStorage|sessionStorage/);
 assert.match(CARD_PREVIEW_HTML,/\$\('entry'\)\.addEventListener\('submit'/);
 assert.ok(CARD_PREVIEW_HTML.length<30000,'Worker keeps card template below 30k chars');
});

test('Claude and ChatGPT see 5 schema-specific previews; Codex and unknown clients do not', async()=>{
 const db=new TestD1();try{
 for(const source of ['claude','chatgpt']){
  const list=(await run(db,source,'tools/list')).body.result.tools;
  assert.equal(list.filter(t=>t.name.startsWith('preview_')).length,5);
  assert.equal(list.length,15);
  assert.equal(list.find(t=>t.name==='preview_food_meal')._meta.ui.resourceUri,CARD_PREVIEW_URI);
  const resources=(await run(db,source,'resources/list')).body.result.resources;
  assert.deepEqual(resources.map(x=>x.uri),[CARD_PREVIEW_URI,READING_PREVIEW_URI]);
  const read=(await run(db,source,'resources/read',{uri:CARD_PREVIEW_URI})).body.result.contents[0];
  assert.equal(read.mimeType,'text/html;profile=mcp-app');
  assert.deepEqual(read._meta.ui.csp,{connectDomains:[],resourceDomains:[]});
 }
 for(const source of ['codex',undefined]){
  const list=(await run(db,source,'tools/list')).body.result.tools;
  assert.equal(list.length,10);
  assert.equal((await run(db,source,'resources/read',{uri:CARD_PREVIEW_URI})).body.error.code,-32601);
 }
 }finally{db.close()}
});

test('all contextual previews reuse destination validation and do not insert a record',async()=>{
 const db=new TestD1();try{
 for(const [tool,args,variant,destination,write] of previews){
  for(const source of ['claude','chatgpt']){
   const result=await callTool(tool,args,mk(db,source));
   assert.equal(result.isError,undefined,tool+' '+JSON.stringify(result));
   assert.deepEqual(result.structuredContent,{variant,draft:args,destination,status:'preview'});
   const expectedTool=TOOLS.find(t=>t.name===tool);
   assert.equal(expectedTool.annotations.readOnlyHint,true);
   assert.equal(expectedTool._meta.ui.resourceUri,tool==='preview_reading_record'?READING_PREVIEW_URI:CARD_PREVIEW_URI);
   assert.ok(TOOLS.some(t=>t.name===write));
  }
 }
 assert.equal((await db.prepare('SELECT COUNT(*) as n FROM inbox').bind().first()).n,0);
 }finally{db.close()}
});

test('unsupported Codex source, malformed record and illegal memory emotions never create a candidate', async()=>{
 const db=new TestD1();try{
 const denied=await callTool('preview_memory',{title:'Synthetic'},mk(db,'codex'));
 assert.equal(denied,null);
 for(const [tool,args] of [
  ['preview_reading_record',{title:'Book A',state:'completed',current_page:115}],
  ['preview_food_meal',{menu_name:'Synthetic food',eaten_on:'2026-02-30'}],
  ['preview_memory',{title:'Synthetic memory',emotions:['impossible']}],
  ['preview_region_visit',{place_text:'Imaginary place',visited_on:'2026-02-31'}],
 ]){
  const result=await callTool(tool,args,mk(db,'claude'));
  assert.equal(result.isError,true,tool);
 }
 assert.equal((await db.prepare('SELECT COUNT(*) as n FROM inbox').bind().first()).n,0);
 }finally{db.close()}
});

test('user-submitted proposal is pending and preserved under the original write tool',async()=>{
 const db=new TestD1();try{
 const args={title:'Synthetic Book',state:'reading',current_page:115};
 const preview=await callTool('preview_reading_record',args,mk(db,'claude'));
 assert.equal(preview.structuredContent.status,'preview');
 assert.equal((await db.prepare('SELECT COUNT(*) as n FROM inbox').bind().first()).n,0);
 // Simulates the iframe's explicit form submit. No approval/commit operation is exposed.
 const saved=await callTool('propose_reading_record',{...args,current_page:119},mk(db,'claude'));
 assert.equal(saved.structuredContent.status,'pending');
 const entry=await db.prepare('SELECT status,source,envelope_json FROM inbox').bind().first();
 assert.equal(entry.status,'pending');
 assert.equal(entry.source,'claude');
 assert.equal(JSON.parse(entry.envelope_json).payload.current_page,119);
 const id=saved.structuredContent.candidate_id;
 assert.equal((await callTool('get_proposal_status',{candidate_id:id},mk(db,'claude'))).structuredContent.status,'pending');
 assert.ok(!TOOLS.some(t=>/approve|reject|edit/.test(t.name)));
 }finally{db.close()}
});
