/**
 * 책장 card body: one reading record (읽는 중 + 쪽 / 완독 + 별점·인생책·완독일). Runs in the card iframe as
 * window.LH_BODY. Books come from the app's catalogue: card.refs.works (work id, title, author) and
 * card.refs.editions (edition id, publisher, "workId/volume"). The app records without asking only when the
 * title (and author) means exactly one work, and its publisher and volume are clear (see bookMatch in tools.js).
 */
import { cardDocument } from './shell.js';

const BODY = String.raw`
window.LH_BODY=(function(){
var ST=[['reading','읽는 중'],['completed','완독']],STT={reading:'읽는 중',completed:'완독'};
var RT=[['1','★1'],['2','★2'],['3','★3'],['4','★4'],['5','★5']];
var norm=function(s){return String(s||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,'');};
var refs=function(c,k){return (c.refs&&c.refs[k])||[];};
function works(c,p){var t=norm(p.title),a=norm(p.author);return t?refs(c,'works').filter(function(w){var g=norm(w.group);return norm(w.label)===t&&(!a||(g&&(g.indexOf(a)>=0||a.indexOf(g)>=0)));}):[];}
function pick(list,want){if(list.length===1)return list;return want==null||want===''?[]:list.filter(function(x){return x===want;});}
// What is still unclear: '' when the app can record it as is.
function gap(c,p){var w=works(c,p);if(w.length!==1)return w.length?'같은 제목의 책이 여러 권이에요':'카탈로그에 없어요';
  var ed=refs(c,'editions').filter(function(e){return String(e.group).indexOf(w[0].id+'/')===0;});
  var pubs=ed.map(function(e){return e.label;}).filter(function(x,i,a){return a.indexOf(x)===i;});
  var pub=pick(pubs.map(norm),p.publisher?norm(p.publisher):null);if(pub.length!==1)return pubs.length?'판본(출판사)을 골라야 해요':'판본이 없어요';
  var vols=ed.filter(function(e){return norm(e.label)===pub[0];}).map(function(e){return Number(String(e.group).split('/')[1]);});
  return pick(vols,p.volume==null?null:p.volume).length===1?'':'몇 권인지 골라야 해요';}
function line(p){return [p.author,p.publisher,p.volume?p.volume+'권':''].filter(Boolean).join(' · ');}
var int=function(v,hi){var n=Number(v);return n>=1&&n<=hi&&Math.floor(n)===n?n:null;};
return {
  view:function(c,h){var p=c.payload,g=gap(c,p),m=line(p);
    return '<div><h2>'+h.esc(p.title)+'</h2>'+(m?'<p class="meta">'+h.esc(m)+'</p>':'')+'</div>'+
      h.facts([['상태',STT[p.state]+(p.current_page?' · '+p.current_page+'쪽':'')],['별점',p.rating?'★'.repeat(p.rating):''],['인생책',p.liked?'예':''],
        [p.state==='completed'?'완독일':'날짜',h.date(p.date)],['책',g?g+' · 앱에서 확인':'']])+h.note(p.note);},
  edit:function(c,h){var p=c.payload,o=refs(c,'works').map(function(w){return '<option value="'+h.esc(w.label)+'">'+h.esc(w.group||'')+'</option>';}).join('');
    return h.input('title','제목',p.title).replace('<input ','<input list="wk" ')+'<datalist id="wk">'+o+'</datalist>'+
      '<div class="two">'+h.input('author','지은이',p.author,{optional:true,max:100})+h.input('publisher','출판사',p.publisher,{optional:true,max:100})+'</div>'+
      '<div class="two">'+h.input('volume','권',p.volume==null?'':String(p.volume),{optional:true,type:'number',max:3})+h.input('date','날짜',p.date,{optional:true,type:'date',max:10})+'</div>'+
      h.chips('state','상태',ST,p.state,{required:true})+h.input('current_page','읽은 쪽 (읽는 중)',p.current_page==null?'':String(p.current_page),{optional:true,type:'number',max:5})+
      h.chips('rating','별점 (완독)',RT,p.rating==null?'':String(p.rating))+h.chips('liked','인생책 (완독)',[['yes','인생책']],p.liked?'yes':'')+
      h.input('note','메모',p.note,{optional:true,area:true,max:500});},
  read:function(v){if(!v.title)return '제목을 적어 주세요.';var out={title:v.title,state:v.state};
    ['author','publisher','note','date'].forEach(function(k){if(v[k])out[k]=v[k];});
    if(v.volume){if(!int(v.volume,200))return '권은 1~200이에요.';out.volume=int(v.volume,200);}
    if(v.state==='reading'){if(v.rating||v.liked)return '별점과 인생책은 완독한 책에만 적어요.';
      if(v.current_page){if(!int(v.current_page,20000))return '읽은 쪽을 확인해 주세요.';out.current_page=int(v.current_page,20000);}}
    else{if(v.current_page)return '완독한 책에는 읽은 쪽을 적지 않아요.';if(v.rating)out.rating=Number(v.rating);if(v.liked)out.liked=true;}
    return out;},
  preApprove:function(c){var g=gap(c,c.payload);return g?{message:g+'. 책이 하나로 정해지면 바로 기록돼요. 지금 승인하면 책장에서 골라요.',later:'책장에서 고를게요'}:null;}
};})();
`;

export const LETTERBOOKXD_CARD_URI = 'ui://life-hub/card-letterbookxd.html';
export const LETTERBOOKXD_CARD_HTML = cardDocument('Life Hub · 책장', BODY);
