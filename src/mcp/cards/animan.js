/**
 * AniMan card body: one progress update (애니 에피소드 / 만화 권). Runs in the card iframe as window.LH_BODY.
 * Titles come from the app's catalogue (card.refs.series: id, title, accent colour). The app marks progress
 * without asking only when the title means exactly one series and every number exists there.
 */
import { cardDocument } from './shell.js';

const CSS = `.band{height:6px;border-radius:999px;background:var(--ac,#03acb1)}`;

const BODY = String.raw`
window.LH_BODY=(function(){
var K=[['episode','애니 · 화'],['volume','만화 · 권']];
var series=function(c){return (c.refs&&c.refs.series)||[];};
var norm=function(s){return String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');};
function parts(t){var out=[t,t.replace(/\s*[([].*?[)\]]\s*/g,' ')],re=/[([](.*?)[)\]]/g,m;while((m=re.exec(t)))out.push(m[1]);return out.map(norm).filter(Boolean);}
function match(c,title){var w=norm(title);return w?series(c).filter(function(s){return parts(s.label).indexOf(w)>=0;}):[];}
function what(p){var u=p.kind==='episode'?'화':'권',s=p.season?p.season+'기 ':'';return p.up_to?s+p.up_to+u+'까지':s+(p.numbers||[]).join('·')+u;}
var nums=function(v){if(!v)return [];return v.split(/[\s,·]+/).filter(Boolean).map(Number);};
var whole=function(n,hi){return n>=1&&n<=hi&&Math.floor(n)===n;};
return {
  view:function(c,h){var p=c.payload,hit=match(c,p.title),s=hit.length===1?hit[0]:null;
    return '<div class="band" style="--ac:'+h.esc(s&&s.group||'#03acb1')+'"></div><div><h2>'+h.esc(s?s.label:p.title)+'</h2><p class="meta">'+h.esc((p.kind==='episode'?'애니 ':'만화 ')+what(p))+'</p></div>'+
      h.facts([['작품',s?'':(hit.length?'여러 작품과 맞아요 · 앱에서 확인':'카탈로그에 없어요 · 앱에서 확인')]])+h.note(p.note);},
  edit:function(c,h){var p=c.payload,o=series(c).map(function(s){return '<option value="'+h.esc(s.label)+'">';}).join('');
    return h.input('title','작품',p.title,{max:100}).replace('<input ','<input list="srl" ')+'<datalist id="srl">'+o+'</datalist>'+
      h.chips('kind','종류',K,p.kind,{required:true})+
      '<div class="two">'+h.input('up_to','여기까지',p.up_to==null?'':String(p.up_to),{optional:true,type:'number',max:4})+h.input('numbers','이것만 (쉼표)',(p.numbers||[]).join(', '),{optional:true,max:200})+'</div>'+
      h.input('season','시즌 (애니)',p.season==null?'':String(p.season),{optional:true,type:'number',max:2})+h.input('note','메모',p.note,{optional:true,area:true,max:300});},
  read:function(v){if(!v.title)return '작품을 적어 주세요.';var out={title:v.title,kind:v.kind},u=Number(v.up_to),n=nums(v.numbers);
    if(!!v.up_to===n.length>0)return '「여기까지」와 「이것만」 중 하나만 적어 주세요.';
    if(v.up_to){if(!whole(u,5000))return '번호를 확인해 주세요.';out.up_to=u;}
    else{if(n.length>50||!n.every(function(x){return whole(x,5000);}))return '번호를 확인해 주세요.';out.numbers=n.filter(function(x,i){return n.indexOf(x)===i;});}
    if(v.season){if(v.kind!=='episode'||!whole(Number(v.season),30))return '시즌은 애니에만, 1~30이에요.';out.season=Number(v.season);}
    if(v.note)out.note=v.note;return out;},
  preApprove:function(c){return match(c,c.payload.title).length===1?null:{message:'작품이 하나로 정해지면 바로 기록돼요. 지금 승인하면 AniMan에서 작품을 골라요.',later:'앱에서 고를게요'};}
};})();
`;

export const ANIMAN_CARD_URI = 'ui://life-hub/card-animan.html';
export const ANIMAN_CARD_HTML = cardDocument('Life Hub · AniMan', BODY, CSS);
