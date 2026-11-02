/**
 * Shared Life Hub card shell for MCP Apps (ui:// resources, text/html;profile=mcp-app).
 *
 * One look for every destination: eyebrow + status pill, a destination body, and a footer whose only
 * buttons are 「수정」 and 「승인」 (거절 and app links are text links). Values are plain text until the
 * owner opens 「수정」; choice chips toggle off when tapped again (= 선택 안 함).
 *
 * No network access, no external assets (CSP: nothing declared). The page talks to the host only through
 * the MCP Apps postMessage bridge: ui/initialize → ui/notifications/initialized, tool-input/tool-result
 * notifications, tools/call for the app-only card_* tools, ui/open-link, size-changed.
 * The approval ticket arrives in the tool result `_meta` and is only sent back to card_* tools.
 */

const CSS = `
:root{color-scheme:light dark;--bg:transparent;--card:#fff;--line:#e3e3e0;--rule:#ededea;--ink:#17181a;--ink2:#2b2d31;--mute:#5f6368;--soft:#f7f7f5;
--pri:#2448d8;--pri-ink:#fff;--chip-on:#17181a;--chip-on-ink:#fff;--wait:#f1f1ef;--wait-ink:#45484d;--edit:#eef1fd;--edit-ink:#2141c4;
--ok:#e7f4ec;--ok-ink:#1b6b45;--done:#1b6b45;--done-ink:#fff;--warn:#fdf1dc;--warn-ink:#7a4700;--err:#fcedec;--err-ink:#8c1d18;--info:#f1f3fa;--info-ink:#26304f;--field:#cfcfcb}
:root[data-theme=dark]{--card:#1c1d20;--line:#2e3035;--rule:#2e3035;--ink:#ececec;--ink2:#d9dadc;--mute:#a3a6ab;--soft:#25272b;--pri:#8fa6ff;--pri-ink:#0e1433;
--chip-on:#ececec;--chip-on-ink:#17181a;--wait:#2a2c31;--wait-ink:#d0d2d6;--edit:#232a47;--edit-ink:#b9c6ff;--ok:#17352a;--ok-ink:#8fd9b4;--done:#8fd9b4;--done-ink:#0f241b;
--warn:#3a2c12;--warn-ink:#f2c879;--err:#3d1f1d;--err-ink:#f2a49b;--info:#22283a;--info-ink:#c7d0ee;--field:#43464c}
*{box-sizing:border-box}
html,body{margin:0;background:transparent}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Noto Sans KR","Malgun Gothic",system-ui,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}
.card{max-width:560px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px 12px;display:flex;flex-direction:column;gap:14px}
.head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.eyebrow{font-size:12px;font-weight:600;color:var(--ink2)}.app{color:var(--mute);font-weight:500}
.pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.pill:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.p-wait{background:var(--wait);color:var(--wait-ink)}.p-edit{background:var(--edit);color:var(--edit-ink)}.p-ok{background:var(--ok);color:var(--ok-ink)}
.p-done{background:var(--done);color:var(--done-ink)}.p-warn{background:var(--warn);color:var(--warn-ink)}.p-off{background:var(--wait);color:var(--mute)}.p-err{background:var(--err);color:var(--err-ink)}
h2{margin:0;font-size:22px;line-height:1.3;font-weight:700;letter-spacing:-.01em;word-break:keep-all;overflow-wrap:anywhere}
.off h2{color:var(--mute);text-decoration:line-through;text-decoration-thickness:1px}
.meta{margin:4px 0 0;font-size:13px;color:var(--mute)}
dl{margin:0;display:grid;grid-template-columns:76px minmax(0,1fr);row-gap:6px;font-size:14px}dt{color:var(--mute)}dd{margin:0;font-weight:600;overflow-wrap:anywhere}
.sub{font-weight:400;color:var(--mute)}
.note{margin:0;padding:10px 12px;background:var(--soft);border-radius:10px;color:var(--ink2);white-space:pre-wrap;overflow-wrap:anywhere}
.callout{margin:0;padding:10px 12px;border-radius:10px;font-size:13px}.c-info{background:var(--info);color:var(--info-ink)}.c-err{background:var(--err);color:var(--err-ink)}
.foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid var(--rule);padding-top:10px}
.fl{margin:0;flex:1 1 200px;font-size:13px;color:var(--mute)}.grow{flex:1}
.line{margin:0;font-size:13px;color:var(--mute)}.line .link{min-height:0;padding:0;font-size:13px}
button{font:inherit}
.btn{min-height:44px;padding:0 18px;border-radius:10px;font-size:14px;font-weight:600;border:1px solid var(--field);background:var(--card);color:var(--ink);cursor:pointer}
.pri{background:var(--pri);border-color:var(--pri);color:var(--pri-ink)}.danger{background:#b3261e;border-color:#b3261e;color:#fff}
.btn:disabled{opacity:.6;cursor:progress}
.link{min-height:44px;padding:0 4px;border:0;background:none;font-size:14px;color:var(--mute);text-decoration:underline;text-underline-offset:3px;cursor:pointer}
.fl .link{min-height:0;padding:0;font-size:13px}
:focus-visible{outline:2px solid var(--pri);outline-offset:2px}
.field{display:flex;flex-direction:column;gap:6px}.lbl{font-size:12px;font-weight:600;color:var(--ink2)}.opt{font-weight:500;color:var(--mute)}
#ef{display:flex;flex-direction:column;gap:14px}
.two,.three{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.three{grid-template-columns:2fr 1fr 1fr}
input,textarea{min-height:44px;width:100%;border:1px solid var(--field);border-radius:10px;padding:0 12px;font:inherit;font-size:15px;color:var(--ink);background:var(--card)}
textarea{min-height:76px;padding:10px 12px;resize:vertical}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{min-height:40px;padding:0 14px;border-radius:999px;border:1px solid var(--field);background:var(--card);color:var(--ink2);cursor:pointer}
.chip[aria-pressed=true]{border-color:var(--chip-on);background:var(--chip-on);color:var(--chip-on-ink);font-weight:600}
.pick{display:flex;flex-direction:column;gap:8px}.pick .sel{margin:0;font-size:13px;color:var(--mute)}.pick .sel b{color:var(--ink)}
.plist{display:flex;flex-wrap:wrap;gap:6px;max-height:176px;overflow:auto}
.confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 12px;background:var(--err);border-radius:10px}
.confirm p{margin:0;flex:1 1 180px;font-weight:600;color:var(--err-ink)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
@media (max-width:360px){.two{grid-template-columns:1fr}}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

/*
 * Runs inside the card iframe. `B` is the destination body: { view(c, h), edit(c, h), read(values, c) → payload | error text }
 * and optionally bind(form, c, h) (wire dynamic parts of the edit form, e.g. a picker) and preApprove(c, h) → null |
 * { message, later } (something the app would still ask: offer 「수정」 or approve with a last check in the app).
 */
const RUNTIME = String.raw`
(function(){
'use strict';
var B=window.LH_BODY, root=document.getElementById('root');
var S={card:null,ticket:null,mode:'view',busy:false,error:null,live:''};
var seq=0, waiting={};
function post(m){window.parent.postMessage(m,'*');}
function request(method,params){return new Promise(function(ok,no){var id=++seq;waiting[id]={ok:ok,no:no};post({jsonrpc:'2.0',id:id,method:method,params:params});});}
function notify(method,params){post({jsonrpc:'2.0',method:method,params:params});}
var esc=function(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});};
var H={esc:esc,
  date:function(d){if(!/^\d{4}-\d{2}-\d{2}$/.test(d||''))return '';var p=d.split('-'),t=new Date(),today=t.getFullYear()+'-'+('0'+(t.getMonth()+1)).slice(-2)+'-'+('0'+t.getDate()).slice(-2);
    return (Number(p[0])!==t.getFullYear()?p[0]+'년 ':'')+Number(p[1])+'월 '+Number(p[2])+'일'+(d===today?' (오늘)':'');},
  facts:function(rows){rows=rows.filter(function(r){return r[1];});return rows.length?'<dl>'+rows.map(function(r){return '<dt>'+esc(r[0])+'</dt><dd>'+esc(r[1])+'</dd>';}).join('')+'</dl>':'';},
  note:function(t){return t?'<p class="note">'+esc(t)+'</p>':'';},
  input:function(name,label,value,o){o=o||{};var id='f-'+name;return '<div class="field"><label class="lbl" for="'+id+'">'+esc(label)+(o.optional?' <span class="opt">선택</span>':'')+'</label>'+
    (o.area?'<textarea id="'+id+'" name="'+name+'" maxlength="'+(o.max||1000)+'">'+esc(value)+'</textarea>':
    '<input id="'+id+'" name="'+name+'" type="'+(o.type||'text')+'" value="'+esc(value)+'" maxlength="'+(o.max||200)+'"'+(o.optional?'':' required')+'>')+'</div>';},
  chips:function(name,label,options,value,o){o=o||{};var on=function(v){return o.multi?(value||[]).indexOf(v)>=0:v===value;};
    return '<div class="field"><span class="lbl" id="l-'+name+'">'+esc(label)+(o.required?'':' <span class="opt">선택</span>')+'</span><div class="chips" role="group" aria-labelledby="l-'+name+'" data-chips="'+name+'"'+(o.required?' data-required="1"':'')+(o.multi?' data-multi="'+o.multi+'"':'')+'>'+
    options.map(function(x){return '<button type="button" class="chip" data-value="'+esc(x[0])+'" aria-pressed="'+on(x[0])+'">'+esc(x[1])+'</button>';}).join('')+'</div></div>';}
};
var PILL={pending:['검토 대기','p-wait'],edited:['수정함','p-edit'],editing:['수정 중','p-edit'],busy:['처리 중…','p-edit'],approved:['승인됨','p-ok'],review:['확인 필요','p-warn'],
  confirmed:['저장됨','p-done'],rejected:['거절됨','p-off'],error:['다시 확인','p-err']};
function pill(){var c=S.card;if(S.error)return PILL.error;if(S.busy)return PILL.busy;if(S.mode==='edit')return PILL.editing;
  if(c.status==='pending')return c.revision>0?PILL.edited:PILL.pending;if(c.status==='approved')return c.needs_app_review?PILL.review:PILL.approved;return PILL[c.status]||PILL.pending;}
function appLink(text){return S.card.app_url?'<button type="button" class="link" data-act="open">'+esc(text||S.card.app+' 열기')+'</button>':'';}
function footer(){var c=S.card,a=esc(c.app);
  if(S.mode==='edit')return '<div class="foot"><button type="button" class="link" data-act="cancel">취소</button><span class="grow"></span><button type="button" class="btn pri" data-act="save"'+(S.busy?' disabled':'')+'>변경 반영</button></div>';
  if(S.mode==='pre')return '<div class="foot"><button type="button" class="link" data-act="cancel">취소</button><button type="button" class="link" data-act="later">'+esc(S.pre.later)+'</button><span class="grow"></span><button type="button" class="btn pri" data-act="edit">수정</button></div>';
  if(S.mode==='confirm')return '<div class="confirm" role="alertdialog" aria-label="거절 확인"><p>거절할까요? '+a+'에 저장되지 않아요.</p><button type="button" class="link" data-act="cancel">취소</button><button type="button" class="btn danger" data-act="reject">거절하기</button></div>';
  if(c.status==='approved')return '<div class="foot"><p class="fl">'+(c.needs_app_review?'승인했어요. '+a+'를 열면 한 번 더 확인해요. ':'다음에 '+a+'를 열면 자동으로 저장돼요. ')+appLink()+'</p></div>';
  if(c.status==='confirmed')return '<div class="foot"><p class="fl">'+a+'에 저장했어요.</p></div>';
  if(c.status==='rejected')return '<div class="foot"><p class="fl">'+a+'에 저장되지 않아요.</p></div>';
  if(S.error==='expired'||!S.ticket||c.approve==='scope')return '<div class="foot"><p class="fl">지금은 '+appLink(a+'에서 검토')+'할 수 있어요.</p></div>';
  if(S.error==='conflict')return '<div class="foot"><span class="grow"></span><button type="button" class="btn" data-act="refresh">새로 고침</button></div>';
  var dis=S.busy?' disabled':'';
  var right=c.approve==='ok'?'<button type="button" class="btn" data-act="edit"'+dis+'>수정</button><button type="button" class="btn pri" data-act="approve"'+dis+'>'+(S.busy?'승인 중…':'승인')+'</button>':
    '<button type="button" class="btn" data-act="edit"'+dis+'>수정</button>';
  return (c.approve==='ok'?'':'<p class="line">승인은 앱에서 해요. '+appLink()+'</p>')+'<div class="foot"><button type="button" class="link" data-act="ask"'+dis+'>거절</button><span class="grow"></span>'+right+'</div>';}
function callout(){var c=S.card;
  if(S.error==='expired')return '<p class="callout c-err" role="alert">이 카드는 만료됐어요.</p>';
  if(S.error==='conflict')return '<p class="callout c-err" role="alert">다른 곳에서 먼저 바뀌었어요. 최신 내용을 불러와 다시 확인해 주세요.</p>';
  if(S.error)return '<p class="callout c-err" role="alert">'+esc(S.error)+'</p>';
  if(S.mode==='pre')return '<p class="callout c-info" role="status">'+esc(S.pre.message)+'</p>';
  if(c.status==='pending'&&c.approve==='scope')return '<p class="callout c-info">여기서 승인하려면 Claude 설정에서 Life Hub를 다시 연결하고 「카드에서 승인도 허용」을 켜 주세요.</p>';
  return '';}
function render(){
  if(!S.card){root.innerHTML='<div class="card" aria-busy="true"><p class="meta">카드를 불러오는 중…</p></div>';return;}
  var c=S.card,p=pill();
  root.innerHTML='<section class="card'+(c.status==='rejected'?' off':'')+'" aria-label="'+esc(c.label)+' 후보"><div class="head"><span class="eyebrow">'+esc(c.label)+' <span class="app">· '+esc(c.app)+'</span></span><span class="pill '+p[1]+'">'+p[0]+'</span></div>'+
    (S.mode==='edit'?'<form id="ef" novalidate>'+B.edit(c,H)+'</form>':B.view(c,H))+callout()+footer()+'</section><p class="sr" role="status" aria-live="polite">'+esc(S.live)+'</p>';
  if(S.mode==='edit'&&B.bind)B.bind(root.querySelector('#ef'),c,H);
}
function take(result){
  if(!result)return;
  var sc=result.structuredContent||{}, m=(result._meta||{})['life-hub/card'];
  if(m&&typeof m.ticket==='string')S.ticket=m.ticket;
  if(result.isError){S.error=sc.error==='expired'||sc.error==='conflict'?sc.error:((result.content&&result.content[0]&&result.content[0].text)||'처리하지 못했어요.');return;}
  if(sc.card){S.card=sc.card;S.error=null;}
}
function act(name,args,live){
  if(S.busy)return;S.busy=true;S.error=null;render();
  args.candidate_id=S.card.candidate_id;args.ticket=S.ticket;
  request('tools/call',{name:name,arguments:args}).then(function(r){S.busy=false;S.mode='view';take(r);S.live=S.error?'':live;render();},
    function(e){S.busy=false;S.error=(e&&e.message)||'연결을 확인해 주세요.';render();});
}
root.addEventListener('click',function(e){
  var chip=e.target.closest('.chip');
  if(chip){var g=chip.parentNode,on=chip.getAttribute('aria-pressed')==='true';
    if(g.dataset.multi){if(!on&&g.querySelectorAll('[aria-pressed=true]').length>=Number(g.dataset.multi))return;chip.setAttribute('aria-pressed',String(!on));return;}
    if(on&&g.dataset.required)return;
    g.querySelectorAll('.chip').forEach(function(x){x.setAttribute('aria-pressed','false');});if(!on)chip.setAttribute('aria-pressed','true');return;}
  var b=e.target.closest('[data-act]');if(!b)return;var a=b.dataset.act;
  if(a==='edit'){S.mode='edit';render();var f=root.querySelector('input,textarea');if(f)f.focus();}
  else if(a==='cancel'){S.mode='view';S.error=null;render();}
  else if(a==='ask'){S.mode='confirm';render();}
  else if(a==='reject')act('card_reject',{},'거절했어요.');
  else if(a==='approve'){var pre=B.preApprove&&B.preApprove(S.card,H);if(pre){S.mode='pre';S.pre=pre;render();return;}act('card_approve',{revision:S.card.revision},'승인했어요.');}
  else if(a==='later')act('card_approve',{revision:S.card.revision,app_review:true},'승인했어요. 앱에서 한 번 더 확인해요.');
  else if(a==='refresh')act('card_refresh',{},'최신 내용을 불러왔어요.');
  else if(a==='open'&&S.card.app_url)request('ui/open-link',{url:S.card.app_url}).catch(function(){});
  else if(a==='save'){var f=root.querySelector('#ef'),v={};
    f.querySelectorAll('input[name],textarea[name]').forEach(function(x){v[x.name]=x.value.trim();});
    f.querySelectorAll('[data-chips]').forEach(function(g){var on=g.querySelectorAll('[aria-pressed=true]');
      v[g.dataset.chips]=g.dataset.multi?[].map.call(on,function(x){return x.dataset.value;}):(on[0]?on[0].dataset.value:'');});
    var payload=B.read(v,S.card);if(typeof payload==='string'){S.error=payload;render();return;}
    S.mode='view';act('card_edit',{revision:S.card.revision,payload:payload},'수정했어요.');}
});
var ready=false, queued=null;
function answer(id,result,error){post(error?{jsonrpc:'2.0',id:id,error:error}:{jsonrpc:'2.0',id:id,result:result});}
function onToolResult(params){take(params);render();
  // A card re-drawn from conversation history shows the proposal-time state; load the current one quietly.
  if(S.ticket&&S.card&&!S.synced){S.synced=true;request('tools/call',{name:'card_refresh',arguments:{candidate_id:S.card.candidate_id,ticket:S.ticket}}).then(function(r){
    if(r&&!r.isError){take(r);render();}else if(r&&r.structuredContent&&r.structuredContent.error==='expired'){S.error='expired';render();}},function(){});}}
window.addEventListener('message',function(e){
  if(e.source!==window.parent)return;var m=e.data;if(!m||m.jsonrpc!=='2.0')return;
  // A response to one of our requests.
  if(m.method===undefined){if(m.id!=null&&waiting[m.id]){var w=waiting[m.id];delete waiting[m.id];m.error?w.no(m.error):w.ok(m.result);}return;}
  // A request from the host: always answer (hosts check liveness with ping).
  if(m.id!=null){
    if(m.method==='ping'||m.method==='ui/resource-teardown')answer(m.id,{});
    else answer(m.id,null,{code:-32601,message:'Method not found: '+m.method});
    return;}
  // Notifications.
  if(m.method==='ui/notifications/tool-result'){if(ready)onToolResult(m.params);else queued=m.params;}
  else if(m.method==='ui/notifications/host-context-changed'&&m.params)theme(m.params.theme);
});
function theme(t){if(t==='dark'||t==='light')document.documentElement.dataset.theme=t;}
if(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)theme('dark');
function size(){var r=document.documentElement.getBoundingClientRect();notify('ui/notifications/size-changed',{width:Math.ceil(r.width),height:Math.ceil(r.height)});}
render();
// Handshake exactly like the MCP Apps SDK: ui/initialize → ui/notifications/initialized, and only then
// size updates and tool calls. Retry if the first request got lost while the host's sandbox was starting.
var attempts=0;
function connect(){
  attempts++;var done=false;
  request('ui/initialize',{appInfo:{name:'life-hub-card',version:'1.1.0'},appCapabilities:{availableDisplayModes:['inline']},protocolVersion:'2026-01-26'}).then(function(r){
    if(ready)return;ready=done=true;
    theme(r&&r.hostContext&&r.hostContext.theme);
    post({jsonrpc:'2.0',method:'ui/notifications/initialized'});
    size();if(window.ResizeObserver)new ResizeObserver(size).observe(document.body);
    if(queued){var q=queued;queued=null;onToolResult(q);}
  },function(){});
  setTimeout(function(){if(!done&&!ready&&attempts<3)connect();},2000);
}
connect();
})();
`;

/** Leading indentation and comment-only lines are dropped (the scripts have no multi-line string literals). */
const compact = (code) => code.replace(/\n\s*\/\/[^\n]*/g, '').replace(/\n\s+/g, '\n');

/** A complete card document: shared shell + one destination body script. */
export function cardDocument(title, bodyScript) {
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    `<title>${title}</title><style>${CSS}</style></head><body><div id="root"></div>` +
    `<script>${compact(bodyScript)}</script><script>${compact(RUNTIME)}</script></body></html>`;
}

/** Resource `_meta.ui`: no external domains at all; the host draws no extra border (the card has its own). */
export const CARD_RESOURCE_META = Object.freeze({ ui: Object.freeze({ csp: Object.freeze({ connectDomains: [], resourceDomains: [] }), prefersBorder: false }) });
export const CARD_MIME = 'text/html;profile=mcp-app';
