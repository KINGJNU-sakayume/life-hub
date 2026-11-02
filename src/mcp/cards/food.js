/** PALATE card body: meal (식사 기록) and wish (먹어보기). Runs in the card iframe as window.LH_BODY. */
import { cardDocument } from './shell.js';

const BODY = String.raw`
window.LH_BODY=(function(){
var V=[['LIKE','좋았어요'],['NEUTRAL','보통이었어요'],['DISLIKE','별로였어요']];
var R=[['YES','네'],['MAYBE','글쎄요'],['NO','아니요']];
var RT={YES:'또 먹을래요',MAYBE:'글쎄요',NO:'다시는 안 먹을래요'};
var K=[['visit_place','가 볼 곳'],['try_menu','먹어 볼 메뉴']];
var KT={visit_place:'가 보고 싶은 곳',try_menu:'먹어 보고 싶은 메뉴'};
var label=function(list,v){for(var i=0;i<list.length;i++)if(list[i][0]===v)return list[i][1];return '';};
var host=function(u){try{return new URL(u).hostname;}catch(e){return '';}};
return {
  view:function(c,h){var p=c.payload;
    if(c.type==='wish')return '<div><h2>'+h.esc(p.name)+'</h2><p class="meta">'+h.esc(KT[p.wish_kind]||'')+'</p></div>'+h.facts([['링크',host(p.source_url)]])+h.note(p.note);
    var meta=[p.place_name,h.date(p.eaten_at)].filter(Boolean).join(' · ');
    return '<div><h2>'+h.esc(p.menu_name)+'</h2>'+(meta?'<p class="meta">'+h.esc(meta)+'</p>':'')+'</div>'+
      h.facts([['평가',label(V,p.verdict)],['다시 먹기',RT[p.reorder_intent]]])+h.note(p.note);},
  edit:function(c,h){var p=c.payload;
    if(c.type==='wish')return h.chips('wish_kind','종류',K,p.wish_kind,{required:true})+h.input('name','이름',p.name)+
      h.input('source_url','링크',p.source_url,{optional:true,type:'url',max:2048})+h.input('note','메모',p.note,{optional:true,area:true});
    return h.input('menu_name','메뉴',p.menu_name)+'<div class="two">'+h.input('place_name','식당',p.place_name,{optional:true})+
      h.input('eaten_at','먹은 날',p.eaten_at,{optional:true,type:'date',max:10})+'</div>'+
      h.chips('verdict','어땠나요',V,p.verdict)+h.chips('reorder_intent','또 먹을래요?',R,p.reorder_intent)+h.input('note','메모',p.note,{optional:true,area:true});},
  preApprove:function(c){var p=c.payload;
    if(c.type==='meal'&&(!p.eaten_at||!p.verdict||!p.reorder_intent))return {message:'먹은 날·평가·다시 먹기를 채우면 바로 저장돼요. 지금 승인하면 PALATE를 열 때 마저 확인해요.',later:'PALATE에서 마저 할게요'};
    return null;},
  read:function(v,c){var out={},keys=c.type==='wish'?['wish_kind','name','source_url','note']:['menu_name','place_name','eaten_at','verdict','reorder_intent','note'];
    keys.forEach(function(k){if(v[k])out[k]=v[k];});
    if(c.type==='wish'&&!out.name)return '이름을 적어 주세요.';
    if(c.type==='wish'&&out.source_url&&!/^https:\/\//.test(out.source_url))return '링크는 https://로 시작해야 해요.';
    if(c.type!=='wish'&&!out.menu_name)return '메뉴를 적어 주세요.';
    return out;}
};})();
`;

export const FOOD_CARD_URI = 'ui://life-hub/card-food.html';
export const FOOD_CARD_HTML = cardDocument('Life Hub · PALATE', BODY);
