/**
 * 일기 룰렛 card body: today's mission on the app's slot drum (SlotMachinePicker: 56px rows × 5, result in the
 * middle row, easeOutQuart over 2.8 s, paper colours and a serif face). The drum turns once when a fresh,
 * pending proposal for today first shows; redrawn from history it rests on the result. The only button is
 * 「일기 쓰기」: it approves and opens the app on its write page. Mission titles come from the list the app
 * shared (card.refs.missions, via card_refresh) or the one resolved mission (card.mission).
 */
import { cardDocument } from './shell.js';

const CSS = `
.drum-wrap{--paper:#fffdf9;--paper-line:#e2dacd;--paper-ink:#2b2622;--paper-mute:#877c71;--paper-accent:#b5533c;position:relative;height:280px;overflow:hidden;border:1px solid var(--paper-line);border-radius:16px;background:var(--paper)}
:root[data-theme=dark] .drum-wrap{--paper:#24211d;--paper-line:#3c3732;--paper-ink:#ece5da;--paper-mute:#978c80;--paper-accent:#de8466}
.drum-frame{position:absolute;left:12px;right:12px;top:116px;height:48px;border:2px solid var(--paper-accent);border-radius:12px;z-index:2;pointer-events:none}
.drum-fade{position:absolute;left:0;right:0;height:90px;z-index:3;pointer-events:none}
.drum-fade.t{top:0;background:linear-gradient(var(--paper),transparent)}.drum-fade.b{bottom:0;background:linear-gradient(transparent,var(--paper))}
.drum{will-change:transform}
.row{height:56px;display:flex;align-items:center;gap:12px;padding:0 24px}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.rt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:15px;color:var(--paper-mute)}
.row.on .rt{font-family:"Noto Serif KR","Apple Myungjo","AppleMyungjo","Nanum Myeongjo",serif;font-size:16px;font-weight:700;color:var(--paper-ink)}
.rc{font-size:12px;color:var(--paper-mute);flex:none;display:none}.row.on .rc{display:inline}
`;

const BODY = String.raw`
window.LH_BODY=(function(){
var ROW=56,CENTER=2,REPEATS=4,TARGET=2,SPIN=2800;
var ORDER=['언어','시점','시간·분량','그림','상상','양식'];
var COLOR={'언어':'#5A6BD6','시점':'#009688','시간·분량':'#BD7E00','그림':'#D2467A','상상':'#3F8A2A','양식':'#8E5BB0'};
var spun={};
function list(c){var r=(c.refs&&c.refs.missions)||[];if(!r.length)return c.mission?[c.mission]:[];
  var buckets=ORDER.map(function(g){return r.filter(function(m){return m.group===g;});});
  buckets.push(r.filter(function(m){return ORDER.indexOf(m.group)<0;}));
  var out=[];for(var i=0;out.length<r.length;i++)buckets.forEach(function(b){if(b[i])out.push(b[i]);});return out;}
function today(){var d=new Date(Date.now()+7*3600000);return d.toISOString().slice(0,10);}
var ease=function(t){return 1-Math.pow(1-t,4);};
function geometry(c){var l=list(c),idx=-1;for(var i=0;i<l.length;i++)if(l[i].id===c.payload.mission_id)idx=i;
  var reps=l.length>1?REPEATS:1,target=l.length>1?TARGET:0;
  return {list:l,idx:idx,reps:reps,landed:idx<0?-1:target*l.length+idx,idle:l.length>1?-(l.length*ROW)+CENTER*ROW:CENTER*ROW,
    end:idx<0?CENTER*ROW:-((target*l.length+idx)*ROW)+CENTER*ROW};}
return {
  noEdit:true, approveLabel:'일기 쓰기',
  view:function(c,h){var g=geometry(c),rows='';
    for(var r=0;r<g.reps;r++)g.list.forEach(function(m,i){var n=r*g.list.length+i;
      rows+='<div class="row'+(n===g.landed?' on':'')+'" data-n="'+n+'"><span class="dot" style="background:'+(COLOR[m.group]||'#877c71')+'"></span><span class="rt">'+h.esc(m.label)+'</span><span class="rc">'+h.esc(m.group||'')+'</span></div>';});
    var m=g.idx>=0?g.list[g.idx]:null;
    return '<p class="meta" style="margin:0">'+h.esc(h.date(c.payload.date))+' 일기</p>'+
      '<div class="drum-wrap" role="img" aria-label="'+h.esc(m?'오늘의 미션: '+m.label:'오늘의 미션')+'"><div class="drum-frame"></div><div class="drum-fade t"></div><div class="drum-fade b"></div>'+
      '<div class="drum" style="transform:translateY('+g.end+'px)">'+rows+'</div></div>';},
  edit:function(){return '';},
  read:function(){return {};},
  mount:function(root,c){var g=geometry(c),drum=root.querySelector('.drum');if(!drum||g.idx<0||g.list.length<2)return;
    if(c.status!=='pending'||spun[c.candidate_id]||c.payload.date!==today())return;
    spun[c.candidate_id]=true;
    if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    var on=root.querySelector('.row.on');if(on)on.classList.remove('on');
    drum.style.transform='translateY('+g.idle+'px)';var start=null;
    function frame(ts){if(start===null)start=ts;var t=Math.min((ts-start)/SPIN,1);
      drum.style.transform='translateY('+(g.idle+(g.end-g.idle)*ease(t))+'px)';
      if(t<1)requestAnimationFrame(frame);else{var row=drum.querySelector('[data-n="'+g.landed+'"]');if(row)row.classList.add('on');}}
    requestAnimationFrame(frame);},
  foot:function(c,h){var w=h.appLink('일기 쓰기','#/write');
    if(c.status==='drawn')return '<div class="foot"><p class="fl">일기 룰렛에서 이미 뽑은 오늘의 미션이에요. '+w+'</p></div>';
    if(c.status==='approved')return '<div class="foot"><p class="fl">다음에 일기 룰렛을 열면 오늘의 미션으로 정해져요. '+w+'</p></div>';
    if(c.status==='confirmed')return '<div class="foot"><p class="fl">오늘의 미션으로 정했어요. '+w+'</p></div>';
    if(c.status==='rejected')return '<div class="foot"><p class="fl">오늘의 미션으로 정하지 않았어요.</p></div>';
    return null;},
  afterApprove:function(c,open){if(c.status==='approved')open('#/write');}
};})();
`;

export const DIARYROULETTE_CARD_URI = 'ui://life-hub/card-diaryroulette.html';
export const DIARYROULETTE_CARD_HTML = cardDocument('Life Hub · 일기 룰렛', BODY, CSS);
