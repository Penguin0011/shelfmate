'use strict';
const state = JSON.parse(document.querySelector('#bootstrap').textContent);
const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let csrf, dialogHandler, dialogBusy = false;
const ready = fetch('/api/session/', {credentials:'same-origin'}).then(r => { if (!r.ok) throw Error('Unable to start a session. Reload to try again.'); return r.json(); }).then(s => { csrf = s.csrfToken; });
function notice(message, error = false) { const n = $('#notice'); n.textContent = message; n.className = error ? 'error' : ''; n.hidden = false; }
ready.catch(e => notice(e.message, true));
async function api(url, data, method = 'POST') {
  await ready;
  const options = {method, credentials:'same-origin', headers:{'X-CSRFToken':csrf}};
  if (data instanceof FormData) options.body = data;
  else if (data !== undefined) { options.headers['Content-Type']='application/json'; options.body=JSON.stringify(data); }
  let response;
  try { response = await fetch(url, options); } catch { throw Error('Connection lost. Your changes may not have reached the server. Try again.'); }
  let result; try { result = await response.json(); } catch { throw Error(response.status === 403 ? 'Your session has expired. Reload and sign in again.' : 'The server could not complete that request. Please try again.'); }
  if (!response.ok) throw Object.assign(Error(result.error || 'Could not complete that request.'), {status: response.status, archived: result.archived === true});
  if (result.csrfToken) csrf = result.csrfToken;
  return result;
}
const field = (name, label, value = '', options = '') => `<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" value="${esc(value)}" ${options}></div>`;
const area = (name, label, value = '', max = 2000) => `<div class="field"><label for="f-${name}">${label}</label><textarea id="f-${name}" name="${name}" maxlength="${max}">${esc(value)}</textarea></div>`;
function modal(title, fields, submit, handler) {
  document.querySelectorAll('.overflow[open]').forEach(d => d.open = false);
  $('#dialog-title').textContent = title; $('#dialog-fields').innerHTML = fields;
  $('#dialog-submit').textContent = submit; $('#dialog-error').hidden = true;
  dialogHandler = handler; $('#dialog').showModal();
}
$('#dialog-form').addEventListener('submit', async e => {
  e.preventDefault(); if (dialogBusy) return;
  dialogBusy = true; const button = $('#dialog-submit'); const label=button.textContent;
  button.disabled=true; button.textContent='Working…'; $('#dialog-error').hidden=true;
  try { await dialogHandler(new FormData(e.target)); }
  catch (error) { $('#dialog-error').textContent=error.message; $('#dialog-error').hidden=false; }
  finally { dialogBusy=false; button.disabled=false; button.textContent=label; }
});
$('#dialog').addEventListener('cancel', e => { if (dialogBusy) e.preventDefault(); });
document.querySelectorAll('.close').forEach(b => b.addEventListener('click', () => { if (!dialogBusy) $('#dialog').close(); }));
function success(message, path = location.pathname) { sessionStorage.setItem('inventory-notice', message); location.assign(path); }
const previous = sessionStorage.getItem('inventory-notice');
if (previous) { notice(previous); sessionStorage.removeItem('inventory-notice'); }
function loginForm() {
  modal('Owner sign in', '<p class="hint">Household viewing stays open. Sign in to manage your inventory.</p>'+field('username','Username','','required autocomplete="username" maxlength="150"')+field('password','Password','','type="password" required autocomplete="current-password" maxlength="1024"'), 'Sign in', async f => { await api('/api/login/',Object.fromEntries(f)); success('Signed in as owner.'); });
}
function boxForm(edit=false, restore=false) {
  const box=state.box;
  modal(restore ? `Reuse Box ${box.number}` : edit ? 'Edit box' : 'Create or reuse a box', (edit ? `<p class="hint">Box ${box.number} keeps its number and NFC link.</p>` : '<p class="hint">An archived number can be reused. Its existing NFC tag will keep working.</p>'+field('number','Box number',state.next_number,'type="number" min="1" max="2147483647" required inputmode="numeric"')) + field('category','Category / name',edit?box.category:'','required maxlength="120" placeholder="e.g. Drone parts"') + field('location','Location (optional)',edit?box.location:'','maxlength="120" list="room-choices" placeholder="e.g. Office, garage, closet"') + `<datalist id="room-choices">${state.locations.map(name=>`<option value="${esc(name)}"></option>`).join('')}</datalist>` + (edit && !restore ? `<label class="check-label"><input type="checkbox" name="retired" ${box.retired?'checked':''}>Archive this box</label><p class="hint">Move or remove its contents before archiving it.</p>` : ''), restore ? 'Restore box' : 'Save box', async f => {
    const data={category:f.get('category'),location:f.get('location')};
    if(edit) { data.revision=box.revision; data.retired=restore?false:f.has('retired'); }
    else data.number=Number(f.get('number'));
    const url=edit?`/api/boxes/${box.number}/edit/`:'/api/boxes/create/';
    let saved;
    try { saved=await api(url,data); }
    catch(error){
      // The server refuses to revive an archived box unless asked; ask, then say so plainly.
      if(!error.archived||!confirm(`Box ${data.number} is archived. Reuse it and its NFC tag? It keeps its number and URL.`))throw error;
      saved=await api(url,{...data,restore:true});
    }
    success(saved.restored||restore?'Box restored. Your NFC tag is ready to reuse.':'Box saved.',`/box/${edit?box.number:saved.number}`);
  });
}
function itemForm(item=null) {
  const number=item?item.box:state.box.number;
  const select=`<div class="field"><label for="f-box">Home box</label><select id="f-box" name="box">${state.boxes.map(b=>`<option value="${b.number}" ${b.number===number?'selected':''}>${esc(b.category)} · Box ${b.number}${b.location?` · ${esc(b.location)}`:''}</option>`).join('')}</select></div>`;
  modal(item?'Edit / move item':'Add an item', field('name','Item or assortment name',item?.name,'required maxlength="200"')+area('description','Description (optional)',item?.description)+field('aliases','Other names (optional)',item?.aliases,'maxlength="1000" placeholder="e.g. GPU, graphics card"')+select+(item?'<button type="button" class="text-button danger" id="delete-item">Delete this entry</button>':''), 'Save item', async f => {
    const data=Object.fromEntries(f); data.box=Number(data.box);
    if(item) data.revision=item.revision;
    await api(item?`/api/items/${item.id}/edit/`:'/api/items/create/',data);
    success('Item saved.',`/box/${data.box}`);
  });
  if(item) $('#delete-item').onclick=() => {
    if (!confirm(`Delete “${item.name}” from the inventory?`)) return;
    api(`/api/items/${item.id}/edit/`,{revision:item.revision,delete:true}).then(()=>success('Entry deleted.')).catch(e=>{ $('#dialog-error').textContent=e.message;$('#dialog-error').hidden=false; });
  };
}
function flagForm(item=null) {
  modal('Flag a change', `<p>${esc(item?.name || state.box.category)} · Box ${state.box.number}</p><div class="field"><label for="f-reason">What changed?</label><select id="f-reason" name="reason"><option value="missing">Couldn’t find it</option><option value="taken">I took it</option><option value="moved">Put it somewhere else</option><option value="other">Something else</option></select></div>`+area('note','Note (optional)')+field('reporter','Your name (optional)','','maxlength="100" autocomplete="given-name"'), 'Send flag', async f => {
    const data=Object.fromEntries(f); if(item)data.item=item.id;
    await api(`/api/boxes/${state.box.number}/flags/`,data);$('#dialog').close();notice('Flag sent to the owner. Thank you.');
  });
}
// Dictation is the browser's own SpeechRecognition: no audio ever reaches this server, no key, no
// upload. Chrome and Safari have it; Firefox does not, so every mic button hides itself there and
// the surrounding control stays usable by keyboard alone.
// Resolved per call, not once at load, so a test can stand a fake in front of it.
const Recognizer = () => window.SpeechRecognition || window.webkitSpeechRecognition;
function listen({onText, onStop}) {
  const recognition = new (Recognizer())();
  recognition.lang = document.documentElement.lang || 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;
  let settled = '', live = true, failure = '';
  // Only results from resultIndex on are new; re-reading the whole list duplicates text after a restart.
  recognition.onresult = e => {
    let interim = '';
    for (let n = e.resultIndex; n < e.results.length; n++) {
      // Trim and re-space each finished phrase: engines differ on whether they supply the leading
      // space, and a restart starts a fresh phrase with none, which would run two words together.
      if (e.results[n].isFinal) settled += e.results[n][0].transcript.trim() + ' ';
      else interim += e.results[n][0].transcript;
    }
    onText(settled + interim);
  };
  recognition.onerror = e => {
    // A silence or a stop() is not a failure; anything else ends the session with a reason to show.
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    failure = e.error === 'not-allowed' || e.error === 'service-not-allowed'
      ? 'Microphone access is blocked. Allow it in your browser settings, or type instead.'
      : 'Speech recognition stopped working. Try again, or type instead.';
    live = false;
  };
  // Both Chrome and iOS Safari end the session on a pause for breath, which would cut a rambling
  // description off at the first one. Restart until the speaker says stop.
  recognition.onend = () => {
    if (live) { try { recognition.start(); return; } catch { /* already restarting */ } }
    live = false; onStop(failure);
  };
  recognition.start();
  return () => { live = false; recognition.stop(); };
}
// Returns false when the browser cannot listen, so callers can reword what is left.
function micToggle(button, {onStart, onText, onDone}) {
  button.hidden = !Recognizer();
  if (!Recognizer()) return false;
  let stop = null;
  const finish = failure => { stop = null; button.classList.remove('listening'); button.setAttribute('aria-pressed','false'); onDone(failure); };
  button.addEventListener('click', () => {
    if (stop) { stop(); return; }
    button.classList.add('listening'); button.setAttribute('aria-pressed','true');
    if (onStart) onStart();
    stop = listen({onText, onStop: finish});
  });
  return () => { if (stop) stop(); };
}
function describeForm() {
  const MAX = 5000;
  modal('Add items by talking',
    '<p>Talk through the box out loud. Ramble, backtrack, correct yourself — the AI sorts it into entries you review before anything is saved.</p>'
    + `<div class="field"><label for="f-transcript">What is in the box</label><textarea id="f-transcript" name="transcript" maxlength="${MAX}" rows="8" placeholder="e.g. there's a bag of M3 screws in here, about a hundred, and the little grey USB hub…"></textarea></div>`
    + '<button type="button" id="dictate" class="mic-button"><span class="mic-dot" aria-hidden="true"></span><span id="dictate-label">Start talking</span></button>'
    + '<p id="dictate-status" class="hint" aria-live="polite">Type it out, or dictate and fix anything the microphone gets wrong.</p>'
    + '<p class="hint">No photos needed. Your words are sent for AI recognition; the draft is kept until you save or discard it.</p>',
    'Sort it out', async f => {
      const transcript = f.get('transcript').trim();
      if (!transcript) throw Error('Say or type something about the box first.');
      const data = new FormData();
      data.append('transcript', transcript.slice(0, MAX));
      const saved = await api(`/api/boxes/${state.box.number}/drafts/`, data);
      location.assign(`/drafts/${saved.id}`);
    });
  const box = $('#f-transcript'), label = $('#dictate-label'), status = $('#dictate-status');
  // Dictation appends to what is already in the box, so a typed correction is never overwritten.
  let base = '';
  const abort = micToggle($('#dictate'), {
    onStart: () => { base = box.value ? box.value.trimEnd() + ' ' : ''; label.textContent = 'Stop'; status.textContent = 'Listening… speak naturally, then press Stop.'; },
    onText: text => { box.value = (base + text).slice(0, MAX); },
    onDone: failure => { label.textContent = 'Start talking'; status.textContent = failure || 'Stopped. Fix anything it misheard, then continue.'; box.focus(); },
  });
  if (!abort) status.textContent = 'This browser cannot listen. Type the description instead.';
  else $('#dialog').addEventListener('close', abort, {once:true});
}
// Each pick adds to the batch instead of replacing it: iOS pickers often return one photo at a time.
// Photos are shrunk to the server's own 1536px working size before upload, which turns a 6 MB HEIC
// frame into ~500 KB of JPEG. That is what makes HEIC and 48MP phone photos work: the browser decodes
// the original and we hand the server a plain JPEG, so neither format nor megapixels ever reach it.
const MAX_EDGE=1536;
async function toUploadableJpeg(file) {
  let bitmap;
  // imageOrientation bakes EXIF rotation into the pixels; canvas output carries no EXIF to rotate by.
  try { bitmap = await createImageBitmap(file, {imageOrientation:'from-image'}); }
  catch { return null; }
  try {
    const scale=Math.min(1, MAX_EDGE/Math.max(bitmap.width, bitmap.height));
    const w=Math.max(1,Math.round(bitmap.width*scale)), h=Math.max(1,Math.round(bitmap.height*scale));
    const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h;
    canvas.getContext('2d').drawImage(bitmap,0,0,w,h);
    const blob=await new Promise(done=>canvas.toBlob(done,'image/jpeg',0.85));
    if(!blob) return null;
    // A real File, not a Blob: staging keys on name and lastModified.
    return new File([blob], file.name.replace(/\.[^.]+$/,'')+'.jpg', {type:'image/jpeg', lastModified:file.lastModified});
  } finally { bitmap.close(); }
}
function uploadForm() {
  const MAX=4, MAX_EACH=10*1024*1024, MAX_TOTAL=25*1024*1024;
  const staged=[], urls=[];
  const identity=f=>`${f.name}:${f.size}:${f.lastModified}`;
  const total=()=>staged.reduce((sum,s)=>sum+s.file.size,0);
  modal('Add from photos', '<p>Lay the items out so each is visible. Include labels where you can.</p><div class="field"><label for="f-photos">Choose photos or take a photo</label><input id="f-photos" name="photos" type="file" accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif" multiple></div><div id="staged-photos" class="staged-grid"></div><p id="staged-note" class="hint"></p><p class="hint">Up to 4 photos. Straight from the camera is fine — HEIC and full-resolution shots are shrunk here before upload, so they arrive small and fast. Add them together or a few at a time; each pick joins the batch below. Photos are sent for AI recognition and deleted locally after you save or discard the draft.</p>', 'Upload & review', async () => {
    if(!staged.length) throw Error('Choose at least one photo first.');
    const data=new FormData();
    staged.forEach(s=>data.append('photos',s.file));
    const saved=await api(`/api/boxes/${state.box.number}/drafts/`,data);
    location.assign(`/drafts/${saved.id}`);
  });
  const input=$('#f-photos'), grid=$('#staged-photos'), note=$('#staged-note'), error=$('#dialog-error');
  function render() {
    urls.splice(0).forEach(URL.revokeObjectURL);
    grid.innerHTML=staged.map((s,n)=>{ const url=URL.createObjectURL(s.file); urls.push(url);
      return `<div class="staged-photo"><img src="${url}" alt="${esc(s.label)}"><button type="button" class="remove-photo" data-drop="${n}" aria-label="Remove ${esc(s.label)}">×</button></div>`; }).join('');
    note.innerHTML=staged.length?`<span class="photo-count">${staged.length} of ${MAX} photos ready</span> · ${(total()/1048576).toFixed(1)} MB${staged.length<MAX?' · tap above to add more':''}`:'No photos chosen yet.';
    input.disabled=staged.length>=MAX;
    $('#dialog-submit').textContent=staged.length>1?`Upload ${staged.length} photos & review`:'Upload & review';
  }
  input.addEventListener('change',async () => {
    const picked=[...input.files];
    // Clearing lets the same file be re-picked after removal, and keeps the control ready.
    input.value='';
    const problems=[];
    input.disabled=true; error.hidden=true;
    note.textContent=`Preparing ${picked.length} photo${picked.length===1?'':'s'}…`;
    for(const original of picked) {
      if(staged.length>=MAX){problems.push(`Only ${MAX} photos can go in one batch.`);break;}
      const key=identity(original);
      if(staged.some(s=>s.key===key))continue;
      const shrunk=await toUploadableJpeg(original);
      if(!shrunk && !['image/jpeg','image/png'].includes(original.type)){
        problems.push(`${original.name}: this browser cannot read that format — export it as JPEG.`);
        continue;
      }
      // Fall back to the original when the browser cannot decode it but the server accepts the type.
      const file=shrunk||original;
      if(file.size>MAX_EACH){problems.push(`${original.name} is still over 10 MB.`);continue;}
      if(total()+file.size>MAX_TOTAL){problems.push('Adding that would pass 25 MB in total.');break;}
      staged.push({file, key, label:original.name});
    }
    input.disabled=false;
    render();
    error.textContent=problems.join(' ');
    error.hidden=!problems.length;
  });
  grid.addEventListener('click',e=>{
    const button=e.target.closest('[data-drop]'); if(!button)return;
    staged.splice(Number(button.dataset.drop),1);
    error.hidden=true;
    render();
  });
  $('#dialog').addEventListener('close',()=>urls.splice(0).forEach(URL.revokeObjectURL),{once:true});
  render();
}
// Selection lives in the DOM rather than a parallel array, so it cannot drift from what is shown.
const picked = () => [...document.querySelectorAll('.pick-item:checked')].map(c => Number(c.value));
function selectionChanged() {
  const count = picked().length, all = document.querySelectorAll('.pick-item').length;
  const label = $('#select-count');
  if (label) label.textContent = count ? `${count} of ${all} selected` : 'Select items to move or delete them together.';
  document.querySelectorAll('[data-action="bulk-move"],[data-action="bulk-delete"]').forEach(b => b.disabled = !count);
  document.querySelectorAll('.pick-item').forEach(c => c.closest('.item-row').classList.toggle('picked', c.checked));
  const toggle = $('#select-all');
  if (toggle) { toggle.checked = count > 0 && count === all; toggle.indeterminate = count > 0 && count < all; }
}
// Revisions come from the bootstrap, so the batch carries the same optimistic-concurrency check the
// single-item form does. The page reloads afterwards: stale revisions would 409 on the next action.
function selectedWithRevisions() {
  const ids = picked();
  return state.items.filter(i => ids.includes(i.id)).map(i => ({id: i.id, revision: i.revision}));
}
async function bulkDelete() {
  const items = selectedWithRevisions();
  if (!items.length) return;
  const names = state.items.filter(i => items.some(s => s.id === i.id)).map(i => i.name);
  const preview = names.slice(0, 4).join(', ') + (names.length > 4 ? `, and ${names.length - 4} more` : '');
  if (!confirm(`Delete ${items.length} ${items.length === 1 ? 'entry' : 'entries'} from Box ${state.box.number}?\n\n${preview}\n\nThis cannot be undone.`)) return;
  await api('/api/items/bulk/', {action: 'delete', items});
  success(`${items.length} ${items.length === 1 ? 'entry' : 'entries'} deleted.`);
}
function bulkMoveForm() {
  const items = selectedWithRevisions();
  if (!items.length) return;
  const options = state.boxes.filter(b => b.number !== state.box.number)
    .map(b => `<option value="${b.number}">${esc(b.category)} · Box ${b.number}${b.location ? ` · ${esc(b.location)}` : ''}</option>`).join('');
  if (!options) { notice('There is no other active box to move them into. Create one first.', true); return; }
  modal(`Move ${items.length} ${items.length === 1 ? 'entry' : 'entries'}`,
    `<p class="hint">Moving from Box ${state.box.number}. Names and descriptions are unchanged.</p><div class="field"><label for="f-box">Destination box</label><select id="f-box" name="box">${options}</select></div>`,
    'Move entries', async f => {
      const box = Number(f.get('box'));
      await api('/api/items/bulk/', {action: 'move', items, box});
      success(`${items.length} ${items.length === 1 ? 'entry' : 'entries'} moved to Box ${box}.`, `/box/${box}`);
    });
}
document.addEventListener('click', async e => {
  const button=e.target.closest('[data-action]');if(!button)return;
  const action=button.dataset.action;
  const item=state.items.find(i=>i.id===Number(button.dataset.item));
  try {
    if(action==='login')loginForm();
    if(action==='logout'){await api('/api/logout/',{});location.assign('/');}
    if(action==='new-box')boxForm();
    if(action==='edit-box')boxForm(true);
    if(action==='restore-box')boxForm(true,true);
    if(action==='new-item')itemForm();
    if(action==='edit-item')itemForm(item);
    if(action==='flag')flagForm(item);
    if(action==='upload')uploadForm();
    if(action==='describe')describeForm();
    if(action==='bulk-move')bulkMoveForm();
    if(action==='bulk-delete')await bulkDelete();
    if(action==='resolve'||action==='dismiss'){button.disabled=true;await api(`/api/flags/${button.dataset.flag}/`,{status:action==='resolve'?'resolved':'dismissed'});success('Flag updated.');}
  } catch(error){notice(error.message,true);button.disabled=false;}
});
if(document.querySelector('.pick-item')) {
  document.addEventListener('change', e => {
    if (e.target.id === 'select-all') {
      document.querySelectorAll('.pick-item').forEach(c => c.checked = e.target.checked);
      selectionChanged();
    } else if (e.target.classList.contains('pick-item')) {
      selectionChanged();
    }
  });
  selectionChanged();
}
if(new URLSearchParams(location.search).has('login'))loginForm();
// Search stays on the index and always asks the AI first. The AI endpoint answers 429/502/503 with
// "use local search" when it is rate-limited, unconfigured or unreachable, so fall back to the name
// search rather than leaving the box with nothing to show.
let searchVersion=0;
async function runSearch() {
  const q=$('#query').value.trim();if(!q){$('#query').focus();return;}
  const version=++searchVersion;
  $('#search-results').hidden=false;$('#result-list').textContent='Looking through the saved descriptions…';
  $('#results-title').textContent='AI matches';
  try {
    let result, ai=true;
    try { result=await api('/api/search/ai/',{question:q}); }
    catch(unavailable) {
      if(version!==searchVersion)return;
      ai=false;
      $('#result-list').textContent='AI is unavailable — searching names instead…';
      result=await api(`/api/search/?q=${encodeURIComponent(q)}`,undefined,'GET');
    }
    if(version!==searchVersion)return;
    $('#results-title').textContent=ai?'AI matches':'Name matches';
    const matches=result.matches||result.items;
    $('#result-list').innerHTML=matches.length?matches.map((i,n)=>`<a class="result-row" href="/box/${i.box}#item-${i.id}"><span class="row-number" aria-hidden="true">${String(n+1).padStart(2,'0')}</span><div class="result-copy">${ai?'<span class="match-label">Possible match</span>':''}<h3>${esc(i.name)}</h3><span class="box-number">${i.location?`${esc(i.location)} · `:''}Box ${i.box} / ${esc(i.category)}</span><p>${esc(ai?i.explanation:i.description)}</p></div></a>`).join(''):'<div class="empty"><h3>No matching entries.</h3><p>Try a different name, or ask the owner to check.</p></div>';
    history.replaceState(null,'',`/?q=${encodeURIComponent(q)}`);
  } catch(error){if(version===searchVersion){$('#result-list').innerHTML='';const p=document.createElement('p');p.className='pad';p.textContent=error.message;$('#result-list').append(p);}}
}
if($('#search-form')) {
  $('#search-form').addEventListener('submit',e=>{e.preventDefault();runSearch();});
  $('#clear-search').onclick=()=>{searchVersion++;$('#search-results').hidden=true;$('#query').value='';history.replaceState(null,'','/');$('#query').focus();};
  // maxlength only constrains typing, so a long dictation must be clipped to the server's 500 limit.
  micToggle($('#search-mic'), {
    onStart:()=>notice('Listening… ask your question, then press the microphone again.'),
    onText:text=>{$('#query').value=text.trim().slice(0,500);},
    onDone:failure=>{if(failure)notice(failure,true);else{$('#notice').hidden=true;if($('#query').value.trim())runSearch();}},
  });
  const q=new URLSearchParams(location.search).get('q');if(q){$('#query').value=q;runSearch();}
  if(state.owner)api('/api/drafts/',undefined,'GET').then(r=>{if(r.drafts.length){$('#draft-list').hidden=false;$('#draft-links').innerHTML=r.drafts.map(d=>`<a class="box-row" href="/drafts/${d.id}"><span class="row-number" aria-hidden="true">${String(d.box).padStart(2,'0')}</span><span class="box-copy"><span class="box-category">${d.analyzing?'Recognizing…':'Continue adding'}</span><span class="box-sub">Box ${d.box} · ${d.analyzing?'AI is still working':'unfinished draft'}</span></span></a>`).join('');}}).catch(e=>notice(e.message,true));
}

// Keep revisioned draft writes in order. A lost response leaves edits visible for recovery.
if(state.draft) {
  let draft=state.draft, dirty=false, timer, queue=Promise.resolve(), busy=false, epoch=0, poll;
  let rows=draft.entries.map(r=>({...r,selected:false}));
  const editor=$('#draft-editor');
  function status(text,error=false){const n=$('#save-status');if(n){n.textContent=text;n.style.color=error?'var(--rust)':'';}}
  function values(){return rows.map(({selected,...r})=>r);}
  // Recognition keeps running on the server after you leave, and its result is written under the
  // revision the run started with -- so an edit made while it is in flight would discard it. Reopen
  // a running draft and it stays read-only until the result lands, then redraws with it.
  function drawAnalyzing(){
    const source=draft.photos.length?(draft.transcript?'your photos and description':'your photos'):'what you said';
    editor.innerHTML=`${draft.photos.length?`<div class="photo-grid">${draft.photos.map((url,n)=>`<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Uploaded photo ${n+1}"></a>`).join('')}</div>`:''}<p class="analyzing" aria-live="polite">Recognizing items from ${source}…</p><p class="hint">This keeps running if you close the page — the result is saved to this draft. Editing is paused until it lands, so nothing overwrites it.</p><div class="actions"><a class="button" href="/box/${draft.box}">Open Box ${draft.box}</a></div>`;
    clearTimeout(poll);
    poll=setTimeout(async()=>{
      try{draft=await api(`/api/drafts/${draft.id}/`,undefined,'GET');rows=draft.entries.map(r=>({...r,selected:false}));dirty=false;draw();}
      // Keep retrying a flaky connection, but a draft that is gone or no longer ours will never
      // come back -- polling it every 3s for the life of an abandoned tab helps nobody.
      catch(error){if(error.status>=400&&error.status<500){notice('This draft is no longer available. Reload the page.',true);return;}drawAnalyzing();}
    },3000);
  }
  function draw(){
    clearTimeout(poll);
    if(draft.analyzing&&!busy)return drawAnalyzing();
    if(draft.state!=='open'||new Date(draft.expires_at)<=new Date()){editor.innerHTML=`<div class="empty"><h3>This draft is ${esc(draft.state==='open'?'expired':draft.state)}.</h3><p>Return to the box to see its saved contents.</p><a class="button" href="/box/${draft.box}">Open box</a></div>`;return;}
    // ponytail: the transcript is read-only here -- correct the entries it produced instead. Make it
    // editable only if re-recognizing from a fixed-up ramble turns out to be worth a round trip.
    const source=draft.photos.length?(draft.transcript?'photos and description':'photos'):'what you said';
    editor.innerHTML=`${draft.photos.length?`<div class="photo-grid">${draft.photos.map((url,n)=>`<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Uploaded photo ${n+1}"></a>`).join('')}</div>`:''}${draft.transcript?`<div class="transcript-note"><span class="eyebrow">What you said</span><p>${esc(draft.transcript)}</p></div>`:''}<button id="analyze" class="green wide">${rows.length?'Recognize again':`Recognize items from ${source}`}</button><p id="analyze-progress" class="analyzing" hidden aria-live="polite"></p><p class="hint">You can also enter items manually. Review every suggestion before saving.</p><div id="draft-rows">${rows.map((r,n)=>`<section class="draft-row" data-row="${n}"><div class="draft-row-top"><label class="check-label"><input type="checkbox" data-select="${n}" ${r.selected?'checked':''}>Select</label><button type="button" class="text-button danger" data-remove="${n}">Remove</button></div><div class="field"><label for="name-${n}">Item or assortment name</label><input id="name-${n}" data-key="name" maxlength="200" value="${esc(r.name)}" required></div><div class="field"><label for="description-${n}">Description</label><textarea id="description-${n}" data-key="description" maxlength="2000">${esc(r.description)}</textarea></div><div class="field"><label for="aliases-${n}">Other names</label><input id="aliases-${n}" data-key="aliases" maxlength="1000" value="${esc(r.aliases)}"></div>${draft.duplicates.includes(n)?'<p class="duplicate">A matching name is already in this box. Review before adding.</p>':''}</section>`).join('')}</div><div class="actions wrap"><button id="add-row">+ Add an entry</button><button id="combine">Merge selected entries</button></div><div class="save-bar"><div class="selection-bar"><label class="check-label"><input type="checkbox" id="draft-select-all">Select all</label><span id="draft-select-count" aria-live="polite"></span></div><p id="save-status" class="save-status" role="status">${dirty?'Unsaved changes':'Draft saved'}</p><div class="actions"><button id="save-draft" class="primary">Save to Box ${draft.box}</button><button id="cancel-draft">Discard</button></div><p class="hint">Everything listed here is saved — use Remove to drop an entry. Selecting is only for merging.${draft.photos.length?' Uploaded photos are deleted locally.':''}</p></div>`;
    $('#analyze').onclick=analyze;$('#add-row').onclick=()=>{rows.push({name:'',description:'',aliases:'',selected:false});dirty=true;epoch++;draw();$(`#name-${rows.length-1}`).focus();};
    $('#combine').onclick=()=>{const selected=rows.filter(r=>r.selected);if(selected.length<2){status('Select at least two entries to merge them.',true);return;}if(selected.length>2&&!confirm(`Merge ${selected.length} selected entries into a single item? This cannot be undone.`))return;const first=rows.findIndex(r=>r.selected);const combined={name:selected.map(r=>r.name).join(' + ').slice(0,200),description:selected.map(r=>r.description).filter(Boolean).join('\n').slice(0,2000),aliases:selected.map(r=>r.aliases).filter(Boolean).join(', ').slice(0,1000),selected:true};rows=rows.filter((r,n)=>!r.selected||n===first).map(r=>r.selected?combined:r);changed();draw();};
    $('#save-draft').onclick=saveFinal;$('#cancel-draft').onclick=cancel;
    $('#draft-select-all').onclick=e=>{const on=e.target.checked;rows.forEach(r=>r.selected=on);draw();};
    selectionStatus();
  }
  function selectionStatus(){
    const picked=rows.filter(r=>r.selected).length, label=$('#draft-select-count'), all=$('#draft-select-all');
    if(label)label.textContent=picked?`${picked} of ${rows.length} selected for merging`:'';
    if(all){all.checked=picked>0&&picked===rows.length;all.indeterminate=picked>0&&picked<rows.length;}
  }
  function changed(){dirty=true;epoch++;clearTimeout(timer);status('Unsaved changes');timer=setTimeout(()=>persist().catch(e=>status(e.message,true)),700);}
  async function persist(){
    clearTimeout(timer);
    const operation=async()=>{
      if(!dirty)return;
      if(rows.some(r=>!r.name.trim()))throw Error('Give each entry a name to save this draft.');
      const version=epoch;const snapshot=values();status('Saving draft…');
      const updated=await api(`/api/drafts/${draft.id}/`,{revision:draft.revision,entries:snapshot});
      draft=updated;if(version===epoch)dirty=false;status(dirty?'Unsaved changes':'Draft saved');
    };
    queue=queue.catch(()=>{}).then(operation);return queue;
  }
  function disable(on){busy=on;editor.querySelectorAll('button,input,textarea').forEach(e=>e.disabled=on);}
  // The model returns nothing until it has finished reading every photo, so show the wait next to
  // the button that started it. Silence for 30-60 seconds is what reads as a broken server.
  let ticker;
  // Thresholds track the server's AI budget (settings.AI_TOTAL_TIMEOUT, 55 s); typical runs finish near 20 s.
  function stage(seconds,count){
    if(seconds<10)return count?`Sending ${count} photo${count===1?'':'s'} to the AI model…`:'Sending your description to the AI model…';
    if(seconds<30)return count?'Reading the photos and naming what it sees…':'Working through what you said and naming the items…';
    if(seconds<50)return 'Still working. Busy models take longer — your draft is safe.';
    return 'Almost at the time limit. If this fails, your draft is kept.';
  }
  async function analyze(){
    if(busy)return;
    if(rows.length&&!confirm('Replace these entries with fresh AI suggestions?'))return;
    disable(true);
    const button=$('#analyze'), panel=$('#analyze-progress'), label=button.textContent;
    const count=draft.photos.length, started=Date.now();
    panel.hidden=false; panel.className='analyzing';
    const tick=()=>{const seconds=Math.round((Date.now()-started)/1000);button.textContent=`Recognizing… ${seconds}s`;panel.textContent=stage(seconds,count);};
    tick(); ticker=setInterval(tick,1000);
    panel.scrollIntoView({block:'center',behavior:'smooth'});
    try{
      if(dirty)await persist();
      draft=await api(`/api/drafts/${draft.id}/analyze/`,{revision:draft.revision,replace:rows.length>0});
      rows=draft.entries.map(r=>({...r,selected:false}));
      dirty=false;
      clearInterval(ticker);
      draw();
      status(rows.length?`${rows.length} suggestion${rows.length===1?'':'s'} ready. Review each one before saving.`:'The AI found nothing to add. Try another photo, or add entries manually.');
    }catch(e){
      clearInterval(ticker);
      button.textContent=label;
      panel.className='analyzing error'; panel.textContent=e.message; panel.hidden=false;
      status(e.message,true);
    }finally{clearInterval(ticker);disable(false);}
  }
  async function saveFinal(){
    if(busy)return;
    if(!rows.length){status('Add at least one entry.',true);return;}
    disable(true);try{await persist();await api(`/api/drafts/${draft.id}/save/`,{revision:draft.revision});dirty=false;success('Items added to the box.',`/box/${draft.box}`);}catch(e){status(e.message,true);}finally{disable(false);}}
  async function cancel(){if(busy||!confirm('Discard this draft and delete its uploaded photos?'))return;clearTimeout(timer);disable(true);try{await queue.catch(()=>{});await api(`/api/drafts/${draft.id}/cancel/`,{});dirty=false;success('Draft discarded.',`/box/${draft.box}`);}catch(e){status(e.message,true);}finally{disable(false);}}
  editor.addEventListener('input',e=>{const key=e.target.dataset.key;if(!key)return;const n=Number(e.target.closest('[data-row]').dataset.row);rows[n][key]=e.target.value;changed();});
  editor.addEventListener('change',e=>{if(e.target.dataset.select!==undefined){rows[Number(e.target.dataset.select)].selected=e.target.checked;selectionStatus();}});
  editor.addEventListener('click',e=>{const b=e.target.closest('[data-remove]');if(b&&!busy){rows.splice(Number(b.dataset.remove),1);changed();draw();}});
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  draw();
}
