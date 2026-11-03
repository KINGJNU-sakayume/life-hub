/**
 * potcast card body: one album listening, track by track (들음 / 건너뜀). Runs in the card iframe as
 * window.LH_BODY. Album, artist, Spotify IDs and play times stay as proposed; only statuses and the note change.
 */
import { cardDocument } from './shell.js';

const CSS = `
.tl{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}
.tl li{display:flex;gap:10px;align-items:baseline;font-size:14px;padding:3px 0;border-bottom:1px solid var(--rule)}
.tl .n{flex:none;width:22px;color:var(--mute);font-size:12px;text-align:right}.tl .t{flex:1;min-width:0;overflow-wrap:anywhere}
.tl .s{flex:none;font-size:12px;font-weight:600;color:var(--ok-ink)}.tl li.sk .t,.tl li.sk .s{color:var(--mute)}
.trk{display:flex;flex-direction:column}.trk .field{flex-direction:row;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--rule)}
.trk .lbl{flex:1;min-width:0;font-weight:500;font-size:13px;overflow-wrap:anywhere}.trk .chips{flex:none;flex-wrap:nowrap}.trk .chip{min-height:34px;padding:0 10px;font-size:13px}
`;

const BODY = String.raw`
window.LH_BODY=(function(){
var S=[['listened','들음'],['skipped','건너뜀']];
var name=function(t,i){return t.title||'트랙 '+(i+1);};
var from=function(c){return c.payload.origin==='spotify_sync'?'Spotify에서 모음':c.payload.origin==='spotify_history'?'Spotify 기록':'대화';};
return {
  view:function(c,h){var p=c.payload,meta=[p.artist,h.date(p.listened_on),from(c)].filter(Boolean).join(' · ');
    var list=p.whole_album?'<p class="meta" style="margin:0">앨범 전체 들음</p>':'<ol class="tl">'+p.tracks.map(function(t,i){var sk=t.status==='skipped';
      return '<li'+(sk?' class="sk"':'')+'><span class="n">'+(i+1)+'</span><span class="t">'+h.esc(name(t,i))+'</span><span class="s">'+(sk?'건너뜀':'들음')+'</span></li>';}).join('')+'</ol>';
    var n=p.whole_album?0:p.tracks.filter(function(t){return t.status==='listened';}).length;
    return '<div><h2>'+h.esc(p.album)+'</h2><p class="meta">'+h.esc(meta)+'</p></div>'+(p.whole_album?'':h.facts([['들은 곡',n+' / '+p.tracks.length+'곡']]))+list+h.note(p.note);},
  edit:function(c,h){var p=c.payload;
    return (p.whole_album?'<p class="meta" style="margin:0">앨범 전체를 들은 기록이에요.</p>':'<div class="trk">'+p.tracks.map(function(t,i){return h.chips('t'+i,(i+1)+'. '+name(t,i),S,t.status,{required:true}).replace(' <span class="opt">선택</span>','');}).join('')+'</div>')+
      h.input('note','메모',p.note,{optional:true,area:true,max:500});},
  read:function(v,c){var p=JSON.parse(JSON.stringify(c.payload));
    if(!p.whole_album)p.tracks.forEach(function(t,i){if(v['t'+i])t.status=v['t'+i];});
    if(v.note)p.note=v.note;else delete p.note;return p;}
};})();
`;

export const POTCAST_CARD_URI = 'ui://life-hub/card-potcast.html';
export const POTCAST_CARD_HTML = cardDocument('Life Hub · potcast', BODY, CSS);
