/* QuickBoard — local-first multi-board Kanban */
const LS_KEY = 'quickboard.v1';
const FB_CFG_KEY = 'quickboard.firebase';
const SYNC_KEY = 'quickboard.synckey';
const CREDS_DISMISS = 'quickboard.credsDismiss';

const uid = () => Math.random().toString(36).slice(2,10);
const todayStr = () => new Date().toISOString().slice(0,10);
const isToday = (d) => d === todayStr();
const isOverdue = (d) => d && d < todayStr();

function defaultState(){
  const b1 = uid(), b2 = uid(), b3 = uid(), b4 = uid();
  const col = (name) => ({id: uid(), name});
  const mkCols = () => [col('Inbox'), col('Today'), col('Doing'), col('Done')];
  const boards = [
    {id:b1, name:'Daily Tasks', columns: mkCols()},
    {id:b2, name:'Quick Notes', columns: mkCols()},
    {id:b3, name:'Onboarding', columns: mkCols()},
    {id:b4, name:'Credentials', columns: mkCols()},
  ];
  const cards = [
    {id:uid(), boardId:b1, colId:boards[0].columns[0].id, title:'Try quick add: type + Enter', details:'Use #tag, !high, due:tomorrow — e.g. Call bank #errand due:tomorrow !high', tags:['howto'], priority:'med', due:todayStr(), createdAt:Date.now()},
    {id:uid(), boardId:b1, colId:boards[0].columns[1].id, title:'Drag me to Doing →', details:'Desktop: drag & drop. Phone: use ← → buttons on card.', tags:['howto'], priority:'', due:'', createdAt:Date.now()},
    {id:uid(), boardId:b2, colId:boards[1].columns[0].id, title:'Paste Apple Notes via Import', details:'Import button → paste lines, each line becomes a card.', tags:['notes'], priority:'', due:'', createdAt:Date.now()},
    {id:uid(), boardId:b3, colId:boards[2].columns[0].id, title:'Onboarding template: VPN + laptop + accounts', details:'- Get VPN\n- Laptop setup\n- Email / Slack / GitHub access', tags:['onboarding'], priority:'high', due:'', createdAt:Date.now()},
    {id:uid(), boardId:b4, colId:boards[3].columns[0].id, title:'Example: WiFi hint (not real secret)', details:'Hint only — real passwords in Keychain/1Password.', tags:['creds'], priority:'', due:'', createdAt:Date.now()},
  ];
  return {boards, cards, activeBoardId:b1};
}

let state = load();
healState();
function load(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return defaultState();
    const s = JSON.parse(raw);
    if(!s.boards || !s.cards) return defaultState();
    if(!s.activeBoardId) s.activeBoardId = s.boards[0]?.id;
    return s;
  }catch{ return defaultState(); }
}
function healState(){
  // Remap cards pointing at deleted columns into the board's first column
  // (prevents invisible "orphan" cards).
  let fixed=0;
  state.boards.forEach(b=>{
    const ids=new Set(b.columns.map(c=>c.id));
    if(!ids.size) return;
    state.cards.forEach(c=>{
      if(c.boardId===b.id && !ids.has(c.colId)){ c.colId=b.columns[0].id; fixed++; }
    });
  });
  return fixed;
}
// --- undo: pre-change snapshots, captured automatically on every real mutation ---
const undoStack=[];
function save(localOnly, skipUndo){
  if(!skipUndo){
    try{
      const prev=localStorage.getItem(LS_KEY);
      if(prev){
        // navigation-only saves (tab switches) don't change content — don't pollute undo
        const po=JSON.parse(prev);
        if(JSON.stringify({b:po.boards,c:po.cards})!==JSON.stringify({b:state.boards,c:state.cards})){
          undoStack.push(prev); if(undoStack.length>15) undoStack.shift();
        }
      }
    }catch{}
  }
  healState();
  state._ts = Date.now();
  localStorage.setItem(LS_KEY, JSON.stringify(state));
  renderStats();
  refreshUndoBtn();
  if(!localOnly) pushToCloud();
}
function refreshUndoBtn(){ const b=$('undoBtn'); if(b) b.disabled=!undoStack.length; }
function doUndo(){
  const prev=undoStack.pop(); refreshUndoBtn();
  if(!prev){ toast('Nothing to undo'); return; }
  takeSnapshot('pre-undo'); // worst-case safety net in backups
  try{ state=JSON.parse(prev); }catch{ toast('Undo failed'); return; }
  if(!state.activeBoardId) state.activeBoardId=state.boards[0]?.id;
  healState(); save(true,true); render(); refreshUndoBtn();
  toast('Undone ✓');
}
$('undoBtn').onclick=doUndo;
const sanitizeTag = (s)=>s.toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,20);
const tidy = (t)=> t.split('\n').map(s=>s.replace(/[ \t]{2,}/g,' ').trim()).join('\n').replace(/\n{3,}/g,'\n\n').trim();

// --- list markers (Apple Notes / markdown paste: "- [ ] task", "• item", "1. item") ---
function stripListMarker(line){
  let checked=false;
  let t=String(line||'').replace(/^\s*(?:[-*+•·●○◦▪▶‣⁃]|\d{1,3}[.)])\s+/,'');
  if(/^\s*\[[xX]\]\s*/.test(t)) checked=true;
  t=t.replace(/^\s*\[[ xX]\]\s*/,'');
  return {text:t, checked};
}

// --- quick parse ---
function parseQuick(text){
  text = stripListMarker(text).text;
  let tags = [];
  let priority = document.getElementById('quickPriority').value || '';
  let due = document.getElementById('quickDue').value || '';
  // #tags
  const tagRe = /#([a-zA-Z0-9_-]+)/g;
  let m; while((m = tagRe.exec(text))) tags.push(m[1].toLowerCase());
  text = text.replace(tagRe,'').trim();
  // !priority
  const priRe = /!(high|med|low|h|m|l)\b/i;
  const pm = text.match(priRe);
  if(pm){
    const v = pm[1].toLowerCase();
    priority = v.startsWith('h')?'high':v.startsWith('m')?'med':'low';
    text = text.replace(priRe,'').trim();
  }
  // due:... accepts today/tomorrow, YYYY-MM-DD, or DD-MM-YYYY / DD/MM/YYYY (stored as ISO)
  const dueRe = /due:([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}[-\/][0-9]{1,2}[-\/][0-9]{2,4}|today|tomorrow|tmr)/i;
  const dm = text.match(dueRe);
  if(dm){
    const v = dm[1].toLowerCase();
    if(v==='today') due = todayStr();
    else if(v==='tomorrow'||v==='tmr'){ const d=new Date(); d.setDate(d.getDate()+1); due=d.toISOString().slice(0,10); }
    else if(/^[0-9]{1,2}[-\/]/.test(v)){
      const p=v.split(/[-\/]/); let dd=+p[0], mm=+p[1], yy=+p[2];
      if(yy<100) yy+=2000;
      if(dd>=1&&dd<=31&&mm>=1&&mm<=12&&yy>=2000&&yy<=2100)
        due = `${yy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
    }
    else due = dm[1];
    text = text.replace(dueRe,'').trim();
  }
  // @board — route to another board, e.g. "@Quick Notes buy milk" (prefix match, longest first)
  let boardId = null;
  const atIdx = text.indexOf('@');
  if(atIdx>=0){
    const rest = text.slice(atIdx+1);
    const sorted=[...state.boards].sort((a,b)=>b.name.length-a.name.length);
    const hit = sorted.find(b=>{
      if(!rest.toLowerCase().startsWith(b.name.toLowerCase())) return false;
      const nx = rest[b.name.length]||' ';
      return /[^a-z0-9]/.test(nx); // word boundary so "@Quickly" doesn't match "Quick"
    }) || sorted.find(b=>{
      // abbrev: "@Quick" matches "Quick Notes"
      const first = b.name.split(' ')[0].toLowerCase();
      if(!rest.toLowerCase().startsWith(first)) return false;
      const nx = rest[first.length]||' ';
      return /[^a-z0-9]/.test(nx);
    });
    if(hit){
      boardId = hit.id;
      const named = sorted.find(b=>b.id===hit.id && rest.toLowerCase().startsWith(b.name.toLowerCase())) ? hit.name.length
        : hit.name.split(' ')[0].length;
      text = tidy(text.slice(0,atIdx)+' '+text.slice(atIdx+1+named));
    }
  }
  text = tidy(text);
  return {title:text, tags:[...new Set(tags)], priority, due, boardId};
}

function activeBoard(){
  return state.boards.find(b=>b.id===state.activeBoardId) || state.boards[0];
}
function boardCards(boardId){
  return state.cards.filter(c=>c.boardId===boardId);
}

// --- render ---
const $ = (id)=>document.getElementById(id);
const boardEl = $('board'), tabsEl = $('boardTabs');

function render(){
  renderTabs(); renderBoard(); renderTagFilter(); updateCredsBanner(); renderStats(); refreshQaMeta(); refreshSearchMeta(); refreshUndoBtn(); renderSelBar();
}
// --- search result count + cross-board hint ---
function refreshSearchMeta(){
  const el=$('searchMeta'); if(!el) return;
  const f=currentFilters();
  if(!f.q&&!f.tag&&!f.pri&&!f.due){ el.textContent=''; el.onclick=null; el.classList.remove('link'); return; }
  const match=(c)=>cardMatches(c,f);
  if(state.activeBoardId==='__all'){
    const n=state.cards.filter(match).length;
    el.textContent=`${n} match${n===1?'':'es'}`; el.onclick=null; el.classList.remove('link');
  } else {
    const b=activeBoard();
    const here=state.cards.filter(c=>c.boardId===b?.id&&match(c)).length;
    const away=state.cards.filter(c=>c.boardId!==b?.id&&match(c)).length;
    el.textContent = away?`${here} here · ${away} elsewhere — view`:`${here} match${here===1?'':'es'}`;
    el.onclick = away?()=>{ state.activeBoardId='__all'; save(true); render(); }:null;
    el.classList.toggle('link',!!away);
  }
}
// --- multi-select (bulk delete) ---
let selectMode=false; const selected=new Set();
function setSelectMode(on){
  selectMode=on; selected.clear();
  document.body.classList.toggle('selecting',on);
  $('selectBtn').classList.toggle('on',on);
  renderSelBar(); render();
}
function renderSelBar(){
  const bar=$('selBar'); if(!bar) return;
  bar.classList.toggle('hidden',!selectMode);
  $('selCount').textContent=`${selected.size} selected`;
  $('selDelBtn').disabled=!selected.size;
}
$('selectBtn').onclick=()=>setSelectMode(!selectMode);
$('selAllBtn').onclick=()=>{
  document.querySelectorAll('#board .card').forEach(el=>{ if(el.dataset.cardId) selected.add(el.dataset.cardId); });
  renderSelBar(); render();
};
$('selNoneBtn').onclick=()=>{ selected.clear(); renderSelBar(); render(); };
$('selDelBtn').onclick=()=>{
  if(!selected.size) return;
  if(!confirm(`Delete ${selected.size} card${selected.size>1?'s':''}? (Undo available)`)) return;
  state.cards=state.cards.filter(c=>!selected.has(c.id));
  selected.clear(); setSelectMode(false); save(); render();
  toast('Deleted ✓ — Undo available');
};
$('selDoneBtn').onclick=()=>setSelectMode(false);
function boardProgress(b){
  const all=boardCards(b.id); if(!all.length) return 0;
  const last=b.columns[b.columns.length-1]?.id;
  return Math.round(100*all.filter(c=>c.colId===last).length/all.length);
}
function tabFill(p, active, doneAll){
  if(doneAll) return active
    ? `background:linear-gradient(90deg,#16a34a ${p}%,#065f46 ${p}%);color:#fff;border-color:#065f46;`
    : `background:linear-gradient(90deg,rgba(22,163,74,.45) ${p}%,#f0fdf4 ${p}%);border-color:#86efac;`;
  return active
    ? `background:linear-gradient(90deg,rgba(255,184,28,.6) ${p}%,var(--united) ${p}%);`
    : `background:linear-gradient(90deg,rgba(218,41,28,.20) ${p}%,#f8fafc ${p}%);`;
}
function renderTabs(){
  tabsEl.innerHTML='';
  const isAll=state.activeBoardId==='__all';
  const allCount=state.cards.length;
  const allP=state.cards.length?Math.round(100*state.cards.filter(c=>{const b=state.boards.find(x=>x.id===c.boardId);return b&&b.columns.length&&b.columns[b.columns.length-1].id===c.colId;}).length/state.cards.length):0;
  const allBtn=document.createElement('div');
  allBtn.className='board-tab'+(isAll?' active':'');
  allBtn.style.cssText=tabFill(allP,isAll,allCount>0&&allP>=100);
  allBtn.title=`All boards — ${allP}% in Done`;
  allBtn.innerHTML=`<span>All</span> <span class="cnt" style="opacity:.6;font-weight:400">(${allCount})</span>`;
  allBtn.onclick=()=>{ state.activeBoardId='__all'; save(true); render(); };
  tabsEl.appendChild(allBtn);
  state.boards.forEach(b=>{
    const n = boardCards(b.id).length;
    const p = boardProgress(b);
    const btn = document.createElement('div');
    btn.className = 'board-tab' + (b.id===state.activeBoardId?' active':'');
    btn.style.cssText = tabFill(p, b.id===state.activeBoardId, n>0&&p>=100);
    btn.innerHTML = `<span></span> <span class="cnt" style="opacity:.6;font-weight:400">(${n})</span>`;
    btn.firstChild.textContent = b.name;
    btn.title = `${b.name} — ${p}% in Done (double-click or ✏️ to rename)`;
    btn.onclick = ()=>{ state.activeBoardId=b.id; save(true); render(); };
    btn.ondblclick = ()=>{
      const nn = prompt('Rename board:', b.name);
      if(nn && nn.trim()){ b.name = nn.trim().slice(0,40); save(); render(); }
    };
    // explicit rename (dblclick alone can't work: first click re-renders tabs, so the 2nd click never completes one)
    const pen = document.createElement('span');
    pen.className='rn'; pen.textContent='✏️'; pen.title='Rename board';
    pen.onclick=(e)=>{ e.stopPropagation(); const nn=prompt('Rename board:',b.name); if(nn&&nn.trim()){ b.name=nn.trim().slice(0,40); save(); render(); } };
    btn.appendChild(pen);
    if(state.boards.length>1){
      const x = document.createElement('span');
      x.className='x'; x.textContent='×'; x.title='Delete board';
      x.onclick=(e)=>{ e.stopPropagation(); if(state.boards.length<=1){ alert('Keep at least 1 board.'); return; } if(confirm(`Delete board "${b.name}" + its cards?`)){ state.boards = state.boards.filter(z=>z.id!==b.id); state.cards = state.cards.filter(c=>c.boardId!==b.id); state.activeBoardId = state.boards[0]?.id; save(); render(); } };
      btn.appendChild(x);
    }
    tabsEl.appendChild(btn);
  });
}
function currentFilters(){
  return { q: $('searchInput').value.trim().toLowerCase(), tag: $('filterTag').value, pri: $('filterPriority').value, due: $('filterDue').value };
}
function cardMatches(c, f){
  if(f.tag && !c.tags.includes(f.tag)) return false;
  if(f.pri && c.priority!==f.pri) return false;
  if(f.due==='overdue' && !(c.due && isOverdue(c.due))) return false;
  if(f.due==='today' && c.due!==todayStr()) return false;
  if(f.due==='nodate' && c.due) return false;
  if(f.due==='week'){ if(!c.due) return false; const week = new Date(); week.setDate(week.getDate()+7); if(c.due < todayStr() || c.due > week.toISOString().slice(0,10)) return false; }
  if(f.q){ const hay = (c.title+' '+c.details+' '+c.tags.join(' ')).toLowerCase(); if(!hay.includes(f.q)) return false; }
  return true;
}
/* ——— All board: virtual aggregate across real boards ——— */
function unionColNames(){
  const order=[];
  state.boards.forEach(b=>b.columns.forEach(c=>{ if(!order.includes(c.name)) order.push(c.name); }));
  return order.length?order:['Inbox'];
}
function realColFor(boardId, colName){
  const b=state.boards.find(x=>x.id===boardId); if(!b) return null;
  return b.columns.find(c=>c.name===colName)||b.columns[0]||null;
}
function renderAllBoard(){
  const f=currentFilters();
  boardEl.innerHTML='';
  unionColNames().forEach(name=>{
    const colDiv=document.createElement('div');
    colDiv.className='col'; colDiv.dataset.colName=name;
    const cards=state.cards.filter(c=>{
      const rc=realColFor(c.boardId,name); if(!rc||c.colId!==rc.id) return false;
      return cardMatches(c,f);
    }).sort((a,c2)=>(a.due||'9999')<(c2.due||'9999')?-1:1);
    colDiv.innerHTML=`<div class="col-header"><span class="col-name"></span><span class="col-count">${cards.length}</span></div><div class="cards"></div>`;
    colDiv.querySelector('.col-name').textContent=name;
    colDiv.ondragover=(e)=>{e.preventDefault();colDiv.classList.add('drag-over');};
    colDiv.ondragleave=()=>colDiv.classList.remove('drag-over');
    colDiv.ondrop=(e)=>{
      e.preventDefault();colDiv.classList.remove('drag-over');
      const id=e.dataTransfer.getData('text/card-id');if(!id)return;
      const card=state.cards.find(c=>c.id===id);if(!card)return;
      const rc=realColFor(card.boardId,name);if(rc){card.colId=rc.id;save();render();}
    };
    const list=colDiv.querySelector('.cards');
    cards.forEach(c=>{
      const rb=state.boards.find(x=>x.id===c.boardId);
      if(rb) list.appendChild(cardNode(c,rb,0));
    });
    boardEl.appendChild(colDiv);
  });
}
function renderBoard(){
  if(state.activeBoardId==='__all'){ renderAllBoard(); return; }
  const b = activeBoard();
  if(!b){ boardEl.innerHTML='<p class="muted">No boards. Create one.</p>'; return; }
  const f = currentFilters();
  boardEl.innerHTML='';
  b.columns.forEach((col, idx)=>{
    const colDiv = document.createElement('div');
    colDiv.className='col'; colDiv.dataset.colId=col.id;
    const cards = state.cards.filter(c=>c.boardId===b.id && c.colId===col.id && cardMatches(c,f))
      .sort((a,c2)=>(a.due||'9999')<(c2.due||'9999')?-1:1);
    colDiv.innerHTML = `<div class="col-header"><span class="col-name"></span><span class="col-count">${cards.length}</span>
      <span class="col-actions"><button class="mini" data-act="rename" title="Rename this column">✏️</button><button class="mini del" data-act="del" title="Delete this entire COLUMN (cards move to first column)">Column 🗑️</button></span></div>
      <div class="cards"></div><button class="add-inline">+ Add card</button>`;
    colDiv.querySelector('.col-name').textContent = col.name;
    colDiv.querySelector('[data-act="rename"]').onclick=()=>{
      const nn=prompt('Rename column:',col.name); if(nn&&nn.trim()){col.name=nn.trim().slice(0,30);save();render();}
    };
    colDiv.querySelector('[data-act="del"]').onclick=()=>{
      if(b.columns.length<=1){alert('Keep at least 1 column');return;}
      if(!confirm(`Delete column "${col.name}"? Cards move to first column.`))return;
      const first=b.columns[0].id;
      state.cards.forEach(c=>{if(c.boardId===b.id&&c.colId===col.id)c.colId=first;});
      b.columns=b.columns.filter(x=>x.id!==col.id); save(); render();
    };
    colDiv.querySelector('.add-inline').onclick=()=>{
      const t=prompt(`New card in ${b.name} → ${col.name}:`); if(!t||!t.trim())return;
      const p=parseQuick(t.trim());
      state.cards.unshift({id:uid(),boardId:b.id,colId:col.id,title:p.title||t,details:'',tags:p.tags,priority:p.priority,due:p.due,createdAt:Date.now()});
      $('quickDue').value=''; save(); render();
    };
    // drag over
    colDiv.ondragover=(e)=>{e.preventDefault();colDiv.classList.add('drag-over');};
    colDiv.ondragleave=()=>colDiv.classList.remove('drag-over');
    colDiv.ondrop=(e)=>{e.preventDefault();colDiv.classList.remove('drag-over');const id=e.dataTransfer.getData('text/card-id');if(!id)return;const card=state.cards.find(c=>c.id===id);if(card){card.colId=col.id;save();render();}};
    const list = colDiv.querySelector('.cards');
    cards.forEach(c=>list.appendChild(cardNode(c, b, idx)));
    boardEl.appendChild(colDiv);
  });
  // add column tile
  const addCol = document.createElement('div');
  addCol.className='col'; addCol.style.justifyContent='center'; addCol.style.alignItems='center'; addCol.style.cursor='pointer';
  addCol.innerHTML='<div style="padding:20px;color:#64748b;font-weight:700">+ Add column</div>';
  addCol.onclick=()=>{const n=prompt('Column name:','New');if(n&&n.trim()){b.columns.push({id:uid(),name:n.trim().slice(0,30)});save();render();}};
  boardEl.appendChild(addCol);
}
function fmtDate(iso){ const m=/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(iso||''); return m?`${m[3]}-${m[2]}-${m[1]}`:(iso||''); }
function dueChip(c){
  if(!c.due) return '';
  let cls='chip', label='📅 '+fmtDate(c.due);
  if(isOverdue(c.due)){cls+=' due-over';label='⚠️ '+fmtDate(c.due);}
  else if(isToday(c.due)){cls+=' due-today';label='⏰ today';}
  return `<span class="${cls}">${label}</span>`;
}
function cardNode(c, board, colIdx){
  const d=document.createElement('div');
  d.className='card'; d.draggable=true; d.dataset.cardId=c.id;
  const pri = c.priority?`<span class="chip pri-${c.priority}">${c.priority==='high'?'🔴 high':c.priority==='med'?'🟡 med':'🟢 low'}</span>`:'';
  const isDone = board.columns.length>0 && board.columns[board.columns.length-1].id===c.colId;
  const inAll = state.activeBoardId==='__all';
  d.innerHTML=`<div class="card-title"></div>${c.details?'<div class="card-details"></div>':''}
    <div class="chips">${inAll?`<span class="chip board-chip"></span>`:''}${c.tags.map(t=>`<span class="chip tag-chip" data-tag="${t}" title="Filter by #${t}">#${t}</span>`).join('')}${pri}${dueChip(c)}</div>
    <div class="card-foot"><button class="mini" data-a="edit">Edit</button><button class="mini" data-a="left" title="Move card left">←</button><button class="mini" data-a="right" title="Move card right">→</button><button class="mini${isDone?' done-on':''}" data-a="done" title="${isDone?'Done ✓':'Send card to Done'}">✓</button><button class="mini del" data-a="delcard" title="Delete this card">🗑️</button></div>`;
  if(inAll) d.querySelector('.board-chip').textContent='📋 '+board.name;
  d.querySelectorAll('.tag-chip').forEach(el=>{
    if($('filterTag').value===el.dataset.tag) el.classList.add('on');
    el.onclick=(e)=>{ e.stopPropagation(); const ft=$('filterTag'); ft.value=(ft.value===el.dataset.tag)?'':el.dataset.tag; renderBoard(); };
  });
  d.querySelector('.card-title').textContent=c.title;
  if(c.details) d.querySelector('.card-details').textContent=c.details;
  if(selectMode&&selected.has(c.id)) d.classList.add('selected');
  // escape tag chips already safe (tags sanitized lowercase alnum)
  d.ondragstart=(e)=>{e.dataTransfer.setData('text/card-id',c.id);d.classList.add('dragging');};
  d.ondragend=()=>d.classList.remove('dragging');
  d.querySelector('[data-a="edit"]').onclick=(e)=>{e.stopPropagation();openCardModal(c.id);};
  d.onclick=()=>{
    if(selectMode){ selected.has(c.id)?selected.delete(c.id):selected.add(c.id); d.classList.toggle('selected',selected.has(c.id)); renderSelBar(); }
    else openCardModal(c.id);
  };
  d.querySelector('[data-a="left"]').onclick=(e)=>{e.stopPropagation();moveCard(c,-1);};
  d.querySelector('[data-a="right"]').onclick=(e)=>{e.stopPropagation();moveCard(c,1);};
  d.querySelector('[data-a="done"]').onclick=(e)=>{e.stopPropagation();const cols=board.columns;const last=cols[cols.length-1];c.colId=last.id;save();render();};
  d.querySelector('[data-a="delcard"]').onclick=(e)=>{e.stopPropagation();if(!confirm(`Delete card "${c.title}"?`))return;state.cards=state.cards.filter(x=>x.id!==c.id);save();render();};
  return d;
}
function moveCard(c, dir){
  const b=state.boards.find(x=>x.id===c.boardId); if(!b)return;
  const i=b.columns.findIndex(x=>x.id===c.colId);
  const j=i+dir; if(j<0||j>=b.columns.length)return;
  c.colId=b.columns[j].id; save(); render();
}
function renderTagFilter(){
  const sel=$('filterTag'); const cur=sel.value;
  const all=new Set(); state.cards.forEach(c=>c.tags.forEach(t=>all.add(t)));
  sel.innerHTML='<option value="">All tags</option>'+[...all].sort().map(t=>`<option value="${t}">#${t}</option>`).join('');
  if(all.has(cur)) sel.value=cur;
}
function renderStats(){
  if(state.activeBoardId==='__all'){
    const over=state.cards.filter(c=>c.due&&isOverdue(c.due)).length;
    $('statsLine').textContent=`All boards: ${state.cards.length} cards • ${over} overdue • ${state.boards.length} boards`;
    return;
  }
  const b=activeBoard(); if(!b)return;
  const all=boardCards(b.id); const over=all.filter(c=>c.due&&isOverdue(c.due)).length;
  $('statsLine').textContent=`${b.name}: ${all.length} cards • ${over} overdue • ${state.boards.length} boards`;
}
function updateCredsBanner(){
  if(state.activeBoardId==='__all'){ $('credsBanner').classList.add('hidden'); return; }
  const b=activeBoard();
  const dismissed = localStorage.getItem(CREDS_DISMISS)==='1';
  $('credsBanner').classList.toggle('hidden', !(b && b.name.toLowerCase().includes('credential') && !dismissed));
}

// --- quick add ---
/* ——— auto-backups: last 5 snapshots on this device ——— */
const SNAP_KEY='quickboard.snaps.v1';
function getSnaps(){ try{ return JSON.parse(localStorage.getItem(SNAP_KEY)||'[]'); }catch{ return []; } }
function takeSnapshot(reason){
  try{
    const snaps=getSnaps();
    snaps.unshift({ts:Date.now(), reason, boards:state.boards.length, cards:state.cards.length, state});
    localStorage.setItem(SNAP_KEY, JSON.stringify(snaps.slice(0,5)));
  }catch{}
  renderBackups();
}
function fmtSnap(ts){ try{ return new Date(ts).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});}catch{ return ''; } }
function renderBackups(){
  const el=$('backupList'); if(!el) return;
  const snaps=getSnaps();
  el.innerHTML = snaps.length ? '' : '<span class="muted">No backups yet — one is saved daily.</span>';
  snaps.forEach((s,i)=>{
    const row=document.createElement('div'); row.className='backup-row';
    row.innerHTML=`<span></span><span class="muted"></span><span class="spacer" style="flex:1"></span>`;
    row.children[0].textContent=`${fmtSnap(s.ts)} — ${s.boards} boards, ${s.cards} cards`;
    row.children[1].textContent=`(${s.reason})`;
    const btn=document.createElement('button'); btn.className='btn small'; btn.textContent='Restore';
    btn.onclick=()=>{
      takeSnapshot('pre-restore');
      state=s.state; state.activeBoardId=state.activeBoardId||state.boards[0]?.id;
      healState(); save(); render(); renderBackups();
      alert('Backup restored ✓ (previous state saved as newest backup)');
    };
    row.appendChild(btn); el.appendChild(row);
  });
}
/* ——— prominent danger confirm (type-to-confirm) ——— */
let dangerAction=null;
function askDanger(o){
  dangerAction=o.action;
  $('dangerTitle').textContent=o.title; $('dangerDesc').textContent=o.desc;
  $('dangerWord').textContent=o.word; $('dangerGo').textContent=o.goLabel;
  $('dangerInput').value=''; $('dangerGo').disabled=true;
  $('dangerModal').classList.remove('hidden');
  setTimeout(()=>$('dangerInput').focus(),80);
}
$('dangerInput').addEventListener('input',(e)=>{ $('dangerGo').disabled = e.target.value.trim().toUpperCase()!==$('dangerWord').textContent; });
$('dangerCancel').onclick=()=>$('dangerModal').classList.add('hidden');
$('dangerGo').onclick=()=>{ $('dangerModal').classList.add('hidden'); if(dangerAction){ const a=dangerAction; dangerAction=null; a(); } };
/* ——— United ribbon collapse (crest-only until tapped) ——— */
function toggleUtd(force){
  const bar=$('unitedBar'); if(!bar) return;
  const open = force!==undefined?force:bar.classList.contains('collapsed');
  bar.classList.toggle('collapsed', !open);
  try{ localStorage.setItem('qb.united.open', open?'1':'0'); }catch{}
}
(function initUtdCollapsed(){
  try{ if(localStorage.getItem('qb.united.open')!=='1'){ const b=$('unitedBar'); if(b) b.classList.add('collapsed'); } }catch{}
})();
/* ——— meeting-intel: parse invites pasted into Details ——— */
const MON={january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
function detectMeeting(text){
  const t=text||'';
  const isMeeting=/google meet|zoom\b|teams|webex|video call|joining info|time zone|timezone|meeting|demonstration|\bdemo\b|invite|agenda/i.test(t);
  const hasTime=/\d{1,2}:\d{2}/.test(t);
  let dd=0,mm=0,yy=0,yrGiven=false;
  let m=t.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})/i)
       ||t.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)/i);
  if(m){
    if(/[a-z]/i.test(m[1][0])){ mm=MON[m[1].toLowerCase()]; dd=+m[2]; }
    else { dd=+m[1]; mm=MON[m[2].toLowerCase()]; }
  } else if((m=t.match(/(\d{1,2})[-\/](\d{1,2})(?:[-\/](\d{2,4}))?/))){
    dd=+m[1]; mm=+m[2]; if(m[3]){ yy=+m[3]; if(yy<100) yy+=2000; yrGiven=true; }
  }
  let due='';
  if(dd>=1&&dd<=31&&mm>=1&&mm<=12){
    const cur=new Date().getFullYear();
    yy=yy||cur;
    let iso=`${yy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
    if(iso<todayStr()&&!yrGiven){ yy=cur+1; iso=`${yy}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`; }
    due=iso;
  }
  return {isMeeting, hasTime, due};
}
let mDetectT=null;
function autoDetectModal(){
  // non-destructive: fills Due only if empty, High only from None/Med defaults, tags only appended
  const r=detectMeeting($('mDetails').value);
  if(r.due && !$('mDue').value) $('mDue').value=r.due;
  if(r.hasTime && ($('mPriority').value===''||$('mPriority').value==='med')) $('mPriority').value='high';
  if(r.isMeeting){
    const cur=$('mTags').value.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    if(!cur.includes('meetings')){ $('mTags').value=[...cur,'meetings'].join(', '); addPreset('meetings'); }
  }
  renderMPresets();
}
$('mDetails').addEventListener('input',()=>{ clearTimeout(mDetectT); mDetectT=setTimeout(autoDetectModal,700); });
$('mAutofill').onclick=()=>{
  const r=detectMeeting($('mDetails').value);
  if(!r.due&&!r.isMeeting){ alert('No date or meeting found in the details.'); return; }
  if(r.due) $('mDue').value=r.due;
  if(r.hasTime) $('mPriority').value='high';
  if(r.isMeeting){
    const cur=$('mTags').value.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    if(!cur.includes('meetings')) cur.push('meetings');
    $('mTags').value=cur.join(', ');
    addPreset('meetings'); renderMPresets();
  }
  alert(`Detected: ${r.due?('due '+fmtDate(r.due)):'no date'}${r.hasTime?' · has time → High':''}${r.isMeeting?' · #meetings':''}`);
};
/* ——— managed tag vocabulary ——— */
const PRESET_KEY='quickboard.tagpresets';
const DEFAULT_PRESETS=['meetings','work','home','urgent','idea','errand','onboarding','manutd','matchday','football'];
function getPresets(){ try{ const p=JSON.parse(localStorage.getItem(PRESET_KEY)||'null'); if(Array.isArray(p)&&p.length) return p; }catch{} return [...DEFAULT_PRESETS]; }
function setPresets(p){ try{ localStorage.setItem(PRESET_KEY, JSON.stringify(p)); }catch{} }
function addPreset(t){ t=sanitizeTag(t); if(!t) return; const p=getPresets(); if(!p.includes(t)){ p.push(t); setPresets(p); } }
function renderMPresets(){
  const w=$('mPresetChips'); if(!w) return;
  const cur=$('mTags').value.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
  w.innerHTML='';
  getPresets().forEach(t=>{
    const el=document.createElement('span');
    el.className='smart-tag'+(cur.includes(t)?' on':''); el.textContent='#'+t;
    el.title='Tap to toggle';
    el.onclick=()=>{
      let c=$('mTags').value.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
      c=c.includes(t)?c.filter(x=>x!==t):[...c,t];
      $('mTags').value=c.join(', '); renderMPresets();
    };
    w.appendChild(el);
  });
  const add=document.createElement('span'); add.className='smart-tag add'; add.textContent='＋'; add.title='Add new preset tag';
  add.onclick=()=>{ const v=prompt('New preset tag:'); if(v&&v.trim()){ addPreset(v.trim()); renderMPresets(); renderPresetsMgr(); } };
  w.appendChild(add);
}
function renderPresetsMgr(){
  const el=$('presetList'); if(!el) return;
  el.innerHTML='';
  getPresets().forEach(t=>{
    const row=document.createElement('div'); row.className='backup-row';
    row.innerHTML=`<span></span><span style="flex:1"></span>`;
    row.children[0].textContent='#'+t;
    const del=document.createElement('button'); del.className='btn small danger'; del.textContent='×';
    del.onclick=()=>{ setPresets(getPresets().filter(x=>x!==t)); renderPresetsMgr(); };
    row.appendChild(del); el.appendChild(row);
  });
  const row=document.createElement('div'); row.className='backup-row';
  const inp=document.createElement('input'); inp.placeholder='new tag'; inp.style.cssText='flex:1;border:1px solid var(--line);border-radius:8px;padding:6px 10px';
  const btn=document.createElement('button'); btn.className='btn small primary'; btn.textContent='Add';
  btn.onclick=()=>{ if(inp.value.trim()){ addPreset(inp.value.trim()); inp.value=''; renderPresetsMgr(); } };
  row.appendChild(inp); row.appendChild(btn); el.appendChild(row);
}
const qaSugEl=document.createElement('div'); qaSugEl.id='qaSuggest'; qaSugEl.className='qa-suggest hidden';
document.querySelector('.quickadd').appendChild(qaSugEl);
let qaSugIdx=0, qaSugList=[];
function qaBoardMatches(){
  const inp=$('quickInput'); const pos=(inp.selectionStart??inp.value.length);
  const m=/@([A-Za-z0-9 _-]*)$/.exec(inp.value.slice(0,pos));
  if(!m) return null;
  const q=m[1].toLowerCase();
  const list=state.boards.filter(b=>b.name.toLowerCase().includes(q)).slice(0,6);
  return {q, list, start:pos-m[1].length-1};
}
function renderQaSug(){
  const r=qaBoardMatches();
  if(!r||!r.list.length){qaSugEl.classList.add('hidden');qaSugList=[];return;}
  qaSugList=r.list; qaSugIdx=Math.min(qaSugIdx,qaSugList.length-1);
  qaSugEl.innerHTML=qaSugList.map((b,i)=>`<button class="qa-sug${i===qaSugIdx?' sel':''}" data-i="${i}"><b>@${b.name}</b><span>${boardCards(b.id).length} cards</span></button>`).join('');
  qaSugEl.querySelectorAll('.qa-sug').forEach(btn=>{
    btn.onmousedown=(e)=>{e.preventDefault();acceptQaSug(+btn.dataset.i);};
  });
  qaSugEl.classList.remove('hidden');
}
function acceptQaSug(i){
  const r=qaBoardMatches(); if(!r||!qaSugList[i])return;
  const inp=$('quickInput'); const pos=(inp.selectionStart??inp.value.length);
  const name=qaSugList[i].name;
  inp.value=inp.value.slice(0,r.start)+'@'+name+' '+inp.value.slice(pos);
  const np=r.start+name.length+2;
  inp.focus(); try{inp.setSelectionRange(np,np);}catch{}
  qaSugEl.classList.add('hidden');
}
$('quickInput').addEventListener('input',()=>{qaSugIdx=0;renderQaSug();});
$('quickInput').addEventListener('click',renderQaSug);
$('quickInput').addEventListener('keydown',(e)=>{
  if(qaSugEl.classList.contains('hidden'))return;
  if(e.key==='Enter'){e.preventDefault();e.stopImmediatePropagation();acceptQaSug(qaSugIdx);}
  else if(e.key==='ArrowDown'){e.preventDefault();qaSugIdx=(qaSugIdx+1)%qaSugList.length;renderQaSug();}
  else if(e.key==='ArrowUp'){e.preventDefault();qaSugIdx=(qaSugIdx-1+qaSugList.length)%qaSugList.length;renderQaSug();}
  else if(e.key==='Tab'){e.preventDefault();acceptQaSug(qaSugIdx);}
  else if(e.key==='Escape'){qaSugEl.classList.add('hidden');}
});
/* ——— quick-add upgrades: expand, target label, smart defaults, templates, voice ——— */
const SMART_KEY='quickboard.smart.v1';
function getSmart(){ try{ return JSON.parse(localStorage.getItem(SMART_KEY)||'{}'); }catch{ return {}; } }
function rememberSmart(boardId, tags, priority){
  try{
    const s=getSmart(); const prev=s[boardId]||{tags:[],priority:''};
    const tags3=[...tags.slice(0,3), ...prev.tags].filter((t,i,a)=>t&&a.indexOf(t)===i).slice(0,3);
    s[boardId]={tags:tags3, priority:priority||prev.priority||''};
    localStorage.setItem(SMART_KEY, JSON.stringify(s));
  }catch{}
}
function refreshQaMeta(){
  const b=activeBoard();
  const t=$('qaTarget');
  if(t) t.textContent = b?`→ ${b.name} → ${b.columns[0]?.name||''}` : '';
  const st=$('smartTags'); if(!st) return;
  const s=getSmart()[state.activeBoardId];
  st.innerHTML='';
  (s&&s.tags||[]).forEach(tag=>{
    const el=document.createElement('span'); el.className='smart-tag'; el.textContent='#'+tag; el.title='Tap to add this tag';
    el.onclick=()=>{ const inp=$('quickInput'); inp.value=(inp.value?inp.value.replace(/\s+$/,'')+' ':'')+'#'+tag+' '; inp.focus(); };
    st.appendChild(el);
  });
  if(s&&s.priority) $('quickPriority').value=s.priority;
  const qt=$('quickTag');
  if(qt){
    const cur=qt.value;
    const all=[...new Set([...getPresets(), ...state.cards.flatMap(c=>c.tags||[])])].sort();
    qt.innerHTML='<option value="">#tag</option>'+all.map(t=>`<option value="${t}">#${t}</option>`).join('');
    qt.value=[...qt.options].some(o=>o.value===cur)?cur:'';
    qt.onchange=()=>{
      if(!qt.value) return;
      const inp=$('quickInput'); inp.value=(inp.value?inp.value.replace(/\s+$/,'')+' ':'')+'#'+qt.value+' ';
      qt.value=''; expandQa(); inp.focus();
    };
  }
}
const QA_TPLS=['#errand !high','due:today !high','due:tomorrow','#idea','@Quick Notes #note','#home due:tomorrow'];
(function renderQaTpls(){
  const w=$('qaTemplates'); if(!w) return;
  QA_TPLS.forEach(t=>{
    const el=document.createElement('button'); el.className='qa-tpl'; el.textContent=t;
    el.onclick=()=>{ const inp=$('quickInput'); inp.value=(inp.value?inp.value.replace(/\s+$/,'')+' ':'')+t+' '; expandQa(); inp.focus(); };
    w.appendChild(el);
  });
})();
function expandQa(){ $('quickadd').classList.add('expanded'); }
function maybeCollapseQa(){
  const qa=$('quickadd');
  if(qa.contains(document.activeElement)) return; // focus moved to date/priority/tag/mic — keep open
  if(!$('quickInput').value) qa.classList.remove('expanded');
}
$('quickInput').addEventListener('focus',()=>{ expandQa(); refreshQaMeta(); });
$('quickInput').addEventListener('blur',()=>{ setTimeout(maybeCollapseQa,150); });
/* voice capture — Wispr-style: continuous, persistent, stops only on mic tap */
let recog=null, listening=false, userStopped=false, voiceFinal='', voiceInterim='', voiceTickInt=null, voiceStart=0, voiceRestarts=0, voiceCommitT=null, voiceWatchInt=null, lastVoiceAt=0;
function voiceUI(on){
  $('voiceBtn').classList.toggle('listening', on);
  $('voiceBar').classList.toggle('hidden', !on);
  if(on){ $('voiceLive').textContent='Listening… speak now'; $('voiceTimer').textContent='0:00'; }
}
function voiceTick(){
  const s=Math.floor((Date.now()-voiceStart)/1000);
  $('voiceTimer').textContent=`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
}
/* voice language: EN / Hindi (persisted) */
const VOICE_LANG_KEY='quickboard.voice.lang';
function voiceLang(){ try{ return localStorage.getItem(VOICE_LANG_KEY)||'en-US'; }catch{ return 'en-US'; } }
(function initVoiceLang(){
  const w=$('voiceLang'); if(!w) return;
  const cur=voiceLang();
  w.querySelectorAll('button').forEach(b=>{
    b.classList.toggle('on', b.dataset.l===cur);
    b.onclick=()=>{ try{localStorage.setItem(VOICE_LANG_KEY,b.dataset.l);}catch{} w.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b)); };
  });
})();
$('voiceBtn').onclick=()=>{ listening?finishVoice(false):startVoice(); };
$('voiceCancel').onclick=()=>finishVoice(true);
function startVoice(){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){ alert('Voice input not supported in this browser — try Chrome.'); return; }
  userStopped=false; voiceFinal=''; voiceInterim=''; voiceRestarts=0; listening=true;
  // optimistic UI: bar + timer show instantly on tap, before the engine confirms
  voiceStart=Date.now(); voiceUI(true); clearInterval(voiceTickInt); voiceTickInt=setInterval(voiceTick,500);
  recog=new SR(); recog.lang=voiceLang();
  recog.continuous=true; recog.interimResults=true; // stream partials live; stop ONLY on mic tap
  recog.onstart=()=>{ listening=true; voiceStart=Date.now(); lastVoiceAt=Date.now(); };
  recog.onresult=(e)=>{
    lastVoiceAt=Date.now(); voiceRestarts=0; // progress resets the stall counter
    let interim='';
    for(let i=e.resultIndex;i<e.results.length;i++){
      const t=e.results[i][0].transcript;
      if(e.results[i].isFinal) voiceFinal+=t+' '; else interim+=t;
    }
    voiceInterim=interim;
    $('voiceLive').textContent=(voiceFinal+interim).trim()||'Listening…';
    const vl=$('voiceLive'); vl.scrollLeft=vl.scrollWidth; // track latest words, not the first line
  };
  recog.onerror=(e)=>{
    if(e.error==='not-allowed'||e.error==='service-not-allowed'){
      userStopped=true; listening=false; clearInterval(voiceTickInt); voiceUI(false);
      alert('Mic blocked — allow microphone access, then try again.');
    }
    // other errors (no-speech, network blips): onend auto-restarts below
  };
  recog.onend=()=>{
    if(userStopped) return;
    // resume with a beat — immediate restart often throws InvalidState on mobile
    setTimeout(()=>{
      if(userStopped) return;
      voiceRestarts++;
      try{ recog.start(); }
      catch{ setTimeout(()=>{ if(!userStopped){ try{recog.start();}catch{} } },900); }
    },350);
  };
  // watchdog: if the engine goes quiet >10s while recording, kick it
  clearInterval(voiceWatchInt);
  voiceWatchInt=setInterval(()=>{
    if(!listening||userStopped) return;
    if(Date.now()-lastVoiceAt>10000){ lastVoiceAt=Date.now(); try{recog.stop();}catch{} }
  },4000);
  try{ recog.start(); }catch{ listening=false; clearInterval(voiceTickInt); voiceUI(false); alert('Could not start voice input.'); }
}
function commitVoice(cancelled){
  let txt=voiceFinal.trim()||voiceInterim.trim();
  voiceFinal=''; voiceInterim='';
  if(cancelled||!txt) return;
  const inp=$('quickInput');
  inp.value=(inp.value?inp.value.replace(/\s+$/,'')+' ':'')+txt+' ';
  expandQa(); inp.focus();
}
function finishVoice(cancelled){
  userStopped=true;
  try{ if(recog) recog.stop(); }catch{}
  listening=false; clearInterval(voiceTickInt); clearInterval(voiceWatchInt); voiceUI(false);
  clearTimeout(voiceCommitT);
  // stop() flushes pending finals ~instantly; wait a beat so newest words aren't lost
  voiceCommitT=setTimeout(()=>commitVoice(cancelled), cancelled?0:800);
}
const TITLE_SKIP=/(January|February|March|April|May|June|July|August|September|October|November|December|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\d{1,2}:\d{2}|https?:|time zone|timezone|joining info|video call|meeting link|dial[ -]?in|passcode|organizer|attendees|^when:|^where:)/i;
function pickTitle(lines){
  for(const ln of lines.slice(0,4)){
    const t=ln.trim();
    if(t.length>=4 && !TITLE_SKIP.test(t)) return t.slice(0,120);
  }
  return (lines[0]||'').slice(0,120);
}
function parseFull(raw){
  // one-step capture: first line = title, rest = details; tokens + meeting intel over everything
  const lines=raw.split('\n').map(s=>s.trim()).filter(Boolean);
  const p=parseQuick(lines.join('\n'));
  const plines=p.title.split('\n').map(s=>stripListMarker(s).text.trim()).filter(Boolean);
  const title=pickTitle(plines);
  const ti=plines.indexOf(title);
  const details=(ti>=0?[...plines.slice(0,ti),...plines.slice(ti+1)]:plines).join('\n').slice(0,2000);
  const intel=detectMeeting(p.title);
  let {tags, priority, due, boardId} = p;
  if(intel.due && !due) due=intel.due;
  if(intel.hasTime && (priority===''||priority==='med')) priority='high';
  if(intel.isMeeting){
    if(!boardId){ const mb=state.boards.find(b=>/meeting/i.test(b.name)); if(mb) boardId=mb.id; }
    if(!tags.includes('meetings')) tags=[...tags,'meetings'];
    addPreset('meetings');
  }
  return {title, details, tags, priority, due, boardId, isMeeting:intel.isMeeting};
}
function doQuickAdd(){
  const inp=$('quickInput'); const v=inp.value.trim(); if(!v)return;
  const p=parseFull(v);
  if(!p.title){alert('Type a title');return;}
  const b=(p.boardId && state.boards.find(x=>x.id===p.boardId)) || activeBoard();
  const firstCol=b.columns[0].id;
  state.cards.unshift({id:uid(),boardId:b.id,colId:firstCol,title:p.title,details:p.details,tags:p.tags,priority:p.priority,due:p.due,createdAt:Date.now()});
  inp.value=''; inp.style.height='auto'; $('quickDue').value='';
  rememberSmart(b.id, p.tags, p.priority);
  refreshQaMeta();
  qaSugEl.classList.add('hidden');
  state.activeBoardId=b.id; // jump to the targeted board so you see the card
  save(); render(); inp.focus();
}
$('quickAddBtn').onclick=doQuickAdd;
function autogrowQa(){ const inp=$('quickInput'); inp.style.height='auto'; inp.style.height=Math.min(inp.scrollHeight,132)+'px'; }
$('quickInput').addEventListener('input',()=>{ autogrowQa(); });
$('quickInput').addEventListener('keydown',(e)=>{
  if(e.key!=='Enter'||e.shiftKey) return; // Shift+Enter = newline
  e.preventDefault();
  if(listening){ return; } // mic-tap only stops recording; Enter never interrupts speech
  if(voiceCommitT){ clearTimeout(voiceCommitT); voiceCommitT=null; commitVoice(false); } // flush pending dictation first
  doQuickAdd();
});
document.addEventListener('keydown',(e)=>{
  if(e.key==='n'&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)){e.preventDefault();$('quickInput').focus();}
  if(e.key==='/'&&!/INPUT|TEXTAREA/.test(document.activeElement.tagName)){e.preventDefault();$('searchInput').focus();}
  if(e.key==='Escape'){
    if(selectMode){ setSelectMode(false); return; }
    document.querySelectorAll('.modal').forEach(m=>m.classList.add('hidden'));
  }
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)){ e.preventDefault(); doUndo(); }
});
['searchInput','filterTag','filterPriority','filterDue'].forEach(id=>$(id).addEventListener('input',()=>renderBoard()));

// --- boards ---
$('addBoardBtn').onclick=()=>{
  const n=prompt('New board name:','New Board'); if(!n||!n.trim())return;
  const cols=[{id:uid(),name:'Inbox'},{id:uid(),name:'Today'},{id:uid(),name:'Doing'},{id:uid(),name:'Done'}];
  const nb={id:uid(),name:n.trim().slice(0,40),columns:cols};
  state.boards.push(nb); state.activeBoardId=nb.id; save(); render();
};

// --- card modal ---
let editingId=null;
function openCardModal(id){
  const c=state.cards.find(x=>x.id===id); if(!c)return;
  editingId=id; const b=state.boards.find(x=>x.id===c.boardId);
  $('modalTitle').textContent=`Edit — ${b?.name||''}`;
  $('mTitle').value=c.title; $('mDetails').value=c.details||'';
  $('mTags').value=(c.tags||[]).join(', '); $('mDue').value=c.due||''; $('mPriority').value=c.priority||'';
  $('mColumn').innerHTML=(b?.columns||[]).map(col=>`<option value="${col.id}">${col.name}</option>`).join('');
  $('mColumn').value=c.colId;
  renderMPresets();
  autoDetectModal();
  $('cardModal').classList.remove('hidden');
}
$('mCancel').onclick=()=>$('cardModal').classList.add('hidden');
$('mSave').onclick=()=>{
  const c=state.cards.find(x=>x.id===editingId); if(!c)return;
  c.title=$('mTitle').value.trim()||c.title; c.details=$('mDetails').value;
  c.tags=$('mTags').value.split(',').map(s=>sanitizeTag(s.trim().replace(/^#/,''))).filter(Boolean);
  c.due=$('mDue').value; c.priority=$('mPriority').value; c.colId=$('mColumn').value;
  $('cardModal').classList.add('hidden'); save(); render();
};
$('mDelete').onclick=()=>{
  if(!confirm('Delete this card?'))return;
  state.cards=state.cards.filter(x=>x.id!==editingId);
  $('cardModal').classList.add('hidden'); save(); render();
};

// --- import / export ---
$('importBtn').onclick=()=>{
  $('importBoard').innerHTML=state.boards.map(b=>`<option value="${b.id}">${b.name}</option>`).join('');
  $('importBoard').value=(state.activeBoardId==='__all'?(state.boards[0]&&state.boards[0].id):state.activeBoardId);
  $('importSingle').checked=importSingle();
  $('importModal').classList.remove('hidden');
  refreshImportCount();
};
$('importText').addEventListener('input',refreshImportCount);
$('importSingle').addEventListener('change',()=>{ try{localStorage.setItem(IMPORT_SINGLE_KEY,$('importSingle').checked?'1':'0');}catch{} refreshImportCount(); });
$('importCancel').onclick=()=>$('importModal').classList.add('hidden');
$('pasteClipBtn').onclick=async ()=>{
  try{
    const t=await navigator.clipboard.readText();
    if(!t){ alert('Clipboard is empty — copy your Apple Notes first.'); return; }
    const ta=$('importText');
    ta.value=(ta.value?ta.value.replace(/\s+$/,'')+'\n':'')+t;
    ta.focus();
  }catch{ alert('Clipboard blocked — allow access or paste manually with ⌘V / long-press.'); }
};
// --- toast (non-blocking confirm; Escape-safe, unlike alert) ---
function toast(msg){
  let t=$('toast');
  if(!t){ t=document.createElement('div'); t.id='toast'; t.className='toast'; document.body.appendChild(t); }
  t.textContent=msg; t.classList.add('show');
  clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('show'),2800);
}
const IMPORT_SINGLE_KEY='quickboard.importSingle';
function importSingle(){ try{ return localStorage.getItem(IMPORT_SINGLE_KEY)==='1'; }catch{ return false; } }
function importLineCount(){ return $('importText').value.split('\n').map(s=>s.trim()).filter(Boolean).length; }
function refreshImportCount(){
  const el=$('importCount'); if(!el) return;
  const n=importLineCount(), single=$('importSingle').checked;
  el.textContent = !n ? 'paste something first'
    : single ? 'whole note → 1 card (first line = title, rest = details)'
    : `${n} line${n>1?'s':''} → ${n} card${n>1?'s':''}`;
}
$('importGo').onclick=()=>{
  const boardId=$('importBoard').value; const b=state.boards.find(x=>x.id===boardId); if(!b)return;
  const inbox=b.columns[0].id, doneCol=b.columns[b.columns.length-1].id;
  const single=$('importSingle').checked;
  if(single){
    const raw=$('importText').value.trim();
    if(!raw){ toast('Paste some lines first'); return; }
    const p=parseFull(raw);
    if(!p.title){ toast('Could not find a title line'); return; }
    if(!confirm(`Import 1 card "${p.title.slice(0,60)}" to ${b.name} → ${b.columns[0].name}?`)) return; // Escape cancels BEFORE anything is created
    state.cards.unshift({id:uid(),boardId,colId:inbox,title:p.title.slice(0,200),details:p.details,tags:p.tags,priority:p.priority,due:p.due,createdAt:Date.now()});
    $('importText').value=''; $('importModal').classList.add('hidden');
    state.activeBoardId=boardId; save(); render();
    toast(`Imported 1 card to ${b.name} ✓`);
    return;
  }
  const lines=$('importText').value.split('\n').map(s=>s.trim()).filter(Boolean);
  if(!lines.length){ toast('Paste some lines first'); return; }
  if(!confirm(`Import ${lines.length} card${lines.length>1?'s':''} to ${b.name} → ${b.columns[0].name}?`)) return; // Escape cancels BEFORE anything is created
  lines.forEach(line=>{
    const mk=stripListMarker(line);
    const p=parseQuick(mk.text);
    // checked "- [x]" items land straight in Done
    state.cards.unshift({id:uid(),boardId,colId:mk.checked?doneCol:inbox,title:p.title.slice(0,200),details:'',tags:p.tags,priority:p.priority,due:p.due,createdAt:Date.now()});
  });
  $('importText').value=''; $('importModal').classList.add('hidden');
  state.activeBoardId=boardId; save(); render();
  toast(`Imported ${lines.length} cards to ${b.name} ✓`);
};
$('importFile').addEventListener('change',(e)=>{
  const f=e.target.files[0]; if(!f)return;
  const r=new FileReader();
  r.onload=()=>{
    try{
      const j=JSON.parse(r.result);
      if(j.boards&&j.cards){ takeSnapshot('pre-import'); if(!confirm('Replace ALL data with this backup? (current state auto-saved first)'))return; state=j; if(!state.activeBoardId)state.activeBoardId=state.boards[0].id; save(); render(); }
      else alert('Not a QuickBoard JSON backup');
    }catch{ // treat as text lines
      $('importText').value=r.result.slice(0,20000);
    }
  };
  r.readAsText(f);
});
$('exportBtn').onclick=()=>{
  const blob=new Blob([JSON.stringify(state,null,2)],{type:'application/json'});
  const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
  a.download=`quickboard-backup-${todayStr()}.json`; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
};
$('syncNowBtn').onclick=()=>{ initCloud(); pullFromCloud(false); };
$('forcePullBtn').onclick=()=>{
  const eff = getEffectiveCfg();
  if(!eff.cfg||!window._qbDb){ alert('Sync not connected yet.'); return; }
  askDanger({
    title:'⬇️ Replace with cloud copy?',
    desc:'This overwrites everything on THIS device with the cloud version. Your current state is auto-saved as a backup first, so you can undo.',
    word:'RESTORE', goLabel:'Replace from cloud',
    action:()=>{
      window._qbDb.collection('quickboards').doc(eff.key).get().then((doc)=>{
        if(!doc.exists){ alert('No cloud copy yet.'); return; }
        const remote=doc.data().state;
        if(!remote||!remote.boards||!remote.boards.length){ alert('Cloud copy is empty — nothing to restore.'); return; }
        takeSnapshot('pre-restore');
        state=remote; state.activeBoardId=state.activeBoardId||state.boards[0]?.id;
        healState(); save(true); render();
        alert(`Restored ${state.boards.length} boards, ${state.cards.length} cards ✓`);
      }).catch(()=>alert('Restore failed — check connection.'));
    }
  });
};

// --- settings / sync ---
$('settingsBtn').onclick=()=>{
  const eff = getEffectiveCfg();
  $('firebaseConfig').value = localStorage.getItem(FB_CFG_KEY) || (eff.fromFile ? JSON.stringify(eff.cfg, null, 2) : '');
  $('settingsModal').classList.remove('hidden'); updateSyncStatus(); renderBackups(); renderPresetsMgr();
};
$('settingsClose').onclick=()=>$('settingsModal').classList.add('hidden');
$('credsDismiss').onclick=()=>{localStorage.setItem(CREDS_DISMISS,'1');updateCredsBanner();};
$('wipeBtn').onclick=()=>askDanger({
  title:'⚠️ Reset ALL data?',
  desc:'This permanently deletes every board and card on ALL synced devices. A safety backup is saved on this device first — but be sure.',
  word:'RESET', goLabel:'Reset everything',
  action:()=>{ takeSnapshot('pre-wipe'); state=defaultState(); save(); render(); renderBackups(); }
});
$('seedBtn').onclick=()=>{ takeSnapshot('pre-seed'); state=defaultState(); save(); render(); renderBackups(); };
$('saveFirebase').onclick=()=>{
  const v=$('firebaseConfig').value.trim();
  if(!v){alert('Paste Firebase config JSON first. Firebase Console → Project Settings → General → Your apps → Config.');return;}
  try{ JSON.parse(v); }catch{ alert('Invalid JSON'); return; }
  let key=prompt('Sync key (use SAME on Mac + Samsung, e.g. my-tasks-123):', localStorage.getItem(SYNC_KEY)||'');
  if(!key) return;
  localStorage.setItem(FB_CFG_KEY,v); localStorage.setItem(SYNC_KEY,key.trim());
  initCloud(); updateSyncStatus();
};
$('disableFirebase').onclick=()=>{localStorage.removeItem(FB_CFG_KEY); $('syncStatus').textContent='Local-only mode.';};
function updateSyncStatus(){
  const eff = getEffectiveCfg();
  $('syncStatus').textContent = eff.cfg
    ? ('Sync ON • key: ' + eff.key + (eff.fromFile ? ' (built-in, both devices)' : ' (this browser only)'))
    : 'Local-only. Data stays in this browser.';
}

/* Optional Firebase sync (graceful, no hard dependency) */
const APP_VER = 'v46';
let cloudOn=false, cloudBusy=false, lastSyncAt=0;
function getEffectiveCfg(){
  // 1. baked-in file (Option B: same on Mac + phone after deploy)
  if (window.QB_FIREBASE_CONFIG && window.QB_FIREBASE_CONFIG.apiKey) {
    return { cfg: window.QB_FIREBASE_CONFIG, key: (window.QB_SYNC_KEY || localStorage.getItem(SYNC_KEY) || 'shared'), fromFile: true };
  }
  // 2. per-browser paste fallback
  const raw = localStorage.getItem(FB_CFG_KEY);
  if (raw) {
    try { return { cfg: JSON.parse(raw), key: (localStorage.getItem(SYNC_KEY) || 'shared'), fromFile: false }; }
    catch { return { cfg: null, key: 'shared' }; }
  }
  return { cfg: null, key: 'shared' };
}
function pushToCloud(){
  const eff = getEffectiveCfg();
  if(!eff.cfg||!window._qbDb||cloudBusy) return;
  cloudBusy=true;
  window._qbDb.collection('quickboards').doc(eff.key).set({state, updatedAt:Date.now()},{merge:true})
    .then(()=>{ lastSyncAt=Date.now(); stampSyncLine(); })
    .catch(e=>console.warn('sync push failed',e)).finally(()=>cloudBusy=false);
}
function applyRemote(data){
  // shared by live listener + manual pull; last-write-wins
  if(!data) return false;
  const remote=data.state; if(!remote||!remote.boards) return false;
  // Guard: never accept a wiped boards list over a healthy local one (prevents
  // an accidental delete-all-boards on one device from propagating everywhere).
  if(remote.boards.length===0 && state.boards.length>0){
    console.warn('sync: ignoring remote with 0 boards; local has', state.boards.length);
    pushToCloud(); // heal cloud with the good local copy
    return false;
  }
  if(localStorage.getItem(LS_KEY)===JSON.stringify(remote)) { lastSyncAt=Date.now(); stampSyncLine(); return true; }
  if((data.updatedAt||0) > (state._ts||0)){
    const keepBoard = state.activeBoardId;
    state=remote; state.activeBoardId=state.activeBoardId||keepBoard||state.boards[0]?.id;
    healState();
    try{ localStorage.setItem(LS_KEY,JSON.stringify(state)); }catch(e){}
    lastSyncAt=Date.now(); render(); stampSyncLine();
    return true;
  }
  return false;
}
function pullFromCloud(silent){
  const eff = getEffectiveCfg();
  if(!eff.cfg||!window._qbDb){ if(!silent) alert('Sync not configured yet.'); return; }
  const st = $('syncStatus');
  if(!silent && st) st.textContent='Syncing…';
  window._qbDb.collection('quickboards').doc(eff.key).get()
    .then((doc)=>{
      if(doc.exists && applyRemote(doc.data())){ if(st) st.textContent='Sync connected ✓ • key: '+eff.key; }
      else { lastSyncAt=Date.now(); stampSyncLine(); if(st) st.textContent='Already up to date • key: '+eff.key; }
    })
    .catch((e)=>{ console.warn('sync pull failed',e); if(st) st.textContent='Sync pull failed — check connection/rules.'; });
}
function stampSyncLine(){
  const vl = $('verLine'); if(!vl) return;
  const eff = getEffectiveCfg();
  if(!eff.cfg){ vl.textContent = APP_VER+' • local-only'; return; }
  const ago = lastSyncAt ? (' • synced '+Math.max(0,Math.round((Date.now()-lastSyncAt)/1000))+'s ago') : '';
  vl.textContent = APP_VER+' • sync ON ('+eff.key+')'+ago;
}
setInterval(stampSyncLine, 5000);
function initCloud(){
  const eff = getEffectiveCfg(); if(!eff.cfg) return;
  if(window._qbDb){ pushToCloud(); listenCloud(); return; }
  const loadScript=(src)=>new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;s.onload=res;s.onerror=rej;document.head.appendChild(s);});
  const st = $('syncStatus'); if (st) st.textContent='Connecting…';
  (async()=>{
    try{
      await loadScript('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
      await loadScript('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js');
      await loadScript('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js');
      if(!firebase.apps.length) firebase.initializeApp(eff.cfg);
      try{ await firebase.auth().signInAnonymously(); }catch(e){ console.warn(e); }
      // anonymous auth must be enabled in Firebase Console → Authentication → Sign-in method
      window._qbDb=firebase.firestore();
      cloudOn=true; if (st) st.textContent='Sync connected ✓ • key: '+eff.key;
      lastSyncAt=Date.now(); stampSyncLine();
      pushToCloud(); listenCloud(); pullFromCloud(true);
    }catch(e){ console.warn(e); if (st) st.textContent='Sync failed — check config + enable Anonymous auth. Still local-first.'; }
  })();
}
let unsub=null;
function listenCloud(){
  if(!window._qbDb||unsub) return;
  const eff = getEffectiveCfg();
  unsub=window._qbDb.collection('quickboards').doc(eff.key).onSnapshot((doc)=>{
    if(!doc.exists) return;
    // NOTE: no cloudBusy gate here — echo is handled by equality check inside applyRemote,
    // and gating dropped legit remote updates arriving during a local push.
    applyRemote(doc.data());
  }, (err)=>{
    console.warn('sync listener error', err);
    unsub=null; // allow re-attach on next foreground/pull
    const st=$('syncStatus'); if(st) st.textContent='Live sync paused (connection) — reopen app or tap ⟳.';
  });
}
// Mobile browsers/PWAs suspend live connections in background — re-pull on return.
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState==='visible' && window._qbDb){ listenCloud(); pullFromCloud(true); }
});
window.addEventListener('online', ()=>{ listenCloud(); pullFromCloud(true); });
window.addEventListener('focus', ()=>{ if(window._qbDb) pullFromCloud(true); });
/* ——— Manchester United fixtures (live via OpenLigaDB, free, no key) ——— */
const UTD_API = 'https://api.openligadb.de/getmatchdata/pl/2026';
const UTD_CACHE_KEY = 'quickboard.united.v1';
const UTD_CACHE_TTL = 3*3600*1000; // 3h (feed is slow to finalize results)
// Offline fallback: next fixtures as of Sep 2026 (refreshed from live API when online)
const UTD_FALLBACK = [
  {d:'2026-09-20', h:'Fulham FC', a:'Manchester United FC', s:''},
  {d:'2026-10-10', h:'Manchester United FC', a:'Tottenham Hotspur FC', s:''},
  {d:'2026-10-18', h:'Leeds United', a:'Manchester United FC', s:''},
  {d:'2026-10-25', h:'Manchester United FC', a:'AFC Bournemouth', s:''},
  {d:'2026-10-31', h:'Chelsea FC', a:'Manchester United FC', s:''},
  {d:'2026-11-07', h:'Manchester United FC', a:'Aston Villa', s:''},
];
const shortTeam = (n)=> (n||'').replace(' FC','').replace(' F.C.','').replace('Manchester United','Man Utd').replace('Manchester City','Man City').replace('Tottenham Hotspur','Spurs').replace('Brighton & Hove Albion','Brighton').replace('AFC Bournemouth','Bournemouth').replace('Nottingham Forest',"Nott'm Forest").slice(0,22);
const fmtD = (iso)=>{ try{ const d=new Date(iso.length<=10?iso+'T12:00:00':iso); return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'});}catch{ return iso; } };
async function loadUnited(){
  const nextEl=$('unitedNext'), listEl=$('unitedList'), cntEl=$('unitedCount');
  let games=null, gamesTs=0;
  try{
    const cached=JSON.parse(localStorage.getItem(UTD_CACHE_KEY)||'null');
    if(cached && Date.now()-cached.ts < UTD_CACHE_TTL){ games=cached.games; gamesTs=cached.ts; }
  }catch{}
  const renderUtd=(g)=>{
    if(!g||!g.length){ nextEl.textContent='Fixtures unavailable offline'; return; }
    const today=todayStr();
    const done=g.filter(x=>x.fin && x.d<=today).sort((a,b)=>a.d<b.d?1:-1);
    const todo=g.filter(x=>!x.fin && x.d>=today).sort((a,b)=>a.d<b.d?-1:1);
    const last=done[0], next=todo[0];
    // Feed is slow to finalize: most recent past game may have no result yet — show it as pending, not vanished.
    const pending=g.filter(x=>!x.fin && x.d<today).sort((a,b)=>a.d<b.d?1:-1)[0];
    let html='';
    if(next) html+=`<span class="u-row"><span class="u-tag next">NEXT</span><b>${shortTeam(next.h)} vs ${shortTeam(next.a)}</b><span class="u-when">${next.d===today?'· today':('· '+fmtD(next.d))}</span></span>`;
    if(pending && (!last || pending.d>last.d)) html+=`<span class="u-row dim"><span class="u-tag">LATEST</span>${shortTeam(pending.h)} vs ${shortTeam(pending.a)} · result awaited</span>`;
    else if(last) html+=`<span class="u-row dim"><span class="u-tag">LAST</span>${shortTeam(last.h)} ${last.s} ${shortTeam(last.a)}</span>`;
    nextEl.innerHTML=html;
    if(next && next.d===today){ cntEl.textContent='🔴 MATCHDAY'; cntEl.classList.add('live'); }
    else if(next){ const days=Math.round((new Date(next.d)-new Date(today))/86400000); cntEl.textContent=days<=1?'⏳ Tomorrow':`⏳ ${days} days`; cntEl.classList.remove('live'); }
    listEl.innerHTML=todo.slice(1,7).map((x,i)=>`<span class="united-match tap" data-i="${i+1}" title="Tap to create matchday card"><b>${fmtD(x.d)}</b> ${shortTeam(x.h)} vs ${shortTeam(x.a)}<span class="plus">＋</span></span>`).join('');
    listEl.querySelectorAll('.tap').forEach(el=>{
      el.onclick=()=>createMatchdayCard(todo.slice(0,7)[+el.dataset.i]);
    });
    const upd = gamesTs ? new Date(gamesTs).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}) : 'offline list';
    listEl.innerHTML+=`<span class="u-upd" id="uUpd" title="Tap badge or here to refresh fixtures">upd ${upd} ↻</span>`;
    const uu=$('uUpd'); if(uu) uu.onclick=()=>forceUtdRefresh();
  };
  const badge=document.querySelector('.united-badge'); if(badge) badge.onclick=()=>toggleUtd();
  function forceUtdRefresh(){ try{localStorage.removeItem(UTD_CACHE_KEY);}catch{} gamesTs=0; loadUnited(); }
  if(games) renderUtd(games);
  else renderUtd(UTD_FALLBACK.map(x=>({d:x.d,h:x.h,a:x.a,s:x.s,fin:false})));
  try{
    const r=await fetch(UTD_API); if(!r.ok) return;
    const data=await r.json();
    const g=data.filter(m=>/manchester united/i.test(m.team1.teamName+' '+m.team2.teamName)).map(m=>{
      let s=''; (m.matchResults||[]).forEach(x=>{ if(x.resultName==='Endergebnis') s=x.pointsTeam1+'-'+x.pointsTeam2; });
      const dt=(m.matchDateTime||'').slice(0,10);
      let cd=''; if(dt>=todayStr()){ const ms=new Date(dt)-new Date(todayStr()); const dd=Math.floor(ms/86400000); cd=dd===0?'today':dd+'d'; }
      return {d:dt,h:m.team1.teamName,a:m.team2.teamName,s,fin:!!m.matchIsFinished,cd};
    });
    if(g.length){ games=g; gamesTs=Date.now(); try{localStorage.setItem(UTD_CACHE_KEY,JSON.stringify({ts:gamesTs,games:g}));}catch{} renderUtd(g); }
  }catch(e){ /* offline — fallback already shown */ }
}
function createMatchdayCard(x){
  if(!x) return;
  // Target: Daily Tasks board → Today column (fallbacks: current board / first column)
  const board = state.boards.find(b=>/daily tasks/i.test(b.name)) || activeBoard();
  const col = board.columns.find(c=>/today/i.test(c.name)) || board.columns[0];
  const isToday = x.d===todayStr();
  const title = `⚽ ${isToday?'MATCHDAY':'Upcoming'}: ${shortTeam(x.h)} vs ${shortTeam(x.a)} — ${fmtD(x.d)}`;
  if(state.cards.some(c=>c.boardId===board.id && c.title===title)){ alert('Already on your board ✓'); state.activeBoardId=board.id; render(); return; }
  state.cards.unshift({
    id: uid(), boardId: board.id, colId: col.id, title,
    details: `🏆 Premier League\n📅 ${fmtDate(x.d)}${isToday?' — TODAY, come on United!':''}\n🔗 https://www.manutd.com/en\n\nPre-match:\n- Check team news / lineup\n- Snacks + screen ready\n\nPost-match:\n- Score: __ - __\n- MOTM: `,
    tags: ['football','manutd','matchday'], priority: isToday?'high':'med', due: x.d, createdAt: Date.now()
  });
  state.activeBoardId=board.id;
  save(); render();
  alert(`Added to ${board.name} → ${col.name} ✓`);
}

/* ——— boot ——— */
render();
stampSyncLine();
initCloud();
loadUnited();
(function dailySnap(){
  const snaps=getSnaps();
  const today=todayStr();
  const hasToday=snaps.some(s=>new Date(s.ts).toISOString().slice(0,10)===today);
  if(!hasToday) takeSnapshot('auto-daily');
})();
