/**
 * 켜켜이 card body: memory (추억) and region visit (방문). Runs in the card iframe as window.LH_BODY.
 * The 시군구 picker uses the list 켜켜이 shared (card.refs.regions: {id, label, group}); the chosen label goes
 * into region_hint, and 켜켜이 saves only an exact label without asking. No region list: the card says so.
 */
import { cardDocument } from './shell.js';
import { KYEOKYEOI_EMOTIONS } from '../../adapters/kyeokyeoi.js';
import { PICKER_SCRIPT } from './picker.js';

const BODY = String.raw`
window.LH_BODY=(function(){
var EMO=${JSON.stringify(KYEOKYEOI_EMOTIONS)}.map(function(e){return [e,e];});
var ORDER=['서울','부산','대구','인천','광주','대전','울산','세종','경기','강원','충북','충남','전북','전남','경북','경남','제주'];
var regions=function(c){return (c.refs&&c.refs.regions)||[];};
var exact=function(c,label){return LH_PICK.find(regions(c),label);};
function when(p){if(p.year)return p.year+'년'+(p.month?' '+p.month+'월':'')+(p.day?' '+p.day+'일':'');return p.time_text||'';}
function place(c,p,h){var hint=p.region_hint;if(!hint)return p.place_text||'';
  var shown=exact(c,hint)?hint:hint+' (켜켜이에서 확인)';return p.place_text&&p.place_text!==hint?p.place_text+' · '+shown:shown;}
var REGION=function(c,required){return {name:'region_hint',title:'시군구',items:regions(c),value:c.payload.region_hint,required:required,order:ORDER,noun:'시군구',example:'일산서구',missing:'켜켜이를 한 번 열면 여기서 시군구를 고를 수 있어요.',picked:'고른 곳'};};
function picker(c,h,required){return LH_PICK.html(h,REGION(c,required));}
function bindPicker(form,c,h){LH_PICK.bind(form,h,REGION(c,false));}
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
export const KYEOKYEOI_CARD_HTML = cardDocument('Life Hub · 켜켜이', PICKER_SCRIPT + BODY);
