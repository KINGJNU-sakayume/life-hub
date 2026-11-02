/**
 * 역 도장깨기 card body: a station draw (역 뽑기) and a station visit (도장). Both show a 역명판 (line colour band,
 * the station, its neighbours). A fresh draw rolls like the app (core/draw.js): lines top→bottom slowing down,
 * then stations left/right, then a brake shake. Lines and stations come from card.refs (the app's lists).
 */
import { cardDocument } from './shell.js';

const CSS = `
.sign{--lc:#5f6368;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--card)}
.sg-band{background:var(--lc);height:10px}
.sg-top{display:flex;justify-content:center;padding-top:10px;height:38px;overflow:hidden}
.sg-badge{display:inline-block;padding:3px 12px;border-radius:999px;background:var(--lc);color:#fff;font-size:13px;font-weight:700}
.sg-main{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;padding:10px 14px 16px;overflow:hidden}
.sg-side{font-size:13px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sg-side.r{text-align:right}
.sg-name{font-size:30px;font-weight:800;letter-spacing:-.02em;padding:4px 18px;border-radius:999px;border:3px solid var(--lc);white-space:nowrap}
.dn{animation:dn .12s ease-out}.lt{animation:lt .1s ease-out}.rt{animation:rt .1s ease-out}.brake{animation:brake .5s ease-out}
@keyframes dn{from{transform:translateY(-70%);opacity:.3}}@keyframes lt{from{transform:translateX(40%);opacity:.4}}@keyframes rt{from{transform:translateX(-40%);opacity:.4}}
@keyframes brake{20%{transform:translateX(-6px)}45%{transform:translateX(4px)}70%{transform:translateX(-2px)}}
`;

const BODY = String.raw`
window.LH_BODY=(function(){
var spun={};
var lines=function(c){return (c.refs&&c.refs.lines)||[];};
var lineOf=function(c,name){var l=lines(c);for(var i=0;i<l.length;i++)if(l[i].label===name)return l[i];return null;};
var bare=function(n){return String(n||'').replace(/\s+/g,'').replace(/\(.*\)$/,'').replace(/역$/,'');};
var shown=function(n){return String(n||'').replace(/\(.*\)$/,'');};
function onLine(c,line){var seen={},out=[];((c.refs&&c.refs.stations)||[]).forEach(function(s){if(s.group===line&&!seen[s.label]){seen[s.label]=1;out.push(s.label);}});return out;}
function matches(c,name){var ex=/\(.*\)$/.test(name),w=bare(name),seen={},n=0;
  ((c.refs&&c.refs.stations)||[]).forEach(function(s){if(!seen[s.label]&&(ex?s.label===name:bare(s.label)===w)){seen[s.label]=1;n++;}});return n;}
function sign(h,color,line,name,prev,next){
  return '<div class="sign" style="--lc:'+h.esc(color||'#5f6368')+'"><div class="sg-band"></div><div class="sg-top"><span class="sg-badge" data-l>'+h.esc(line||'노선 미정')+'</span></div>'+
    '<div class="sg-main"><span class="sg-side" data-p>'+(prev?'← '+h.esc(shown(prev)):'')+'</span><strong class="sg-name" data-n>'+h.esc(shown(name))+'</strong><span class="sg-side r" data-x>'+(next?h.esc(shown(next))+' →':'')+'</span></div></div>';}
var delay=function(i,t){return 45+330*Math.pow(i/t,2.6);};
var sleep=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
return {
  noEdit:function(c){return c.type==='station_draw';},
  approveLabel:function(c){return c.type==='station_draw'?'여기 갈래요':'';},
  view:function(c,h){var p=c.payload,L=lineOf(c,p.line);
    if(c.type==='station_draw'){var s=onLine(c,p.line),i=s.indexOf(p.station);
      return sign(h,L&&L.group,p.line,p.station,i>0?s[i-1]:'',i>=0&&i<s.length-1?s[i+1]:'')+'<p class="meta" style="margin:0">'+h.esc(h.date(p.date))+' 뽑기 · 아직 도장은 아니에요</p>';}
    var ln=p.line;if(!ln){var g={};((c.refs&&c.refs.stations)||[]).forEach(function(x){if(x.label===p.station)g[x.group]=1;});g=Object.keys(g);if(g.length===1)ln=g[0];}
    L=lineOf(c,ln);return sign(h,L&&L.group,ln||'',p.station,'','')+h.facts([['다녀온 날',h.date(p.date)]])+h.note(p.note);},
  edit:function(c,h){var p=c.payload,seen={},opts=((c.refs&&c.refs.stations)||[]).filter(function(s){if(seen[s.label])return false;seen[s.label]=1;return true;})
      .map(function(s){return '<option value="'+h.esc(s.label)+'">';}).join('');
    return h.input('station','역',p.station,{max:40}).replace('<input ','<input list="stl" ')+'<datalist id="stl">'+opts+'</datalist>'+
      h.input('line','노선',p.line,{optional:true,max:20})+h.input('date','다녀온 날',p.date,{type:'date',max:10})+h.input('note','메모',p.note,{optional:true,area:true,max:300});},
  read:function(v){if(!v.station)return '역을 적어 주세요.';if(!/^\d{4}-\d{2}-\d{2}$/.test(v.date))return '다녀온 날을 확인해 주세요.';
    var out={station:v.station,date:v.date};if(v.line)out.line=v.line;if(v.note)out.note=v.note;return out;},
  preApprove:function(c){if(c.type!=='station_visit'||matches(c,c.payload.station)===1)return null;
    return {message:'역 이름이 하나로 정해지면 바로 도장을 찍어요. 지금 승인하면 역 도장깨기에서 역을 골라요.',later:'앱에서 고를게요'};},
  mount:function(root,c){var p=c.payload;if(c.type!=='station_draw'||c.status!=='pending'||spun[c.candidate_id])return;
    var s=onLine(c,p.line),idx=s.indexOf(p.station),all=lines(c);if(idx<0||all.length<2)return;
    var today=new Date(Date.now()+9*3600000).toISOString().slice(0,10);if(p.date!==today)return;
    spun[c.candidate_id]=true;if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)return;
    var q=function(a){return root.querySelector('['+a+']');},sg=root.querySelector('.sign'),badge=q('data-l'),nm=q('data-n'),pv=q('data-p'),nx=q('data-x');
    var anim=function(el,cls){el.classList.remove('dn','lt','rt');void el.offsetWidth;el.classList.add(cls);};
    nm.textContent='?';pv.textContent='';nx.textContent='';
    (async function(){var len=all.length,target=-1;all.forEach(function(L,i){if(L.label===p.line)target=i;});
      var total=18+Math.floor(Math.random()*len),start=(((target-total)%len)+len)%len;
      for(var i=0;i<=total;i++){var L=all[(start+i)%len];sg.style.setProperty('--lc',L.group);badge.textContent=L.label;anim(badge,'dn');await sleep(delay(i,total));}
      await sleep(380);var steps=14+Math.floor(Math.random()*8),dir=idx>=steps||idx+steps>=s.length?-1:1;
      for(var j=0;j<=steps;j++){var k=(((idx+dir*(steps-j))%s.length)+s.length)%s.length;
        nm.textContent=shown(s[k]);pv.textContent=k>0?'← '+shown(s[k-1]):'';nx.textContent=k<s.length-1?shown(s[k+1])+' →':'';anim(nm,dir<0?'lt':'rt');await sleep(delay(j,steps));}
      sg.classList.add('brake');})();},
  foot:function(c,h){if(c.type!=='station_draw')return null;var w=h.appLink('역 도장깨기 열기');
    if(c.status==='approved')return '<div class="foot"><p class="fl">다음에 역 도장깨기를 열면 지금 목표 역으로 정해져요. '+w+'</p></div>';
    if(c.status==='confirmed')return '<div class="foot"><p class="fl">목표 역으로 정했어요. '+w+'</p></div>';
    if(c.status==='rejected')return '<div class="foot"><p class="fl">목표 역으로 정하지 않았어요.</p></div>';return null;}
};})();
`;

export const SUB_CARD_URI = 'ui://life-hub/card-sub.html';
export const SUB_CARD_HTML = cardDocument('Life Hub · 역 도장깨기', BODY, CSS);
