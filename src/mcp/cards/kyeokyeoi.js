/**
 * 켜켜이 card body: memory (추억) and region visit (방문). Runs in the card iframe as window.LH_BODY.
 * The 시군구 picker uses the list 켜켜이 shared (card.refs.regions: {id, label, group}); the chosen label goes
 * into region_hint, and 켜켜이 saves only an exact label without asking. No region list: the card says so.
 */
import { cardDocument } from './shell.js';
import { KYEOKYEOI_EMOTIONS } from '../../adapters/kyeokyeoi.js';

const BODY = String.raw`
window.LH_BODY=(function(){
var EMO=${JSON.stringify(KYEOKYEOI_EMOTIONS)}.map(function(e){return [e,e];});
var ORDER=['서울','부산','대구','인천','광주','대전','울산','세종','경기','강원','충북','충남','전북','전남','경북','경남','제주'];
var regions=function(c){return (c.refs&&c.refs.regions)||[];};
var exact=function(c,label){var r=regions(c);for(var i=0;i<r.length;i++)if(r[i].label===label)return r[i];return null;};
var sq=function(s){return String(s||'').replace(/\s+/g,'');};
function when(p){if(p.year)return p.year+'년'+(p.month?' '+p.month+'월':'')+(p.day?' '+p.day+'일':'');return p.time_text||'';}
function place(c,p,h){var hint=p.region_hint;if(!hint)return p.place_text||'';
  var shown=exact(c,hint)?hint:hint+' (켜켜이에서 확인)';return p.place_text&&p.place_text!==hint?p.place_text+' · '+shown:shown;}
function picker(c,h,required){var p=c.payload,r=regions(c),cur=p.region_hint||'';
  if(!r.length)return '<div class="field"><span class="lbl">시군구</span><input type="hidden" name="region_hint" value="'+h.esc(cur)+'"><p class="meta">켜켜이를 한 번 열면 여기서 시군구를 고를 수 있어요.'+(cur?' 지금: '+h.esc(cur):'')+'</p></div>';
  var groups=[];r.forEach(function(x){if(x.group&&groups.indexOf(x.group)<0)groups.push(x.group);});
  groups.sort(function(a,b){var i=ORDER.indexOf(a),j=ORDER.indexOf(b);return (i<0?99:i)-(j<0?99:j);});
  var hit=exact(c,cur);
  return '<div class="field pick" data-pick><span class="lbl" id="l-rg">시군구'+(required?'':' <span class="opt">선택</span>')+'</span>'+
    '<input type="hidden" name="region_hint" value="'+h.esc(cur)+'">'+
    '<p class="sel" data-sel></p>'+
    '<input type="search" data-q aria-label="시군구 검색" placeholder="이름으로 찾기 (예: 일산서구)" value="'+h.esc(hit?'':(cur||''))+'" maxlength="40">'+
    '<div class="chips" role="group" aria-label="시·도">'+groups.map(function(g){return '<button type="button" class="chip" data-prov="'+h.esc(g)+'" aria-pressed="'+(hit&&hit.group===g)+'">'+h.esc(g)+'</button>';}).join('')+'</div>'+
    '<div class="plist" role="group" aria-labelledby="l-rg" data-list></div></div>';}
function bindPicker(form,c,h){var box=form.querySelector('[data-pick]');if(!box)return;
  var hidden=box.querySelector('input[name=region_hint]'),q=box.querySelector('[data-q]'),list=box.querySelector('[data-list]'),sel=box.querySelector('[data-sel]');
  var hit=exact(c,hidden.value),prov=hit?hit.group:'';
  function draw(){var v=hidden.value,ok=exact(c,v),term=sq(q.value),items=[];
    sel.innerHTML=v?(ok?'고른 곳: <b>'+h.esc(v)+'</b> · 다시 누르면 해제':'지금: '+h.esc(v)+' · 목록에서 골라 주세요'):'아직 고르지 않았어요';
    if(term)items=regions(c).filter(function(x){return sq(x.label).indexOf(term)>=0;}).slice(0,40);
    else if(prov)items=regions(c).filter(function(x){return x.group===prov;});
    list.innerHTML=items.map(function(x){return '<button type="button" class="chip" data-rg="'+h.esc(x.label)+'" aria-pressed="'+(x.label===v)+'">'+h.esc(x.label.indexOf(x.group+' ')===0?x.label.slice(x.group.length+1):x.label)+'</button>';}).join('')||
      (term?'<p class="meta">찾는 시군구가 없어요.</p>':'');
    box.querySelectorAll('[data-prov]').forEach(function(b){b.setAttribute('aria-pressed',String(!term&&b.dataset.prov===prov));});}
  box.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;e.stopPropagation();
    if(b.dataset.prov!==undefined){prov=prov===b.dataset.prov?'':b.dataset.prov;q.value='';}
    else if(b.dataset.rg!==undefined)hidden.value=hidden.value===b.dataset.rg?'':b.dataset.rg;
    draw();});
  q.addEventListener('input',draw);draw();}
var num=function(v){return /^\d{1,4}$/.test(v)?Number(v):undefined;};
return {
  view:function(c,h){var p=c.payload;
    if(c.type==='visit')return '<div><h2>'+h.esc(p.place_text)+'</h2></div>'+
      h.facts([['시군구',p.region_hint?place(c,{region_hint:p.region_hint},h):'아직 고르지 않았어요'],['다녀온 날',h.date(p.visited_on)]])+h.note(p.note);
    var song=[p.song_artist,p.song_title].filter(Boolean).join(' — ');
    return '<div><h2>'+h.esc(p.title)+'</h2>'+(when(p)?'<p class="meta">'+h.esc(when(p))+'</p>':'')+'</div>'+
      h.facts([['장소',place(c,p,h)],['노래',song?'♪ '+song:''],['감정',(p.emotions||[]).join(' · ')]])+h.note(p.memo);},
  edit:function(c,h){var p=c.payload;
    if(c.type==='visit')return picker(c,h,true)+h.input('visited_on','다녀온 날',p.visited_on,{optional:true,type:'date',max:10})+h.input('note','메모',p.note,{optional:true,area:true,max:500});
    return h.input('title','제목',p.title,{max:80})+
      '<div class="three">'+h.input('year','연도',p.year==null?'':String(p.year),{optional:true,type:'number',max:4})+h.input('month','월',p.month==null?'':String(p.month),{optional:true,type:'number',max:2})+
      h.input('day','일',p.day==null?'':String(p.day),{optional:true,type:'number',max:2})+'</div>'+
      h.chips('emotions','감정 (5개까지)',EMO,p.emotions||[],{multi:5})+
      '<div class="two">'+h.input('song_artist','가수',p.song_artist,{optional:true,max:100})+h.input('song_title','노래',p.song_title,{optional:true,max:100})+'</div>'+
      picker(c,h,false)+h.input('memo','메모',p.memo,{optional:true,area:true,max:2000});},
  bind:function(form,c,h){bindPicker(form,c,h);},
  preApprove:function(c){var p=c.payload,ok=exact(c,p.region_hint);
    if(c.type==='visit'&&!ok)return {message:'시군구를 고르면 켜켜이에 바로 저장돼요. 지금 승인하면 켜켜이를 열 때 시군구를 정해요.',later:'켜켜이에서 정할게요'};
    if(c.type==='memory'&&(p.region_hint?!ok:!!p.place_text))return {message:'장소의 시군구를 고르면 바로 저장돼요. 지금 승인하면 켜켜이를 열 때 한 번 더 확인해요.',later:'켜켜이에서 정할게요'};
    return null;},
  read:function(v,c){var p=c.payload,out={};
    if(c.type==='visit'){out.place_text=p.place_text;['region_hint','visited_on','note'].forEach(function(k){if(v[k])out[k]=v[k];});return out;}
    if(!v.title)return '제목을 적어 주세요.';
    out.title=v.title;
    ['memo','song_artist','song_title','region_hint'].forEach(function(k){if(v[k])out[k]=v[k];});
    ['time_text','place_text'].forEach(function(k){if(p[k])out[k]=p[k];});
    var y=num(v.year),m=num(v.month),d=num(v.day);
    if((v.year&&y===undefined)||(v.month&&m===undefined)||(v.day&&d===undefined))return '날짜는 숫자로 적어 주세요.';
    if(m!==undefined&&y===undefined)return '월을 적으려면 연도도 적어 주세요.';
    if(d!==undefined&&m===undefined)return '일을 적으려면 월도 적어 주세요.';
    if(y!==undefined){if(y<1900||y>2100)return '연도를 확인해 주세요.';out.year=y;}
    if(m!==undefined){if(m<1||m>12)return '월을 확인해 주세요.';out.month=m;}
    if(d!==undefined){var t=new Date(Date.UTC(y,m-1,d));if(t.getUTCDate()!==d)return '날짜를 확인해 주세요.';out.day=d;}
    if(v.emotions&&v.emotions.length)out.emotions=v.emotions;
    return out;}
};})();
`;

export const KYEOKYEOI_CARD_URI = 'ui://life-hub/card-kyeokyeoi.html';
export const KYEOKYEOI_CARD_HTML = cardDocument('Life Hub · 켜켜이', BODY);
