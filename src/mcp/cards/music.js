/**
 * music card body: one album listening, track by track — only the tracks that were listened to. Runs in the
 * card iframe as window.LH_BODY. Album, artist, Spotify IDs and play times stay as proposed; only which tracks
 * count (a track can be turned off) and the note change.
 */
import { cardDocument } from './shell.js';

const CSS = `
.tl{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}
.tl li{display:flex;gap:10px;align-items:baseline;font-size:14px;padding:3px 0;border-bottom:1px solid var(--rule)}
.tl .n{flex:none;width:22px;color:var(--mute);font-size:12px;text-align:right}.tl .t{flex:1;min-width:0;overflow-wrap:anywhere}
.trk{display:flex;flex-direction:column}.trk .field{flex-direction:row;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--rule)}
.trk .lbl{flex:1;min-width:0;font-weight:500;font-size:13px;overflow-wrap:anywhere}.trk .chips{flex:none;flex-wrap:nowrap}.trk .chip{min-height:34px;padding:0 10px;font-size:13px}
`;

const BODY = String.raw`
window.LH_BODY=(function(){
var S=[['listened','들음']];
// Older proposals may still carry "skipped" tracks; they are not shown and not kept.
var heard=function(p){return p.tracks.filter(function(t){return t.status==='listened';});};
var name=function(t,i){return t.title||'트랙 '+(i+1);};
var from=function(c){return c.payload.origin==='spotify_sync'?'Spotify에서 모음':c.payload.origin==='spotify_history'?'Spotify 기록':'대화';};
return {
  view:function(c,h){var p=c.payload,meta=[p.artist,h.date(p.listened_on),from(c)].filter(Boolean).join(' · ');
    var list=p.whole_album?'<p class="meta" style="margin:0">앨범 전체 들음</p>':'<ol class="tl">'+heard(p).map(function(t,i){
      return '<li><span class="n">'+(i+1)+'</span><span class="t">'+h.esc(name(t,i))+'</span></li>';}).join('')+'</ol>';
    var n=p.whole_album?0:heard(p).length;
    return '<div><h2>'+h.esc(p.album)+'</h2><p class="meta">'+h.esc(meta)+'</p></div>'+(p.whole_album?'':h.facts([['들은 곡',n+'곡']]))+list+h.note(p.note);},
  edit:function(c,h){var p=c.payload;
    return (p.whole_album?'<p class="meta" style="margin:0">앨범 전체를 들은 기록이에요.</p>':'<div class="trk">'+(function(){var k=0;return p.tracks.map(function(t,i){if(t.status!=='listened')return '';k++;return h.chips('t'+i,k+'. '+name(t,i),S,'listened',{}).replace(' <span class="opt">선택</span>','');}).join('');})()+'</div>')+
      h.input('note','메모',p.note,{optional:true,area:true,max:500});},
  read:function(v,c){var p=JSON.parse(JSON.stringify(c.payload));
    // A track tapped off is left out; so is any leftover "skipped" one.
    if(!p.whole_album){p.tracks=p.tracks.filter(function(t,i){return t.status==='listened'&&v['t'+i]!=='';});
      if(!p.tracks.length)return '들은 곡을 하나 이상 남겨 주세요.';}
    if(v.note)p.note=v.note;else delete p.note;return p;}
};})();
`;

export const MUSIC_CARD_URI = 'ui://life-hub/card-music.html';
/** The card's URI before the rename: tool results and conversations from then still read it (same card). */
export const LEGACY_MUSIC_CARD_URIS = Object.freeze(['ui://life-hub/card-potcast.html']);
export const MUSIC_CARD_HTML = cardDocument('Life Hub · music', BODY, CSS);
