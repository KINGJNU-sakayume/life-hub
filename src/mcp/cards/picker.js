/**
 * Shared picker for card bodies: choose one label from a reference list the app shared ({id, label, group}),
 * with group chips and a search box. The chosen label goes into a hidden input `name`; tapping it again clears it.
 * Runs in the card iframe as window.LH_PICK. Used by 켜켜이 (시군구) and 업적 라이브러리 (카테고리).
 *
 * o = { name, title, items, value, required, order, noun, example, missing, picked }
 */
export const PICKER_SCRIPT = String.raw`
window.LH_PICK=(function(){
var sq=function(s){return String(s||'').replace(/\s+/g,'');};
function find(items,label){var hits=(items||[]).filter(function(x){return x.label===label;});return hits.length===1?hits[0]:null;}
function html(h,o){var cur=o.value||'',items=o.items||[];
  if(!items.length)return '<div class="field"><span class="lbl">'+h.esc(o.title)+'</span><input type="hidden" name="'+o.name+'" value="'+h.esc(cur)+'"><p class="meta">'+h.esc(o.missing)+(cur?' 지금: '+h.esc(cur):'')+'</p></div>';
  var groups=[];items.forEach(function(x){if(x.group&&groups.indexOf(x.group)<0)groups.push(x.group);});
  var order=o.order||[];groups.sort(function(a,b){var i=order.indexOf(a),j=order.indexOf(b);return (i<0?999:i)-(j<0?999:j);});
  var hit=find(items,cur);
  return '<div class="field pick" data-pick="'+o.name+'"><span class="lbl" id="l-'+o.name+'">'+h.esc(o.title)+(o.required?'':' <span class="opt">선택</span>')+'</span>'+
    '<input type="hidden" name="'+o.name+'" value="'+h.esc(cur)+'"><p class="sel" data-sel></p>'+
    '<input type="search" data-q aria-label="'+h.esc(o.noun)+' 검색" placeholder="이름으로 찾기 (예: '+h.esc(o.example)+')" value="'+h.esc(hit?'':cur)+'" maxlength="40">'+
    '<div class="chips" role="group" aria-label="'+h.esc(o.noun)+' 묶음">'+groups.map(function(g){return '<button type="button" class="chip" data-grp="'+h.esc(g)+'" aria-pressed="'+(!!hit&&hit.group===g)+'">'+h.esc(g)+'</button>';}).join('')+'</div>'+
    '<div class="plist" role="group" aria-labelledby="l-'+o.name+'" data-list></div></div>';}
function bind(form,h,o){var box=form.querySelector('[data-pick="'+o.name+'"]');if(!box)return;var items=o.items||[];
  var hidden=box.querySelector('input[type=hidden]'),q=box.querySelector('[data-q]'),list=box.querySelector('[data-list]'),sel=box.querySelector('[data-sel]');
  var hit=find(items,hidden.value),grp=hit?hit.group:'';
  function draw(){var v=hidden.value,ok=find(items,v),term=sq(q.value),shown=[];
    sel.innerHTML=v?(ok?h.esc(o.picked)+': <b>'+h.esc(v)+'</b> · 다시 누르면 해제':'지금: '+h.esc(v)+' · 목록에서 골라 주세요'):'아직 고르지 않았어요';
    if(term)shown=items.filter(function(x){return sq(x.label).indexOf(term)>=0;}).slice(0,40);
    else if(grp)shown=items.filter(function(x){return x.group===grp;});
    list.innerHTML=shown.map(function(x){return '<button type="button" class="chip" data-pk="'+h.esc(x.label)+'" aria-pressed="'+(x.label===v)+'">'+h.esc(x.label.indexOf(x.group+' ')===0?x.label.slice(x.group.length+1):x.label)+'</button>';}).join('')||
      (term?'<p class="meta">찾는 '+h.esc(o.noun)+'가 없어요.</p>':'');
    box.querySelectorAll('[data-grp]').forEach(function(b){b.setAttribute('aria-pressed',String(!term&&b.dataset.grp===grp));});}
  box.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;e.stopPropagation();
    if(b.dataset.grp!==undefined){grp=grp===b.dataset.grp?'':b.dataset.grp;q.value='';}
    else if(b.dataset.pk!==undefined)hidden.value=hidden.value===b.dataset.pk?'':b.dataset.pk;
    draw();});
  q.addEventListener('input',draw);draw();}
return {find:find,html:html,bind:bind};
})();
`;
