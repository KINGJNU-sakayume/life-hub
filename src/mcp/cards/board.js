/** Life Board card body: one memo for the board. Runs in the card iframe as window.LH_BODY. */
import { cardDocument } from './shell.js';

const BODY = String.raw`
window.LH_BODY=(function(){
return {
  view:function(c,h){return '<div><h2>'+h.esc(c.payload.text)+'</h2><p class="meta">승인하면 다음에 보드를 열 때 메모 타일에 나와요.</p></div>';},
  edit:function(c,h){return h.input('text','메모',c.payload.text,{area:true,max:160});},
  read:function(v){var t=String(v.text||'').replace(/\s+/g,' ').trim();if(!t)return '메모를 적어 주세요.';if(t.length>160)return '160자까지 적을 수 있어요.';return {text:t};}
};})();
`;

export const BOARD_CARD_URI = 'ui://life-hub/card-board.html';
export const BOARD_CARD_HTML = cardDocument('Life Hub · Life Board', BODY);
