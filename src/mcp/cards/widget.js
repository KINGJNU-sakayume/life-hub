/** Portable, zero-network, inline MCP Apps card shell for five currently supported proposal types. */
export const CARD_PREVIEW_URI = 'ui://life-hub/proposal-preview.html';
export const CARD_PREVIEW_HTML = String.raw`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Life Hub · 기록 확인</title>
<style>
:root{color-scheme:light dark;--paper:#fff;--wash:#f7f8f7;--ink:#252a29;--muted:#66716d;--line:#e1e6e3;--accent:#315f54;--accent-text:#fff;--notice:#edf4f1;--danger:#b23c35;font:14px/1.55 system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif}
@media(prefers-color-scheme:dark){:root{--paper:#1e2321;--wash:#282e2b;--ink:#f0f2f0;--muted:#acb5b0;--line:#3c4640;--accent:#95c6b7;--accent-text:#14221c;--notice:#293c32;--danger:#ffa59b}}
*{box-sizing:border-box}html,body{margin:0;padding:0}body{background:transparent;color:var(--ink);padding:7px 3px 10px}
button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}
article{background:var(--paper);border:1px solid var(--line);border-radius:14px;overflow:hidden;max-width:560px;margin:auto}
header{padding:17px 18px 12px;border-bottom:1px solid var(--line)}.eyebrow{display:flex;gap:6px;align-items:center;color:var(--muted);letter-spacing:.07em;text-transform:uppercase;font-size:10px;font-weight:700}.dot{width:6px;height:6px;border-radius:50%;background:var(--accent);display:inline-block}
h1{font-size:19px;font-weight:700;line-height:1.35;letter-spacing:-.025em;margin:9px 0 4px;overflow-wrap:anywhere}h2{font-size:13px;font-weight:650;margin:0 0 9px}.subtitle{font-size:12px;color:var(--muted);margin:0;line-height:1.6}
.hero{margin:16px 18px 0;padding:13px 14px;background:var(--wash);border-radius:10px;display:flex;align-items:center;justify-content:space-between;gap:14px}.hero-title{font-size:15px;font-weight:650;overflow-wrap:anywhere;line-height:1.4}.hero-label{font-size:11px;color:var(--muted);margin-bottom:2px}.hero-number{font-size:21px;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap;letter-spacing:-.045em}
form{padding:14px 18px 0}section{padding-bottom:12px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:11px}.field{margin-bottom:11px;min-width:0}
label{display:block;font-size:12px;font-weight:600;margin-bottom:5px}input,select,textarea{display:block;width:100%;color:var(--ink);background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:9px 10px;min-height:40px;outline-offset:2px}
input:focus-visible,select:focus-visible,textarea:focus-visible,button:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
textarea{resize:vertical;min-height:62px}input[type=checkbox]{width:18px;height:18px;min-height:0;accent-color:var(--accent);margin:0}
.note{color:var(--muted);font-size:11px;margin-top:4px}.with-check{display:flex;align-items:center;gap:9px;min-height:41px}.with-check label{margin:0;font-weight:500}
fieldset{padding:0;border:0;margin:0}.chips{display:flex;gap:6px;flex-wrap:wrap}.chip{border:1px solid var(--line);border-radius:7px;background:var(--paper);color:var(--muted);padding:7px 9px;min-height:37px}.chip[aria-pressed=true]{background:var(--notice);color:var(--ink);border-color:var(--accent)}
details{border-top:1px solid var(--line);padding:12px 0 2px}summary{cursor:pointer;font-size:12px;font-weight:650;min-height:27px}details>div{padding-top:12px}
footer{padding:13px 18px 16px;border-top:1px solid var(--line)}.status{font-size:12px;color:var(--muted);display:flex;gap:7px;align-items:flex-start;line-height:1.5;overflow-wrap:anywhere}.status strong{color:var(--ink)}.notice{background:var(--notice);border-radius:8px;padding:10px 11px}.actions{display:flex;align-items:center;justify-content:flex-end;gap:9px;margin-top:13px}.secondary,.primary{border-radius:8px;padding:10px 13px;min-height:42px;font-weight:650}.secondary{background:transparent;border:1px solid var(--line);color:var(--muted)}.primary{background:var(--accent);border:1px solid var(--accent);color:var(--accent-text);min-width:135px}.error{color:var(--danger);font-size:12px;margin-top:10px;overflow-wrap:anywhere}.hidden,[hidden]{display:none!important}
@media(max-width:400px){body{padding:2px 0}article{border-radius:11px}header,form,footer{padding-left:13px;padding-right:13px}.hero{margin-left:13px;margin-right:13px}.grid{grid-template-columns:1fr}.hero-number{font-size:19px}}
@media(prefers-reduced-motion:no-preference){button{transition:background .12s ease,border-color .12s ease}}
</style>
</head>
<body>
<article aria-label="Life Hub 기록 후보 미리보기">
<header><div class="eyebrow"><span class="dot"></span><span>LIFE HUB</span><span aria-hidden="true">/</span><span id="destination">기록</span></div>
<h1 id="heading">기록 확인</h1><p class="subtitle" id="description">데이터를 받아오고 있습니다.</p></header>
<div class="hero" id="hero" hidden><div><div class="hero-label" id="heroLabel"></div><div class="hero-title" id="heroTitle"></div></div><div class="hero-number" id="heroNumber"></div></div>
<form id="entry" hidden novalidate>
<section><h2>기록 내용</h2><div id="core"></div></section>
<details id="more"><summary>추가 정보 · 메모</summary><div id="extra"></div></details>
</form>
<footer>
<div class="status" id="state" role="status" aria-live="polite">MCP Apps 연결을 확인하는 중입니다.</div>
<div class="error" id="error" role="alert" hidden></div>
<div class="actions"><button type="button" class="secondary" id="cancel" disabled>취소</button><button class="primary" id="submit" type="submit" form="entry" disabled>후보로 보내기</button></div>
</footer>
</article>
<script>
(function(){
'use strict';
const $=id=>document.getElementById(id);
const typeMap={
reading:{name:'독서',destination:'책장',heading:'독서 진행 기록',description:'책·진도·상태를 확인해 주세요.',tool:'propose_reading_record'},
meal:{name:'식사',destination:'PALATE',heading:'식사 기록',description:'먹은 음식과 평가를 확인해 주세요.',tool:'propose_food_meal'},
wish:{name:'먹어보기',destination:'PALATE',heading:'가보고 싶은 곳 · 먹고 싶은 메뉴',description:'나중에 시도하고 싶은 항목을 확인해 주세요.',tool:'propose_food_wish'},
memory:{name:'추억',destination:'켜켜이',heading:'추억 기록',description:'사진 없이도 문장만으로 기록할 수 있어요.',tool:'propose_memory'},
visit:{name:'지역 방문',destination:'켜켜이',heading:'지역 방문 기록',description:'방문 사실과 장소를 확인해 주세요.',tool:'propose_region_visit'}
};
const allowed={
reading:['title','author','publisher','volume','state','current_page','rating','liked','date','note'],
meal:['menu_name','place_name','eaten_on','verdict','reorder_intent','note'],
wish:['wish_kind','name','source_url','note'],
memory:['title','memo','time_text','year','month','day','place_text','region_hint','emotions','song_artist','song_title'],
visit:['place_text','region_hint','visited_on','note']
};
const emotions=['행복','설렘','신남','웃김','평온','감동','슬픔','우울','두려움','화남'];
const rpcPending=new Map();let rpcId=0,ready=false,done=false,busy=false,selected=null,initial={};const controls=new Map();
function rpc(method,params){return new Promise((resolve,reject)=>{const id=++rpcId;rpcPending.set(id,{resolve,reject});window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*')})}
function notify(method,params){window.parent.postMessage({jsonrpc:'2.0',method,params},'*')}
function text(id,value){$(id).textContent=String(value??'')}
function status(message,good){$('state').className='status'+(good?' notice':'');$('state').textContent=message}
function failure(message){$('error').hidden=false;text('error',message)}
function clearFailure(){$('error').hidden=true;text('error','')}
function make(tag,className){const el=document.createElement(tag);if(className)el.className=className;return el}
function field(holder,key,label,config){
  const opt=config||{};const box=make('div','field');const lab=make('label');lab.htmlFor='f_'+key;lab.textContent=label;box.append(lab);
  let input;
  if(opt.options){input=make('select');const entries=[['','선택하지 않음'],...opt.options];for(const [value,title] of entries){const o=make('option');o.value=value;o.textContent=title;input.append(o)}}
  else if(opt.multiline){input=make('textarea');input.rows=opt.rows||2}
  else{input=make('input');input.type=opt.type||'text';if(opt.min!==undefined)input.min=String(opt.min);if(opt.max!==undefined&&input.type==='number')input.max=String(opt.max);if(opt.type==='number')input.step='1'}
  input.id='f_'+key;input.name=key;if(opt.maxlen)input.maxLength=opt.maxlen;if(opt.required)input.required=true;
  if(initial[key]!==undefined && initial[key]!==null)input.value=String(initial[key]);
  if(opt.placeholder)input.placeholder=opt.placeholder;
  input.addEventListener('input',updateHero);
  controls.set(key,input);box.append(input);
  if(opt.help){const note=make('div','note');note.textContent=opt.help;box.append(note)}
  holder.append(box);return box
}
function grid(holder,callback){const g=make('div','grid');holder.append(g);callback(g)}
function checkbox(holder,key,label){
 const wrapper=make('div','field with-check');const el=make('input');el.type='checkbox';el.id='f_'+key;el.checked=initial[key]===true;controls.set(key,el);
 const caption=make('label');caption.htmlFor=el.id;caption.textContent=label;wrapper.append(el,caption);holder.append(wrapper);
}
function emotionChips(holder){
 const wrap=make('div','field');const label=make('label');label.textContent='감정 (선택)';wrap.append(label);
 const chips=make('div','chips');const selectedSet=new Set(Array.isArray(initial.emotions)?initial.emotions:[]);
 for(const name of emotions){const el=make('button','chip');el.type='button';el.textContent=name;el.setAttribute('aria-pressed',String(selectedSet.has(name)));
  el.addEventListener('click',()=>{const active=el.getAttribute('aria-pressed')==='true';if(!active&&selectedSet.size>=5){failure('감정은 최대 5개까지 선택할 수 있어요.');return}clearFailure();active?selectedSet.delete(name):selectedSet.add(name);el.setAttribute('aria-pressed',String(!active))});chips.append(el)}
 wrap.append(chips);holder.append(wrap);controls.set('emotions',()=>Array.from(selectedSet))
}
function optional(title,build){const g=make('div');$('extra').append(g);build(g)}
function buildReading(c,e){
 field(c,'title','책 제목',{required:true,maxlen:200,placeholder:'어떤 책을 읽으셨나요?'});
 grid(c,g=>{field(g,'state','상태',{options:[['reading','읽는 중'],['completed','완독']]});field(g,'current_page','현재 페이지',{type:'number',min:1,max:20000,placeholder:'예: 115'})});
 const state=controls.get('state');state.value=initial.state==='completed'?'completed':'reading';
 const rating=field(e,'rating','평점 · 완독 시',{options:[['1','★'],['2','★★'],['3','★★★'],['4','★★★★'],['5','★★★★★']]});
 const liked=make('div');e.append(liked);checkbox(liked,'liked','인생책으로 표시');
 const page=controls.get('current_page').closest('.field');
 function mode(){const completed=state.value==='completed';page.hidden=completed;rating.hidden=!completed;liked.hidden=!completed}
 state.addEventListener('change',()=>{mode();updateHero()});mode();
 grid(e,g=>{field(g,'author','저자',{maxlen:100});field(g,'publisher','출판사 · 판본',{maxlen:100})});
 grid(e,g=>{field(g,'volume','권수',{type:'number',min:1,max:200});field(g,'date','기록 날짜',{type:'date'})});
 field(e,'note','메모',{maxlen:500,multiline:true});
}
function buildMeal(c,e){
 field(c,'menu_name','먹은 메뉴',{required:true,maxlen:200});
 field(c,'place_name','가게 (선택)',{maxlen:200,placeholder:'모르면 비워도 됩니다'});
 grid(c,g=>{field(g,'verdict','맛 평가',{options:[['LIKE','좋았어요'],['NEUTRAL','보통이에요'],['DISLIKE','아쉬웠어요']]});field(g,'eaten_on','먹은 날짜',{type:'date'})});
 grid(e,g=>field(g,'reorder_intent','다시 먹을래요?',{options:[['YES','또 먹고 싶어요'],['MAYBE','고민 중'],['NO','다시 먹지는 않을래요']]}));
 field(e,'note','짧은 감상',{maxlen:1000,multiline:true});
}
function buildWish(c,e){
 field(c,'name','이름',{required:true,maxlen:200,placeholder:'가게 이름 또는 메뉴'});
 field(c,'wish_kind','무엇을 시도하나요?',{options:[['visit_place','가게 방문'],['try_menu','메뉴 먹어보기']]});
 const kind=controls.get('wish_kind');kind.value=initial.wish_kind==='visit_place'?'visit_place':'try_menu';
 kind.addEventListener('change',updateHero);
 field(e,'source_url','관련 링크',{type:'url',maxlen:2048,placeholder:'https://'});
 field(e,'note','기억할 점',{maxlen:1000,multiline:true});
}
function buildMemory(c,e){
 field(c,'title','추억 제목',{required:true,maxlen:80});
 field(c,'memo','기억하고 싶은 내용',{multiline:true,maxlen:2000,rows:3,placeholder:'그날의 기억을 짧게 남겨 보세요'});
 grid(c,g=>{field(g,'time_text','언제였나요?',{maxlen:100,placeholder:'예: 고2 여름'});field(g,'place_text','어디였나요?',{maxlen:100})});
 emotionChips(e);
 grid(e,g=>{field(g,'year','연도',{type:'number',min:1900,max:2100});field(g,'month','월',{type:'number',min:1,max:12})});
 field(e,'day','일',{type:'number',min:1,max:31});
 field(e,'region_hint','지역 추정',{maxlen:60,help:'정확한 시군구는 켜켜이에서 최종 확인해요.'});
 grid(e,g=>{field(g,'song_artist','아티스트',{maxlen:100});field(g,'song_title','관련 곡',{maxlen:100})});
}
function buildVisit(c,e){
 field(c,'place_text','방문한 장소',{required:true,maxlen:100,placeholder:'어디에 다녀오셨나요?'});
 grid(c,g=>{field(g,'visited_on','방문 날짜',{type:'date'});field(g,'region_hint','시군구 추정',{maxlen:60})});
 field(e,'note','그날의 기록',{multiline:true,maxlen:500});
 const notice=make('div','note');notice.textContent='여기에 표시된 시군구는 추정이며, 실제 지역 코드 선택은 켜켜이에서 완료합니다.';e.append(notice)
}
function readValue(key){
 const el=controls.get(key);if(!el)return undefined;
 if(typeof el==='function'){const v=el();return v.length?v:undefined}
 if(el.type==='checkbox')return el.checked?true:undefined;
 const raw=el.value.trim();if(!raw)return undefined;
 if(el.type==='number'){const n=Number(raw);return Number.isInteger(n)?n:NaN}
 return raw;
}
function getPayload(){
 const result={};for(const key of allowed[selected]){
  if(selected==='reading'&&initial.state!==undefined&&key==='state'){} // state is still user-editable
  if(selected==='reading'&&controls.get('state').value==='reading'&&(key==='rating'||key==='liked'))continue;
  if(selected==='reading'&&controls.get('state').value==='completed'&&key==='current_page')continue;
  const v=readValue(key);if(v!==undefined)result[key]=v;
 }
 return result
}
function updateHero(){
 if(!selected)return;const draft=getPayload();
 let first='',metric='',caption='';
 if(selected==='reading'){first=draft.title;caption='현재 독서 상태';metric=draft.state==='completed'?'완독':(draft.current_page?draft.current_page+'p':'읽는 중')}
 if(selected==='meal'){first=draft.menu_name;caption='식사 기록';metric=draft.verdict==='LIKE'?'좋았어요':draft.verdict==='DISLIKE'?'아쉬워요':draft.verdict==='NEUTRAL'?'보통':' '}
 if(selected==='wish'){first=draft.name;caption='먹어보기 목록';metric=draft.wish_kind==='visit_place'?'가게':'메뉴'}
 if(selected==='memory'){first=draft.title;caption='추억 한 장';metric='기억'}
 if(selected==='visit'){first=draft.place_text;caption='방문한 장소';metric='방문'}
 text('heroTitle',first||'제목을 입력하세요');text('heroNumber',metric);text('heroLabel',caption)
}
function extractDraft(params){
 if(!params||typeof params!=='object')return null;
 const output=params.structuredContent||params.result?.structuredContent||params.output?.structuredContent||params;
 if(output.draft && output.variant && typeMap[output.variant])return output;
 const hinted=params.arguments||params.toolInput||params;
 if(!hinted||typeof hinted!=='object')return null;
 const variant=hinted.variant;
 if(variant&&typeMap[variant]&&hinted.draft)return hinted;
 return null
}
function hydrate(payload){
 const obj=extractDraft(payload);if(!obj||selected||done)return;
 selected=obj.variant;const def=typeMap[selected];initial={};
 for(const key of allowed[selected])if(Object.hasOwn(obj.draft,key))initial[key]=obj.draft[key];
 text('destination',def.destination);text('heading',def.heading);text('description',def.description);
 $('hero').hidden=false;$('entry').hidden=false;
 const c=$('core'),e=$('extra');
 if(selected==='reading')buildReading(c,e);
 if(selected==='meal')buildMeal(c,e);
 if(selected==='wish')buildWish(c,e);
 if(selected==='memory')buildMemory(c,e);
 if(selected==='visit')buildVisit(c,e);
 const moreHasValues=Object.keys(initial).some(k=>e.querySelector('[name="'+k+'"]')!==null && initial[k]!==undefined);
 $('more').open=moreHasValues;updateHero();
 status('아직 저장되지 않았습니다. 확인 후 후보를 보내면 앱에서 최종 승인할 수 있어요.');
 $('submit').disabled=!ready;$('cancel').disabled=false;
 resize()
}
function resize(){if(!ready)return;const height=Math.ceil(document.documentElement.scrollHeight);notify('ui/notifications/size-changed',{height})}
window.addEventListener('message',event=>{
 if(event.source!==window.parent || !event.data || event.data.jsonrpc!=='2.0')return;
 const m=event.data;
 if((typeof m.id==='string'||typeof m.id==='number')&&rpcPending.has(m.id)){
  const p=rpcPending.get(m.id);rpcPending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);return;
 }
 if(m.method==='ui/notifications/tool-result'||m.method==='ui/notifications/tool-input')hydrate(m.params);
 if(m.method==='ui/notifications/host-context-changed'&&m.params?.theme){document.documentElement.dataset.theme=m.params.theme}
});
$('cancel').addEventListener('click',()=>{if(busy||done)return;done=true;$('entry').hidden=true;$('submit').disabled=true;$('cancel').disabled=true;status('취소했습니다. 어떠한 기록도 저장되지 않았습니다.',true);resize()});
$('entry').addEventListener('submit',async ev=>{
 ev.preventDefault();if(!ready||!selected||busy||done)return;
 clearFailure();const data=getPayload();
 if(!$('entry').checkValidity()){$('entry').reportValidity();return}
 for(const [key,value] of Object.entries(data)){if(typeof value==='number'&&!Number.isFinite(value)){failure(key+' 값을 확인해 주세요.');return}}
 if(selected==='memory'&&data.month&&!data.year){failure('월을 입력하면 연도도 필요합니다.');return}
 if(selected==='memory'&&data.day&&!data.month){failure('일을 입력하면 연도와 월도 필요합니다.');return}
 const def=typeMap[selected];busy=true;$('submit').disabled=true;status('기록 후보를 전송하는 중입니다…');
 try{
 const reply=await rpc('tools/call',{name:def.tool,arguments:data});
 const output=reply?.structuredContent;
 if(reply?.isError || !output || !output.candidate_id || (!output.duplicate&&output.status!=='pending'))
  throw Error(reply?.content?.[0]?.text||'서버에서 접수 결과를 확인하지 못했습니다.');
 done=true;$('entry').hidden=true;$('submit').disabled=true;$('cancel').disabled=true;
 status((output.duplicate?'동일한 후보가 이미 있습니다.':'후보를 접수했습니다.')+' · 상태: '+(output.status||'pending')+' · 후보 ID: '+output.candidate_id+'. 실제 기록은 '+def.destination+'에서 승인해야 반영됩니다.',true)
 }catch(err){failure('제출하지 못했습니다. '+(err?.message||'연결 또는 권한을 확인해 주세요.'));status('제출 실패 · 내용은 그대로 유지됩니다.');$('submit').disabled=false}
 finally{busy=false;resize()}
});
async function start(){
 try{
 const init=await rpc('ui/initialize',{protocolVersion:'2026-01-26',appInfo:{name:'life-hub-card',version:'1.0.0'},appCapabilities:{availableDisplayModes:['inline']}});
 notify('ui/notifications/initialized',{});
 if(init?.hostContext?.theme)document.documentElement.dataset.theme=init.hostContext.theme;
 ready=true;
 const alias=window.openai;
 hydrate(alias?.toolOutput);hydrate(alias?.toolInput);
 if(selected){$('submit').disabled=false}
 else status('기록 데이터를 받아오고 있습니다.');
 if(typeof ResizeObserver!=='undefined')new ResizeObserver(resize).observe(document.body);
 resize()
 }catch(e){status('대화 내 카드 연결을 사용할 수 없습니다. 텍스트 후보로 확인한 뒤 앱에서 검토해 주세요.');failure('MCP Apps 초기화를 완료하지 못했습니다.')}
}
start()
})();
</script>
</body>
</html>`;
