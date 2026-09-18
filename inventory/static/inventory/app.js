'use strict';
const state = JSON.parse(document.querySelector('#bootstrap').textContent);
const $ = (selector, root = document) => root.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let csrf, dialogHandler, dialogBusy = false;

// Drawably (vendored under static/inventory/drawably, exposed as window.drawably by the module script
// in page.html) sketches SVG chrome onto real controls. Every render path writes innerHTML, so rather
// than calling this after each one a body observer re-runs it; the :not(.drawably-host) guards make a
// pass idempotent and a no-op pass costs a few querySelectorAll.
const SKETCH_BUTTONS='button:not(.text-button,.ask-go,.ask-mic,.remove-photo,.dialog-top .close,.overflow button,.drawably-host),.button:not(.drawably-host),.small-button:not(.drawably-host)';
const SKETCH_FIELDS='input:is(:not([type]),[type=text],[type=search],[type=number],[type=password]),textarea,select';
const sketches=new WeakMap();
function sketch(root=document){
  const d=window.drawably; if(!d) return;
  const wrap=el=>{ const w=document.createElement('span'); el.replaceWith(w); w.append(el); return w; };
  // Relabelling a button with textContent= discards the SVG along with the old label (dialog submit,
  // snap and analyze buttons all do this), so a sketch left with no drawing is torn down and redrawn.
  root.querySelectorAll('.drawably-button:not(:has(.drawably-svg))').forEach(b=>sketches.get(b)?.destroy());
  root.querySelectorAll(SKETCH_BUTTONS).forEach(b=>sketches.set(b,d.drawablyButton(b,{
    variant:b.matches('.primary,.green,.rust')?'solid':'outline', tone:b.matches('.danger')?'danger':undefined,
  })));
  root.querySelectorAll('input[type=checkbox]:not(.mode-option input,.drawably-host input)').forEach(c=>d.drawablyCheckbox(wrap(c)));
  root.querySelectorAll(SKETCH_FIELDS).forEach(f=>{ if(f.closest('.drawably-host')) return;
    (f.tagName==='TEXTAREA'?d.drawablyTextarea:f.tagName==='SELECT'?d.drawablySelect:d.drawablyInput)(wrap(f)); });
  root.querySelectorAll('.draft-row:not(.drawably-host),.transcript-note:not(.drawably-host)').forEach(c=>d.drawablyCard(c));
  root.querySelectorAll('.match-label:not(.drawably-host)').forEach(b=>d.drawablyBadge(b,{variant:'scribble'}));
}
sketch();
new MutationObserver(records=>{ if(records.some(r=>!r.target.closest('.drawably-svg'))) sketch(); })
  .observe(document.body,{childList:true,subtree:true});
async function refreshSession(signal) {
  const response = await fetch('/api/session/', {credentials:'same-origin', cache:'no-store', signal});
  if (!response.ok) throw Error('Unable to start a session. Try again.');
  const session = await response.json();
  csrf = session.csrfToken;
  return session;
}
const ready = refreshSession();
function notice(message, error = false) { const n = $('#notice'); n.textContent = message; n.className = error ? 'error' : ''; n.hidden = false; }
ready.catch(e => notice(e.message, true));
async function api(url, data, method = 'POST', signal) {
  if (!csrf) await ready.catch(() => refreshSession(signal));
  const options = {method, signal, credentials:'same-origin', headers:{'X-CSRFToken':csrf}};
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
function loginForm(afterLogin) {
  modal('Owner sign in', '<p class="hint">Household viewing stays open. Sign in to manage your inventory.</p>'+field('username','Username','','required autocomplete="username" maxlength="150"')+field('password','Password','','type="password" required autocomplete="current-password" maxlength="1024"'), 'Sign in', async f => { await api('/api/login/',Object.fromEntries(f)); if(afterLogin){$('#dialog').close();afterLogin();}else success('Signed in as owner.'); });
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
    + '<div class="field"><label for="f-context">Anything we should know? (optional)</label><textarea id="f-context" name="context" maxlength="1000" rows="2" placeholder="e.g. I ramble about the shelf too — only the bin contents matter"></textarea></div>'
    + '<p class="hint">Separate from the description above: this steers how your words are read, and never becomes an entry of its own.</p>'
    + '<p class="hint">No photos needed. Your words are sent for AI recognition; the draft is kept until you save or discard it.</p>',
    'Sort it out', async f => {
      const transcript = f.get('transcript').trim();
      if (!transcript) throw Error('Say or type something about the box first.');
      const data = new FormData();
      data.append('transcript', transcript.slice(0, MAX));
      data.append('context', (f.get('context') || '').trim().slice(0, 1000));
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
// Shrink readable photos before upload. If the browser cannot decode one, the server can
// normalize the original JPEG/PNG/HEIC, still subject to server size and pixel limits.
const MAX_EDGE=1536;
async function decodeJpeg(file) {
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
// A stalled browser decoder must not prevent the server from reading a valid original photo.
async function toUploadableJpeg(file) {
  let timer;
  try { return await Promise.race([decodeJpeg(file).catch(()=>null), new Promise(resolve=>{timer=setTimeout(()=>resolve(null),15000);})]); }
  finally { clearTimeout(timer); }
}

const snapInput=$('#snap-photo'), libraryInput=$('#snap-library');
let pendingSnap=null, snapBusy=false;
function snapStatus(message,error=false){
  const status=$('#snap-status');
  status.textContent=message;status.className=error?'error':'hint';status.hidden=false;
}
function snapItem(){
  if(snapBusy)return;
  snapInput.value='';libraryInput.value='';
  snapStatus('Take a photo and choose Use Photo. If the camera does not return it, choose from Photos below.');
  snapInput.click();
}
async function uploadSnap(){
  if(snapBusy||!pendingSnap)return;
  snapBusy=true;
  const button=$('[data-action="snap"]'), retry=$('#snap-retry'), choose=$('#snap-choose');
  button.disabled=retry.disabled=choose.disabled=true;retry.hidden=true;
  const controller=new AbortController();
  let timer;
  try{
    snapStatus('Preparing your photo…');button.textContent='Preparing photo…';
    if(!pendingSnap.file)pendingSnap.file=await toUploadableJpeg(pendingSnap.original)||pendingSnap.original;
    if(pendingSnap.file.size>10*1024*1024)throw Error('This photo is over 10 MB. Choose a smaller copy from Photos.');
    snapStatus('Uploading your photo… Keep this page open.');button.textContent='Uploading photo…';
    timer=setTimeout(()=>controller.abort(),60000);
    // Camera use can suspend a mobile browser for minutes. Check the current session/token.
    const session=await refreshSession(controller.signal);
    if(!session.owner){
      snapStatus('Sign in to finish uploading. Your photo is still selected.',true);retry.hidden=false;
      loginForm(uploadSnap);return;
    }
    const data=new FormData();data.append('photos',pendingSnap.file);data.append('upload_id',pendingSnap.id);
    const saved=await api('/api/drafts/new/',data,'POST',controller.signal);
    snapStatus('Photo received. Opening your draft…');
    location.assign(`/drafts/${saved.id}?analyze=1`);
  }catch(error){
    snapStatus(controller.signal.aborted?'Upload timed out. Your photo is still selected; retry to recover or finish the same draft.':`${error.message} Your photo is still selected.`,true);
    retry.hidden=false;
  }finally{
    clearTimeout(timer);snapBusy=false;
    button.disabled=retry.disabled=choose.disabled=false;button.textContent='Snap an item';
  }
}
function captureSnap(input){
  const file=input.files&&input.files[0];
  if(!file||snapBusy||pendingSnap?.original===file)return;
  pendingSnap={original:file,file:null,id:crypto.randomUUID()};
  uploadSnap();
}
if(snapInput){
  for(const input of [snapInput,libraryInput]){
    input.addEventListener('change',()=>captureSnap(input));
    input.addEventListener('cancel',()=>snapStatus('No new photo selected. Take another photo or choose from Photos.'));
  }
  // Some mobile browser returns deliver focus/visibility before (or without) change.
  const returned=()=>{if(!document.hidden)setTimeout(()=>{captureSnap(snapInput);captureSnap(libraryInput);},500);};
  window.addEventListener('focus',returned);window.addEventListener('pageshow',returned);
  document.addEventListener('visibilitychange',returned);
  $('#snap-retry').onclick=uploadSnap;
  $('#snap-choose').onclick=()=>{snapInput.value='';libraryInput.value='';libraryInput.click();};
}
function uploadForm() {
  const MAX=4, MAX_EACH=10*1024*1024, MAX_TOTAL=25*1024*1024;
  const staged=[], urls=[];
  const identity=f=>`${f.name}:${f.size}:${f.lastModified}`;
  const total=()=>staged.reduce((sum,s)=>sum+s.file.size,0);
  modal('Add from photos', '<p>Lay the items out so each is visible. Include labels where you can.</p><div class="field"><label for="f-photos">Choose photos or take a photo</label><input id="f-photos" name="photos" type="file" accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif" multiple></div><div id="staged-photos" class="staged-grid"></div><p id="staged-note" class="hint"></p><div class="field"><label for="f-context">Anything we should know? (optional)</label><textarea id="f-context" name="context" maxlength="1000" rows="2" placeholder="e.g. mostly FPV drone parts — the loose bags are spare motor screws"></textarea></div><p class="hint">A line of context makes recognition noticeably better. It steers what the AI looks for; it never becomes an entry on its own.</p><p class="hint">Up to 4 photos. Straight from the camera is fine — HEIC and full-resolution shots are shrunk here before upload, so they arrive small and fast. Add them together or a few at a time; each pick joins the batch below. Photos are sent for AI recognition and deleted locally after you save or discard the draft.</p>', 'Upload & review', async f => {
    if(!staged.length) throw Error('Choose at least one photo first.');
    const data=new FormData();
    staged.forEach(s=>data.append('photos',s.file));
    data.append('context',(f.get('context')||'').trim().slice(0,1000));
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
const detailToggle=$('#detail-toggle'), itemList=$('#item-list');
if(detailToggle&&itemList){
  const KEY='inventory-show-details';
  // A per-viewer reading preference, so localStorage rather than anything shared. Reads and writes
  // are guarded: private windows and blocked site data throw here rather than returning null.
  // A wide screen has room for the prose beside the name, so it starts open there and the phone
  // still starts collapsed. Only a stored choice overrides the width -- never the other way round.
  let shown=matchMedia('(min-width:900px)').matches;
  try{const saved=localStorage.getItem(KEY);if(saved!==null)shown=saved==='1';}catch{}
  const apply=()=>{
    itemList.classList.toggle('compact',!shown);
    detailToggle.textContent=shown?'Hide details':'Show details';
    detailToggle.setAttribute('aria-pressed',shown?'true':'false');
  };
  apply();
  detailToggle.addEventListener('click',()=>{
    shown=!shown;
    try{localStorage.setItem(KEY,shown?'1':'0');}catch{}
    apply();
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
    if(action==='snap')snapItem();
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
// Two searches, chosen by the owner rather than guessed at. Keyword search hits the database and is
// instant; smart search reads the saved descriptions and takes seconds, so it is asked for explicitly.
// The old always-AI-first fallback stays for the case where the owner did ask and it is unavailable.
const MODES = {
  name: {title:'Keyword matches', placeholder:'Search by keyword', working:'Searching your boxes…'},
  ai:   {title:'Smart matches', placeholder:'Describe what you need', working:'Analyzing your inventory…'},
};
const mode = () => $('#search-form')?.mode?.value || 'name';
const setMode = value => { const r = $(`.mode-switch input[value="${value}"]`); if (r) { r.checked = true; modeChanged(); } };
// Back from a box lands on the results that sent you there, so the query travels with the link.
const searchQuery = (q, m) => `q=${encodeURIComponent(q)}${m === 'ai' ? '&mode=ai' : ''}`;
// Reuse AI ranking only after checking the current items; locations always come from the server.
const cached = (key, value) => { try { if (value === undefined) return JSON.parse(sessionStorage.getItem(key)); sessionStorage.setItem(key, JSON.stringify(value)); } catch { return null; } };

const working = text => { const p = document.createElement('p'); p.className = 'analyzing'; p.textContent = text; $('#result-list').replaceChildren(p); };

function modeChanged() { $('#query').placeholder = MODES[mode()].placeholder; }

function resultRow(item, ai, q) {
  const where = `<span class="result-where"><span class="group-mark" aria-hidden="true"></span><span>${item.location ? esc(item.location) : 'Unplaced'} <span class="where-sep" aria-hidden="true">/</span> <span class="where-box">Box ${item.box}</span> <span class="where-sep" aria-hidden="true">/</span> ${esc(item.category)}</span></span>`;
  const body = ai ? item.explanation : item.description;
  return `<a class="result-row" href="/box/${item.box}?${searchQuery(q, ai ? 'ai' : 'name')}#item-${item.id}">`
    + `<span class="row-number" aria-hidden="true">${String(item.box).padStart(2, '0')}</span>`
    + `<div class="result-copy"><h3>${esc(item.name)}</h3>${where}`
    + `${body || ai ? `<p>${ai ? '<span class="match-label">Possible match</span>' : ''}${esc(body)}</p>` : ''}</div></a>`;
}

function showResults(q, matches, ai) {
  $('#results-title').textContent = MODES[ai ? 'ai' : 'name'].title;
  $('#results-count').textContent = matches.length ? `${matches.length} found` : '';
  $('#result-list').innerHTML = matches.length
    ? matches.map(i => resultRow(i, ai, q)).join('')
    : `<div class="empty result-empty"><h3>${ai ? 'No close match.' : 'Nothing named that.'}</h3><p>No entry matches “${esc(q)}”.</p>`
      + (ai ? '<p class="hint">Smart search found no close match in the inventory details it received. Try different words, or ask the owner to check.</p>'
            : state.smart_search ? '<div class="actions"><button type="button" id="escalate">Try smart search instead</button></div>'
              + '<p class="hint">A keyword search only matches the words written down. Smart search reads the full descriptions and can work from a rough description.</p>' : '')
      + '</div>';
  if ($('#escalate')) $('#escalate').onclick = () => { setMode('ai'); runSearch(); };
}

let searchVersion = 0;
async function runSearch({restore = false} = {}) {
  const q = $('#query').value.trim(); if (!q) { $('#query').focus(); return; }
  const wanted = mode(), version = ++searchVersion;
  document.body.classList.add('searching');
  history.replaceState(null, '', `/?${searchQuery(q, wanted)}`);
  const key = `ai-search:${q}`;
  const hit = restore && wanted === 'ai' && cached(key);
  $('#search-results').hidden = false;
  working(MODES[wanted].working);
  $('#results-title').textContent = MODES[wanted].title;
  $('#results-count').textContent = '';
  try {
    if (Array.isArray(hit) && hit.length) {
      const current = (await api('/api/search/', undefined, 'GET')).items;
      if (version !== searchVersion) return;
      const byId = new Map(current.map(item => [item.id, item]));
      if (hit.every(item => byId.get(item.id)?.revision === item.revision)) {
        showResults(q, hit.map(item => ({...byId.get(item.id), explanation:item.explanation})), true);
        return;
      }
    }
    let result, ai = wanted === 'ai';
    if (ai) {
      try { result = await api('/api/search/ai/', {question:q}); }
      catch (unavailable) {
        if (version !== searchVersion) return;
        ai = false;
        working('Smart search unavailable — matching keywords instead…');
        result = await api(`/api/search/?q=${encodeURIComponent(q)}`, undefined, 'GET');
      }
    } else result = await api(`/api/search/?q=${encodeURIComponent(q)}`, undefined, 'GET');
    if (version !== searchVersion) return;
    const matches = result.matches || result.items;
    if (ai) cached(key, matches);
    showResults(q, matches, ai);
  } catch (error) { if (version === searchVersion) { $('#result-list').innerHTML = ''; const p = document.createElement('p'); p.className = 'pad'; p.textContent = error.message; $('#result-list').append(p); } }
}
if ($('#search-form')) {
  $('#search-form').addEventListener('submit', e => { e.preventDefault(); runSearch(); });
  // Switching mode with a query already typed re-runs it: the point of the switch is comparing.
  $('.mode-switch')?.addEventListener('change', () => { modeChanged(); if ($('#query').value.trim()) runSearch(); });
  $('#clear-search').onclick = () => { searchVersion++; document.body.classList.remove('searching'); $('#search-results').hidden = true; $('#query').value = ''; history.replaceState(null, '', '/'); $('#query').focus(); };
  // maxlength only constrains typing, so a long dictation must be clipped to the server's 500 limit.
  // Dictation is sentence-shaped, so it always asks the model -- and flips the switch to show why.
  if ($('#search-mic')) micToggle($('#search-mic'), {
    onStart:() => { setMode('ai'); notice('Listening… ask your question, then press the microphone again.'); },
    onText:text => { $('#query').value = text.trim().slice(0, 500); },
    onDone:failure => { if (failure) notice(failure, true); else { $('#notice').hidden = true; if ($('#query').value.trim()) runSearch(); } },
  });
  const params = new URLSearchParams(location.search), q = params.get('q');
  if (params.get('mode') === 'ai') setMode('ai'); else modeChanged();
  if (q) { $('#query').value = q.slice(0, 500); runSearch({restore: true}); }
  if (state.owner) api('/api/drafts/', undefined, 'GET').then(r => { if (r.drafts.length) { $('#draft-list').hidden = false; $('#draft-links').innerHTML = r.drafts.map(d => `<a class="box-row" href="/drafts/${d.id}"><span class="row-number" aria-hidden="true">${String(d.box).padStart(2, '0')}</span><span class="box-copy"><span class="box-category">${d.analyzing ? 'Recognizing…' : 'Continue adding'}</span><span class="box-sub">Box ${d.box} · ${d.analyzing ? 'AI is still working' : 'unfinished draft'}</span></span></a>`).join(''); } }).catch(e => notice(e.message, true));
}

// Every other screen's back arrow goes to the bare index, which threw the results away. When a
// result sent you here it carried its query, so the arrow returns to it instead.
const backLink = $('.topbar a');
if (backLink && new URLSearchParams(location.search).get('q')) {
  backLink.href = '/' + location.search;
  backLink.classList.add('to-results');
  backLink.setAttribute('aria-label', 'Back to search results');
  $('span', backLink).textContent = 'Results';
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
  // Filing control for a draft that has no box yet. It is the one input allowed while recognition
  // runs: /box/ assigns without bumping revision, so it cannot invalidate the result in flight.
  // Both of these stay editable for the life of the draft, including mid-recognition. Filing is not
  // a one-way door: a mis-tap is corrected by picking again, not by saving and moving items after.
  function filingField(){
    const options=state.boxes.map(b=>`<option value="${b.number}" ${b.number===draft.box?'selected':''}>${esc(b.category)} · Box ${b.number}${b.location?` · ${esc(b.location)}`:''}</option>`).join('');
    return `<div class="field filing"><label for="f-draft-box">${draft.box?'Filed in':'Which box does this go in?'}</label><select id="f-draft-box"><option value="">Choose a box…</option>${options}</select></div>`
      + `<div class="field filing"><label for="f-draft-note">Anything we should know? (optional)</label><textarea id="f-draft-note" maxlength="1000" rows="2" placeholder="e.g. mostly FPV drone parts">${esc(draft.context||'')}</textarea><p class="hint">Steers recognition.</p></div>`;
  }
  // A redraw mid-recognition would tear down the live progress panel and orphan its ticker, so while
  // busy we update in place instead. The draw that follows the result renders everything anyway.
  async function saveMeta(fields,element,after){
    element.disabled=true;
    try{
      const updated=await api(`/api/drafts/${draft.id}/meta/`,fields);
      draft.box=updated.box; draft.context=updated.context; draft.duplicates=updated.duplicates;
      after();
      if(!busy&&!draft.analyzing)draw();
    }catch(error){notice(error.message,true);}
    finally{element.disabled=false;}
  }
  function wireFiling(){
    const select=$('#f-draft-box'), note=$('#f-draft-note');
    if(select)select.onchange=()=>{
      const number=Number(select.value);
      if(!number)return;
      saveMeta({box:number},select,()=>{
        notice(`Filed under Box ${number}.`);
        const eyebrow=$('#draft-eyebrow');
        const box=state.boxes.find(b=>b.number===number);
        if(eyebrow&&box)eyebrow.textContent=`${box.category} · Box ${box.number}`;
      });
    };
    // Saved on blur rather than per keystroke: this is a sentence, not a live-edited field, and it
    // must not race the 700ms entry autosave.
    if(note)note.onchange=()=>saveMeta({context:note.value.trim().slice(0,1000)},note,()=>notice('Note saved. It will steer the next recognition.'));
  }
  function drawAnalyzing(){
    const source=draft.photos.length?(draft.transcript?'your photos and description':'your photos'):'what you said';
    editor.innerHTML=`${draft.photos.length?`<div class="photo-grid">${draft.photos.map((url,n)=>`<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Uploaded photo ${n+1}"></a>`).join('')}</div>`:''}<p class="analyzing" aria-live="polite">Recognizing items from ${source}…</p><p class="hint">This keeps running if you close the page — the result is saved to this draft. Entry editing is paused until it lands, but you can still file it and leave a note.</p>${filingField()}<div class="actions">${draft.box?`<a class="button" href="/box/${draft.box}">Open Box ${draft.box}</a>`:''}</div>`;
    wireFiling();
    clearTimeout(poll);
    poll=setTimeout(async()=>{
      try{const filed=draft.box,noted=draft.context;draft=await api(`/api/drafts/${draft.id}/`,undefined,'GET');if(!draft.box&&filed)draft.box=filed;if(!draft.context&&noted)draft.context=noted;rows=draft.entries.map(r=>({...r,selected:false}));dirty=false;draw();}
      // Keep retrying a flaky connection, but a draft that is gone or no longer ours will never
      // come back -- polling it every 3s for the life of an abandoned tab helps nobody.
      catch(error){if(error.status>=400&&error.status<500){notice('This draft is no longer available. Reload the page.',true);return;}drawAnalyzing();}
    },3000);
  }
  function draw(){
    clearTimeout(poll);
    if(draft.analyzing&&!busy)return drawAnalyzing();
    if(draft.state!=='open'||new Date(draft.expires_at)<=new Date()){editor.innerHTML=`<div class="empty"><h3>This draft is ${esc(draft.state==='open'?'expired':draft.state)}.</h3>${draft.box?`<p>Return to the box to see its saved contents.</p><a class="button" href="/box/${draft.box}">Open box</a>`:`<a class="button" href="/">All boxes</a>`}</div>`;return;}
    // ponytail: the transcript is read-only here -- correct the entries it produced instead. Make it
    // editable only if re-recognizing from a fixed-up ramble turns out to be worth a round trip.
    const source=draft.photos.length?(draft.transcript?'photos and description':'photos'):'what you said';
    editor.innerHTML=`${draft.photos.length?`<div class="photo-grid">${draft.photos.map((url,n)=>`<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Uploaded photo ${n+1}"></a>`).join('')}</div>`:''}${draft.transcript?`<div class="transcript-note"><span class="eyebrow">What you said</span><p>${esc(draft.transcript)}</p></div>`:''}<button id="analyze" class="green wide">${rows.length?'Recognize again':`Recognize items from ${source}`}</button><p id="analyze-progress" class="analyzing" hidden aria-live="polite"></p>${filingField()}<div id="draft-rows">${rows.map((r,n)=>`<section class="draft-row" data-row="${n}"><div class="draft-row-top"><label class="check-label"><input type="checkbox" data-select="${n}" ${r.selected?'checked':''}>Select</label><button type="button" class="text-button danger" data-remove="${n}">Remove</button></div><div class="field"><label for="name-${n}">Item or assortment name</label><input id="name-${n}" data-key="name" maxlength="200" value="${esc(r.name)}" required></div><div class="field"><label for="description-${n}">Description</label><textarea id="description-${n}" data-key="description" maxlength="2000">${esc(r.description)}</textarea></div><div class="field"><label for="aliases-${n}">Other names</label><input id="aliases-${n}" data-key="aliases" maxlength="1000" value="${esc(r.aliases)}"></div>${draft.duplicates.includes(n)?'<p class="duplicate">A matching name is already in this box. Review before adding.</p>':''}</section>`).join('')}</div><div class="actions wrap"><button id="add-row">+ Add an entry</button><button id="combine">Merge selected entries</button></div><div class="save-bar"><div class="selection-bar"><label class="check-label"><input type="checkbox" id="draft-select-all">Select all</label><span id="draft-select-count" aria-live="polite"></span></div><p id="save-status" class="save-status" role="status">${dirty?'Unsaved changes':'Draft saved'}</p><div class="actions"><button id="save-draft" class="primary" ${draft.box?'':'disabled'}>${draft.box?`Save to Box ${draft.box}`:'Choose a box to save'}</button><button id="cancel-draft">Discard</button></div><p class="hint">Everything listed here is saved — use Remove to drop an entry. Selecting is only for merging.${draft.photos.length?' Uploaded photos are deleted locally.':''}</p></div>`;
    $('#analyze').onclick=analyze;$('#add-row').onclick=()=>{rows.push({name:'',description:'',aliases:'',selected:false});dirty=true;epoch++;draw();$(`#name-${rows.length-1}`).focus();};
    $('#combine').onclick=()=>{
      const selected=rows.filter(r=>r.selected);
      if(selected.length<2){status('Select at least two entries to merge them.',true);return;}
      const combined={name:selected.map(r=>r.name).join(' + '),description:selected.map(r=>r.description).filter(Boolean).join('\n'),aliases:selected.map(r=>r.aliases).filter(Boolean).join(', '),selected:true};
      if(combined.name.length>200||combined.description.length>2000||combined.aliases.length>1000){
        status('These entries are too long to merge without losing text. Shorten them or keep them separate. Nothing was merged.',true);return;
      }
      if(!confirm(`Merge ${selected.length} selected entries into a single item? This cannot be undone.`))return;
      const first=rows.findIndex(r=>r.selected);
      rows=rows.filter((r,n)=>!r.selected||n===first).map(r=>r.selected?combined:r);changed();draw();
    };
    $('#save-draft').onclick=saveFinal;$('#cancel-draft').onclick=cancel;
    wireFiling();
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
  // Entry fields lock during a run so nothing bumps revision under the result. The filing controls
  // are exempt on purpose: choosing a box and leaving a note are the two things the owner is meant
  // to do *while* waiting, and both save through /meta/, which does not touch revision.
  function disable(on){busy=on;editor.querySelectorAll('button,input,textarea').forEach(e=>{if(!e.closest('.filing'))e.disabled=on;});}
  // The model returns nothing until it has finished reading every photo, so show the wait next to
  // the button that started it. Silence for 30-60 seconds is what reads as a broken server.
  let ticker;
  // Keep slow-provider messaging honest without guessing how much time remains.
  function stage(seconds,count){
    if(seconds<10)return count?`Sending ${count} photo${count===1?'':'s'} to the AI model…`:'Sending your description to the AI model…';
    if(seconds<30)return count?'Analyzing the photos and naming what it sees…':'Working through what you said and naming the items…';
    if(seconds<50)return 'Still working. Busy models take longer — your draft is safe.';
    return 'Still waiting for the AI service. You can return to this draft later.';
  }
  // A retry is where the owner knows what went wrong, so ask instead of a bare yes/no confirm. The
  // modal submit IS the replacement confirmation the server demands, so it still sends replace.
  function analyze(){
    if(busy)return;
    if(!rows.length)return runAnalyze();
    modal('Recognize again',
      '<p class="hint">These suggestions will be replaced. Tell the AI what it got wrong and it will take that into account.</p>'
      + area('context','What was wrong? (optional)',draft.context||'',1000)
      + '<p class="hint">Your photos are analyzed again from scratch — this note guides them, it does not become an entry.</p>',
      'Recognize again', async f => { const note=(f.get('context')||'').trim().slice(0,1000); $('#dialog').close(); runAnalyze(note); });
  }
  async function runAnalyze(note){
    if(busy)return;
    disable(true);
    const button=$('#analyze'), panel=$('#analyze-progress'), label=button.textContent;
    const count=draft.photos.length, started=Date.now();
    panel.hidden=false; panel.className='analyzing';
    const tick=()=>{const seconds=Math.round((Date.now()-started)/1000);button.textContent=`Recognizing… ${seconds}s`;panel.textContent=stage(seconds,count);};
    tick(); ticker=setInterval(tick,1000);
    panel.scrollIntoView({block:'center',behavior:'smooth'});
    try{
      if(dirty)await persist();
      const payload={revision:draft.revision,replace:rows.length>0};
      if(note!==undefined)payload.context=note;
      draft=await api(`/api/drafts/${draft.id}/analyze/`,payload);
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
  async function cancel(){if(busy||!confirm('Discard this draft and delete its uploaded photos?'))return;clearTimeout(timer);disable(true);try{await queue.catch(()=>{});await api(`/api/drafts/${draft.id}/cancel/`,{});dirty=false;success('Draft discarded.',draft.box?`/box/${draft.box}`:'/');}catch(e){status(e.message,true);}finally{disable(false);}}
  editor.addEventListener('input',e=>{const key=e.target.dataset.key;if(!key)return;const n=Number(e.target.closest('[data-row]').dataset.row);rows[n][key]=e.target.value;changed();});
  editor.addEventListener('change',e=>{if(e.target.dataset.select!==undefined){rows[Number(e.target.dataset.select)].selected=e.target.checked;selectionStatus();}});
  editor.addEventListener('click',e=>{const b=e.target.closest('[data-remove]');if(b&&!busy){rows.splice(Number(b.dataset.remove),1);changed();draw();}});
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  draw();
  // Arrived straight from a snap: nothing has been read yet, so start without a second click.
  if(new URLSearchParams(location.search).get('analyze')==='1'&&!rows.length&&!draft.analyzing)runAnalyze();
}
