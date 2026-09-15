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
  if (!response.ok) throw Error(result.error || 'Could not complete that request.');
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
  modal(restore ? `Reuse Box ${box.number}` : edit ? 'Edit box' : 'Create or reuse a box', (edit ? `<p class="hint">Box ${box.number} keeps its number and NFC link.</p>` : '<p class="hint">An archived number can be reused. Its existing NFC tag will keep working.</p>'+field('number','Box number','','type="number" min="1" max="2147483647" required inputmode="numeric"')) + field('category','Category / name',edit?box.category:'','required maxlength="120" placeholder="e.g. Drone parts"') + field('location','Location (optional)',edit?box.location:'','maxlength="120" list="room-choices" placeholder="e.g. Office, garage, closet"') + `<datalist id="room-choices">${state.locations.map(name=>`<option value="${esc(name)}"></option>`).join('')}</datalist>` + (edit && !restore ? `<label class="check-label"><input type="checkbox" name="retired" ${box.retired?'checked':''}>Archive this box</label><p class="hint">Move or remove its contents before archiving it.</p>` : ''), restore ? 'Restore box' : 'Save box', async f => {
    const data={category:f.get('category'),location:f.get('location')};
    if(edit) { data.revision=box.revision; data.retired=restore?false:f.has('retired'); }
    else data.number=Number(f.get('number'));
    const saved=await api(edit?`/api/boxes/${box.number}/edit/`:'/api/boxes/create/',data);
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
// Each pick adds to the batch instead of replacing it: iOS pickers often return one photo at a time.
function uploadForm() {
  const MAX=4, MAX_EACH=10*1024*1024, MAX_TOTAL=25*1024*1024;
  const staged=[], urls=[];
  const identity=f=>`${f.name}:${f.size}:${f.lastModified}`;
  const total=()=>staged.reduce((sum,f)=>sum+f.size,0);
  modal('Add from photos', '<p>Lay the items out so each is visible. Include labels where you can.</p><div class="field"><label for="f-photos">Choose photos or take a photo</label><input id="f-photos" name="photos" type="file" accept="image/jpeg,image/png" multiple></div><div id="staged-photos" class="staged-grid"></div><p id="staged-note" class="hint"></p><p class="hint">Up to 4 JPEG or PNG photos, 10 MB each and 25 MB total. Add them together or a few at a time — each pick joins the batch below. For HEIC, export as JPEG first. Photos are sent for AI recognition and deleted locally after you save or discard the draft.</p>', 'Upload & review', async () => {
    if(!staged.length) throw Error('Choose at least one photo first.');
    const data=new FormData();
    staged.forEach(file=>data.append('photos',file));
    const saved=await api(`/api/boxes/${state.box.number}/drafts/`,data);
    location.assign(`/drafts/${saved.id}`);
  });
  const input=$('#f-photos'), grid=$('#staged-photos'), note=$('#staged-note'), error=$('#dialog-error');
  function render() {
    urls.splice(0).forEach(URL.revokeObjectURL);
    grid.innerHTML=staged.map((file,n)=>{ const url=URL.createObjectURL(file); urls.push(url);
      return `<div class="staged-photo"><img src="${url}" alt="${esc(file.name)}"><button type="button" class="remove-photo" data-drop="${n}" aria-label="Remove ${esc(file.name)}">×</button></div>`; }).join('');
    note.innerHTML=staged.length?`<span class="photo-count">${staged.length} of ${MAX} photos ready</span> · ${(total()/1048576).toFixed(1)} MB${staged.length<MAX?' · tap above to add more':''}`:'No photos chosen yet.';
    input.disabled=staged.length>=MAX;
    $('#dialog-submit').textContent=staged.length>1?`Upload ${staged.length} photos & review`:'Upload & review';
  }
  input.addEventListener('change',()=>{
    const problems=[];
    for(const file of input.files) {
      if(staged.length>=MAX){problems.push(`Only ${MAX} photos can go in one batch.`);break;}
      if(staged.some(f=>identity(f)===identity(file)))continue;
      if(file.size>MAX_EACH){problems.push(`${file.name} is over 10 MB.`);continue;}
      if(total()+file.size>MAX_TOTAL){problems.push('Adding that would pass 25 MB in total.');break;}
      staged.push(file);
    }
    // Clearing lets the same file be re-picked after removal, and keeps the control ready for the next pick.
    input.value='';
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
    if(action==='resolve'||action==='dismiss'){button.disabled=true;await api(`/api/flags/${button.dataset.flag}/`,{status:action==='resolve'?'resolved':'dismissed'});success('Flag updated.');}
  } catch(error){notice(error.message,true);button.disabled=false;}
});
if(new URLSearchParams(location.search).has('login'))loginForm();
// Search stays on the index; ordinary search remains available while AI is busy.
let searchVersion=0;
async function runSearch(ai=false) {
  const q=$('#query').value.trim();if(!q){$('#query').focus();return;}
  const version=++searchVersion;
  $('#search-results').hidden=false;$('#result-list').textContent=ai?'Looking through the saved descriptions…':'Searching…';
  $('#results-title').textContent=ai?'AI matches':'Search results';
  $('#ask-ai').disabled=ai;
  try {
    const result=ai?await api('/api/search/ai/',{question:q}):await api(`/api/search/?q=${encodeURIComponent(q)}`,undefined,'GET');
    if(version!==searchVersion)return;
    const matches=result.matches||result.items;
    $('#result-list').innerHTML=matches.length?matches.map(i=>`<a class="result-row" href="/box/${i.box}#item-${i.id}">${ai?'<span class="match-label">Possible match</span>':''}<h3>${esc(i.name)}</h3><span class="box-number">${esc(i.category)} · Box ${i.box}${i.location?` · ${esc(i.location)}`:''}</span><p>${esc(ai?i.explanation:i.description)}</p></a>`).join(''):'<div class="empty"><h3>No matching entries.</h3><p>Try a different name, or ask the owner to check.</p></div>';
    history.replaceState(null,'',`/?q=${encodeURIComponent(q)}`);
  } catch(error){if(version===searchVersion){$('#result-list').innerHTML='';const p=document.createElement('p');p.className='pad';p.textContent=error.message;$('#result-list').append(p);}}
  finally{if(ai)$('#ask-ai').disabled=false;}
}
if($('#search-form')) {
  $('#search-form').addEventListener('submit',e=>{e.preventDefault();runSearch();});$('#ask-ai').onclick=()=>runSearch(true);
  $('#clear-search').onclick=()=>{searchVersion++;$('#search-results').hidden=true;$('#query').value='';history.replaceState(null,'','/');$('#query').focus();};
  const q=new URLSearchParams(location.search).get('q');if(q){$('#query').value=q;runSearch();}
  if(state.owner)api('/api/drafts/',undefined,'GET').then(r=>{if(r.drafts.length){$('#draft-list').hidden=false;$('#draft-links').innerHTML=r.drafts.map(d=>`<a class="box-row" href="/drafts/${d.id}"><span class="box-category">Continue adding to Box ${d.box}</span><span class="arrow">↗</span></a>`).join('');}}).catch(e=>notice(e.message,true));
}

// Keep revisioned draft writes in order. A lost response leaves edits visible for recovery.
if(state.draft) {
  let draft=state.draft, dirty=false, timer, queue=Promise.resolve(), busy=false, epoch=0;
  let rows=draft.entries.map(r=>({...r,selected:false}));
  const editor=$('#draft-editor');
  function status(text,error=false){const n=$('#save-status');if(n){n.textContent=text;n.style.color=error?'var(--rust)':'';}}
  function values(){return rows.map(({selected,...r})=>r);}
  function draw(){
    if(draft.state!=='open'||new Date(draft.expires_at)<=new Date()){editor.innerHTML=`<div class="empty"><h3>This draft is ${esc(draft.state==='open'?'expired':draft.state)}.</h3><p>Return to the box to see its saved contents.</p><a class="button" href="/box/${draft.box}">Open box</a></div>`;return;}
    editor.innerHTML=`<div class="photo-grid">${draft.photos.map((url,n)=>`<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Uploaded photo ${n+1}"></a>`).join('')}</div><button id="analyze" class="green wide">${rows.length?'Recognize again':'Recognize items from photos'}</button><p id="analyze-progress" class="analyzing" hidden aria-live="polite"></p><p class="hint">You can also enter items manually. Review every suggestion before saving.</p><div id="draft-rows">${rows.map((r,n)=>`<section class="draft-row" data-row="${n}"><div class="draft-row-top"><label class="check-label"><input type="checkbox" data-select="${n}" ${r.selected?'checked':''}>Select to combine</label><button type="button" class="text-button danger" data-remove="${n}">Remove</button></div><div class="field"><label for="name-${n}">Item or assortment name</label><input id="name-${n}" data-key="name" maxlength="200" value="${esc(r.name)}" required></div><div class="field"><label for="description-${n}">Description</label><textarea id="description-${n}" data-key="description" maxlength="2000">${esc(r.description)}</textarea></div><div class="field"><label for="aliases-${n}">Other names</label><input id="aliases-${n}" data-key="aliases" maxlength="1000" value="${esc(r.aliases)}"></div>${draft.duplicates.includes(n)?'<p class="duplicate">A matching name is already in this box. Review before adding.</p>':''}</section>`).join('')}</div><div class="actions wrap"><button id="add-row">+ Add an entry</button><button id="combine">Combine selected</button></div><div class="save-bar"><p id="save-status" class="save-status" role="status">${dirty?'Unsaved changes':'Draft saved'}</p><div class="actions"><button id="save-draft" class="primary">Save to Box ${draft.box}</button><button id="cancel-draft">Discard</button></div><p class="hint">Saved entries stay in your inventory. Uploaded photos are deleted locally.</p></div>`;
    $('#analyze').onclick=analyze;$('#add-row').onclick=()=>{rows.push({name:'',description:'',aliases:'',selected:false});dirty=true;epoch++;draw();$(`#name-${rows.length-1}`).focus();};
    $('#combine').onclick=()=>{const selected=rows.filter(r=>r.selected);if(selected.length<2){status('Select at least two entries to combine.',true);return;}const first=rows.findIndex(r=>r.selected);const combined={name:selected.map(r=>r.name).join(' + ').slice(0,200),description:selected.map(r=>r.description).filter(Boolean).join('\n').slice(0,2000),aliases:selected.map(r=>r.aliases).filter(Boolean).join(', ').slice(0,1000),selected:false};rows=rows.filter((r,n)=>!r.selected||n===first).map(r=>r.selected?combined:r);changed();draw();};
    $('#save-draft').onclick=saveFinal;$('#cancel-draft').onclick=cancel;
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
  function stage(seconds,count){
    if(seconds<15)return `Uploading ${count} photo${count===1?'':'s'} to the AI model…`;
    if(seconds<40)return 'Reading the photos and naming what it sees…';
    if(seconds<90)return 'Still working. Detailed photos take longer — your draft is safe.';
    return 'Nearly at the time limit. If this fails, your photos and draft are kept.';
  }
  async function analyze(){
    if(busy)return;
    if(rows.length&&!confirm('Replace these entries with new photo suggestions?'))return;
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
  async function saveFinal(){if(busy)return;if(!rows.length){status('Add at least one entry.',true);return;}disable(true);try{await persist();await api(`/api/drafts/${draft.id}/save/`,{revision:draft.revision});dirty=false;success('Items added to the box.',`/box/${draft.box}`);}catch(e){status(e.message,true);}finally{disable(false);}}
  async function cancel(){if(busy||!confirm('Discard this draft and delete its uploaded photos?'))return;clearTimeout(timer);disable(true);try{await queue.catch(()=>{});await api(`/api/drafts/${draft.id}/cancel/`,{});dirty=false;success('Draft discarded.',`/box/${draft.box}`);}catch(e){status(e.message,true);}finally{disable(false);}}
  editor.addEventListener('input',e=>{const key=e.target.dataset.key;if(!key)return;const n=Number(e.target.closest('[data-row]').dataset.row);rows[n][key]=e.target.value;changed();});
  editor.addEventListener('change',e=>{if(e.target.dataset.select!==undefined)rows[Number(e.target.dataset.select)].selected=e.target.checked;});
  editor.addEventListener('click',e=>{const b=e.target.closest('[data-remove]');if(b&&!busy){rows.splice(Number(b.dataset.remove),1);changed();draw();}});
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  draw();
}
