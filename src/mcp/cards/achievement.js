/**
 * 업적 라이브러리 card body: an activity record (활동 기록) and a custom achievement (새 업적). Runs in the card
 * iframe as window.LH_BODY. The category picker uses the owner's category list (card.refs.categories), and the
 * app saves without asking only when the category is exactly one of them (an achievement may have none).
 */
import { cardDocument } from './shell.js';
import { PICKER_SCRIPT } from './picker.js';

const CSS = `
.ach{display:flex;align-items:center;gap:12px}
.medal{flex:none;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:700}
`;

const BODY = String.raw`
window.LH_BODY=(function(){
var TIER=[['bronze','브론즈','#B7773F'],['silver','실버','#8E99A5'],['gold','골드','#C9982A'],['platinum','플래티넘','#6F86A8'],['diamond','다이아몬드','#2C9DBD']];
var COND=[['count','횟수'],['total','누적'],['streak','연속'],['tag','태그'],['tag_count','태그 횟수']];
var cats=function(c){return (c.refs&&c.refs.categories)||[];};
var exact=function(c,label){return LH_PICK.find(cats(c),label);};
var tierOf=function(id){for(var i=0;i<TIER.length;i++)if(TIER[i][0]===id)return TIER[i];return TIER[0];};
var fmt=function(n){return typeof n==='number'?n.toLocaleString('ko-KR'):'';};
function cond(p){var t=fmt(p.target),u=p.unit||'';
  return {count:'기록 '+t+'번',total:'누적 '+t+u,streak:t+'일 연속',tag:'#'+(p.tag||'')+' 기록 한 번',tag_count:'#'+(p.tag||'')+' 기록 '+t+'번'}[p.condition_type]||'';}
function catText(c,name){return name?(exact(c,name)?name:name+' (앱에서 확인)'):'';}
var CAT=function(c,required){return {name:'category',title:'카테고리',items:cats(c),value:c.payload.category,required:required,order:[],noun:'카테고리',example:'러닝',missing:'앱을 한 번 열면 카테고리를 고를 수 있어요.',picked:'고른 카테고리'};};
var num=function(v){if(v==='')return undefined;var n=Number(String(v).replace(/,/g,''));return isFinite(n)?n:NaN;};
var later={message:'카테고리를 고르면 바로 저장돼요. 지금 승인하면 앱에서 한 번 더 확인해요.',later:'앱에서 고를게요'};
return {
  view:function(c,h){var p=c.payload;
    if(c.type==='achievement_definition'){var t=tierOf(p.tier);
      return '<div class="ach"><span class="medal" style="background:'+t[2]+'" aria-hidden="true">'+h.esc(t[1].slice(0,2))+'</span><div><h2>'+h.esc(p.title)+'</h2><p class="meta">'+h.esc([catText(c,p.category)||'모든 기록',t[1]].join(' · '))+'</p></div></div>'+
        h.facts([['조건',cond(p)]])+h.note(p.description);}
    var amount=p.value!=null?fmt(p.value)+(p.unit||''):'';
    return '<div><h2>'+h.esc(catText(c,p.category))+'</h2><p class="meta">'+h.esc([h.date(p.date),amount].filter(Boolean).join(' · '))+'</p></div>'+
      h.facts([['태그',(p.tags||[]).map(function(x){return '#'+x;}).join(' ')]])+h.note(p.memo);},
  edit:function(c,h){var p=c.payload;
    if(c.type==='achievement_definition')return h.input('title','이름',p.title,{max:40})+
      h.chips('tier','난이도',TIER.map(function(t){return [t[0],t[1]];}),p.tier,{required:true})+
      h.chips('condition_type','조건',COND,p.condition_type,{required:true})+
      '<div class="two">'+h.input('target','목표 수',p.target==null?'':String(p.target),{optional:true,type:'number',max:12})+h.input('unit','단위 (누적)',p.unit,{optional:true,max:20})+'</div>'+
      h.input('tag','태그',p.tag,{optional:true,max:30})+LH_PICK.html(h,CAT(c,false))+h.input('description','설명',p.description,{optional:true,area:true,max:200});
    return LH_PICK.html(h,CAT(c,true))+h.input('date','한 날',p.date,{type:'date',max:10})+
      '<div class="two">'+h.input('value','양',p.value==null?'':String(p.value),{optional:true,type:'number',max:12})+h.input('unit','단위',p.unit,{optional:true,max:20})+'</div>'+
      h.input('tags','태그 (쉼표 구분)',(p.tags||[]).join(', '),{optional:true,max:330})+h.input('memo','메모',p.memo,{optional:true,area:true,max:500});},
  bind:function(form,c,h){LH_PICK.bind(form,h,CAT(c,c.type!=='achievement_definition'));},
  preApprove:function(c){var p=c.payload;
    if(c.type==='achievement_definition')return p.category&&!exact(c,p.category)?later:null;
    return exact(c,p.category)?null:later;},
  read:function(v,c){var out={};
    if(c.type==='achievement_definition'){
      if(!v.title)return '이름을 적어 주세요.';out.title=v.title;out.tier=v.tier;out.condition_type=v.condition_type;
      if(v.description)out.description=v.description;if(v.category)out.category=v.category;
      var t=num(v.target),k=v.condition_type;
      if(k==='tag'||k==='tag_count'){if(!v.tag)return '태그를 적어 주세요.';out.tag=v.tag.replace(/^#+/,'');}
      if(k==='total'){if(!(t>0))return '목표 수를 적어 주세요.';if(!v.unit)return '단위를 적어 주세요.';out.target=t;out.unit=v.unit;}
      else if(k!=='tag'){if(!(t>=1&&Math.floor(t)===t))return '목표 수는 1 이상의 정수예요.';out.target=t;}
      return out;}
    if(!v.category)return '카테고리를 골라 주세요.';out.category=v.category;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(v.date))return '한 날을 확인해 주세요.';out.date=v.date;
    var n=num(v.value);if(n!==undefined){if(!(n>=0))return '양은 0 이상의 숫자예요.';out.value=n;if(v.unit)out.unit=v.unit;}else if(v.unit)return '양을 적어 주세요.';
    var tags=v.tags.split(/[,\s]+/).map(function(x){return x.replace(/^#+/,'');}).filter(Boolean),seen={};
    tags=tags.filter(function(x){if(seen[x])return false;seen[x]=1;return true;});
    if(tags.length>10)return '태그는 10개까지예요.';if(tags.length)out.tags=tags;
    if(v.memo)out.memo=v.memo;return out;}
};})();
`;

export const ACHIEVEMENT_CARD_URI = 'ui://life-hub/card-achievement.html';
export const ACHIEVEMENT_CARD_HTML = cardDocument('Life Hub · 업적 라이브러리', PICKER_SCRIPT + BODY, CSS);
