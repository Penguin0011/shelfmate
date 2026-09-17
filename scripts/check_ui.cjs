const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
(async()=>{
const root=path.resolve(__dirname,'..');process.chdir(root);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'inventory-browser-'));
const python=path.join(root,'.venv/bin/python');
const env={...process.env,DATA_DIR:directory,DEBUG:'1'};
const setup=`from django.contrib.auth import get_user_model
from inventory.models import Box, Item
from PIL import Image
from django.conf import settings
owner=get_user_model().objects.create_user('preview',password='preview-test-only',is_staff=True)
box=Box.objects.create(number=3,category='Fasteners')
Box.objects.create(number=12,category='Drone parts')
Item.objects.create(box=box,name='M3 screw, nut and washer assortment',description='16 mm screws')
Image.new('RGB',(100,100),'white').save(settings.DATA_DIR/'photo.png')`;
for(const args of [['manage.py','migrate','--noinput'],['manage.py','shell','-c',setup]]){
 const result=spawnSync(python,args,{env,stdio:'pipe'});if(result.status!==0)throw Error('Test database setup failed');
}
const port=await new Promise(resolve=>{const socket=net.createServer();socket.listen(0,'127.0.0.1',()=>{const port=socket.address().port;socket.close(()=>resolve(port));});});
const baseURL=`http://127.0.0.1:${port}`;
const server=spawn(python,['manage.py','runserver',`127.0.0.1:${port}`,'--noreload'],{env,stdio:'ignore'});
let browser;
try {
for(let n=0;n<100;n++){try{if((await fetch(baseURL+'/health/')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
browser=await chromium.launch({headless:true,channel:'chrome'});const page=await browser.newPage({viewport:{width:390,height:844},baseURL});const errors=[];page.on('pageerror',e=>errors.push(e.message));const dialogs=[];page.on('dialog',d=>{dialogs.push(d.message());d.accept();});
await page.goto(baseURL);await page.waitForLoadState('networkidle');
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
await page.getByRole('searchbox').fill('M3');await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByRole('heading',{name:'M3 screw, nut and washer assortment'}).waitFor();
await page.getByRole('link').filter({has:page.getByRole('heading',{name:'M3 screw, nut and washer assortment'})}).click();
await page.getByRole('button',{name:'Flag a change',exact:true}).click();await page.getByLabel('Note (optional)').fill('UI check note');await page.getByRole('button',{name:'Send flag'}).click();await page.getByRole('status').filter({hasText:'Flag sent'}).waitFor();
await page.goto(baseURL);
await page.getByRole('button',{name:'Owner sign in'}).click();await page.getByLabel('Username',{exact:true}).fill('preview');await page.getByLabel('Password',{exact:true}).fill('preview-test-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Sign out'}).waitFor();
await page.goto(baseURL+'/box/3');
await page.getByLabel('Box actions').click();await page.getByRole('button',{name:'Add manually'}).click();await page.getByLabel('Item or assortment name',{exact:true}).fill('UI check component');await page.getByLabel('Description (optional)').fill('Readable part description');await page.getByRole('button',{name:'Save item',exact:true}).click();await page.getByRole('heading',{name:'UI check component',exact:true}).waitFor();
await page.locator('article').filter({has:page.getByRole('heading',{name:'UI check component',exact:true})}).getByRole('button',{name:'Edit / move'}).click();await page.getByLabel('Home box').selectOption('12');await page.getByRole('button',{name:'Save item',exact:true}).click();await page.waitForURL('**/box/12');
await page.getByLabel('Box actions').click();await page.getByRole('button',{name:'Add items from photos'}).click();await page.getByLabel('Choose photos or take a photo').setInputFiles(path.join(directory,'photo.png'));await page.getByLabel('Anything we should know? (optional)').fill('mostly FPV drone parts');await page.getByRole('button',{name:'Upload & review'}).click();await page.waitForURL('**/drafts/*');
await page.route('**/api/drafts/*/analyze/',async route=>{const req=route.request().postDataJSON();const id=route.request().url().split('/')[5];const response=await page.request.post(`/api/drafts/${id}/`,{data:{revision:req.revision,entries:[{name:'Suggested connector',description:'Check the size',aliases:'plug'}]},headers:{'X-CSRFToken':await (await page.request.get('/api/session/')).json().then(x=>x.csrfToken)}});await route.fulfill({response});});
await page.getByRole('button',{name:'Recognize items from photos'}).click();await page.getByLabel('Item or assortment name',{exact:true}).waitFor();await page.getByLabel('Item or assortment name',{exact:true}).fill('Reviewed connector');await page.getByRole('status').filter({hasText:'Draft saved'}).waitFor();
await page.reload();await page.getByLabel('Item or assortment name',{exact:true}).waitFor();assert.equal(await page.getByLabel('Item or assortment name',{exact:true}).inputValue(),'Reviewed connector');
// Selecting is for merging only: an unselected entry still saves, so what you see is what you get.
assert.equal(await page.getByRole('checkbox',{name:'Select',exact:true}).isChecked(),false,'entries start unselected; selection only drives merging');
// Retrying asks what went wrong instead of a bare confirm, and keeps the note for the next retry.
let retrySent=null;
await page.route('**/api/drafts/*/analyze/',async route=>{const req=route.request().postDataJSON();retrySent=req.context;const id=route.request().url().split('/')[5];const response=await page.request.post(`/api/drafts/${id}/`,{data:{revision:req.revision,entries:[{name:'Second pass',description:'after the correction',aliases:''}]},headers:{'X-CSRFToken':await (await page.request.get('/api/session/')).json().then(x=>x.csrfToken)}});await route.fulfill({response});});
await page.locator('#analyze').click();
assert.equal(await page.getByLabel('What was wrong? (optional)').inputValue(),'mostly FPV drone parts','the retry note starts from the context already on the draft');
await page.getByLabel('What was wrong? (optional)').fill('these are rivets, not screws');
await page.locator('#dialog-submit').click();
await page.getByRole('status').filter({hasText:/suggestion/}).waitFor();
assert.equal(retrySent,'these are rivets, not screws','the correction must reach the analyze call');
// Whether a second retry still shows the first correction depends on the server persisting it, and
// this analyze call is stubbed before it ever reaches the server -- DraftContextTests covers that.
await page.getByLabel('Item or assortment name',{exact:true}).first().fill('Reviewed connector');await page.getByRole('status').filter({hasText:'Draft saved'}).waitFor();
await page.getByRole('button',{name:'Save to Box 12'}).click();await page.waitForURL('**/box/12');await page.getByRole('heading',{name:'Reviewed connector',exact:true}).waitFor();await page.screenshot({path:path.join(directory,'box-mobile.png'),fullPage:true});
await page.goto(baseURL);await page.getByRole('link',{name:/Inbox/}).click();await page.locator('.flag-row').filter({hasText:'UI check note'}).getByRole('button',{name:'Resolve',exact:true}).first().click();await page.getByRole('status').filter({hasText:'Flag updated.'}).waitFor();
await page.goto(baseURL);await page.getByRole('button',{name:'+ New',exact:true}).click();assert.equal(await page.getByLabel('Box number',{exact:true}).inputValue(),'13','the new-box number is prefilled past the highest existing box');await page.getByLabel('Box number',{exact:true}).fill('21');await page.getByLabel('Category / name').fill('Reusable test');await page.getByLabel('Location (optional)').fill('Office');await page.getByRole('button',{name:'Save box',exact:true}).click();await page.waitForURL('**/box/21');
async function archiveBox(){await page.getByLabel('Box actions').click();await page.getByRole('button',{name:'Edit box',exact:true}).click();await page.getByLabel('Archive this box').check();await page.getByRole('button',{name:'Save box',exact:true}).click();await page.getByRole('button',{name:'Restore / reuse Box 21',exact:true}).waitFor();}
await archiveBox();await page.goto(baseURL);await page.locator('summary').filter({hasText:'Archived boxes'}).click();await page.locator('.archived-boxes a').filter({hasText:'Reusable test'}).click();await page.getByRole('button',{name:'Restore / reuse Box 21',exact:true}).click();await page.getByLabel('Category / name').fill('Restored test');assert.equal(await page.getByLabel('Location (optional)').inputValue(),'Office');await page.getByLabel('Location (optional)').fill('Garage');await page.getByRole('button',{name:'Restore box',exact:true}).click();await page.getByRole('status').filter({hasText:'Box restored'}).waitFor();assert.deepEqual(dialogs,[],'the explicit Restore button must not ask twice');
await archiveBox();await page.goto(baseURL);await page.getByRole('button',{name:'+ New',exact:true}).click();await page.getByLabel('Box number',{exact:true}).fill('21');await page.getByLabel('Category / name').fill('Reassigned test');assert.deepEqual(await page.locator('#room-choices option').evaluateAll(options=>options.map(o=>o.value)),[]);await page.getByLabel('Location (optional)').fill('Closet');await page.getByRole('button',{name:'Save box',exact:true}).click();await page.waitForURL('**/box/21');await page.getByRole('status').filter({hasText:'Box restored'}).waitFor();assert.match(dialogs.at(-1)||'',/archived/i,'reusing an archived number from the create dialog must be confirmed, never silent');await page.getByRole('heading',{name:/Reassigned test/}).waitFor();assert.match(await page.locator('.box-hero>p').textContent(),/Closet/);
// Dictation, driven through a faithful SpeechRecognition stub: ONE instance reused across sessions,
// a cumulative results list that start() resets, an interim result replaced in place by its final
// version, and resultIndex at the first changed slot. No microphone is involved -- what this checks
// is that a pause restarts instead of ending, and that crossing sessions neither duplicates a phrase
// nor runs two of them together. Both are silent failures in a browser that has a working mic.
await page.getByLabel('Box actions').click();await page.getByRole('button',{name:'Add items by talking'}).click();
const spoken=await page.evaluate(()=>{
 let live=null;
 window.SpeechRecognition=class{
  constructor(){live=this;this.results=[];this.slot=0;this.starts=0;}
  start(){this.starts++;this.results=[];this.slot=0;}
  stop(){this.onend();}
  hear(text,isFinal){this.results[this.slot]={0:{transcript:text},isFinal};this.results.length=this.slot+1;this.onresult({resultIndex:this.slot,results:this.results});if(isFinal)this.slot++;}
 };
 const box=document.querySelector('#f-transcript');
 box.value='typed first.';                    // a typed start must survive dictation
 document.querySelector('#dictate').click();
 live.hear('winter gloves',true);
 live.hear(' three pairs',true);
 live.hear(' and a therm',false);             // interim, mid-word
 const withInterim=box.value;
 live.hear(' and a thermos',true);            // finalized in the same slot
 live.onend();                                // the pause: engine ends, listen() must restart
 live.hear('plus the wool scarf',true);       // fresh session, resultIndex back to 0
 document.querySelector('#dictate').click();  // Stop
 return {text:box.value.trim(),withInterim,restarts:live.starts,label:document.querySelector('#dictate-label').textContent};
});
assert.equal(spoken.text,'typed first. winter gloves three pairs and a thermos plus the wool scarf');
assert.match(spoken.withInterim,/and a therm$/,'interim speech must show before it is finalized');
assert.equal(spoken.restarts,2,'a pause for breath must restart the session, not end dictation');
assert.equal(spoken.label,'Start talking','Stop must return the button to its resting state');
await page.getByRole('button',{name:'Cancel'}).click();
await page.goto(baseURL);await page.locator('#search-mic').waitFor({state:'visible'});
// Reopening a draft whose recognition is still running: it must hold still rather than offer an
// editor, because an edit lands a revision bump that would discard the result when it arrives.
const setLock=sql=>{const r=spawnSync(python,['manage.py','shell','-c',sql],{env,stdio:'pipe'});if(r.status!==0)throw Error('lock setup failed: '+r.stderr);};
await page.goto(baseURL+'/box/3');
await page.getByLabel('Box actions').click();await page.getByRole('button',{name:'Add items from photos'}).click();await page.getByLabel('Choose photos or take a photo').setInputFiles(path.join(directory,'photo.png'));await page.getByRole('button',{name:'Upload & review'}).click();await page.waitForURL('**/drafts/*');
setLock("from inventory.models import Draft\nfrom django.utils import timezone\nfrom datetime import timedelta\nDraft.objects.filter(state='open').update(analyzing_until=timezone.now()+timedelta(seconds=60))");
await page.reload();
await page.getByText('Recognizing items from').waitFor();
assert.equal(await page.getByLabel('Item or assortment name',{exact:true}).count(),0,'a running draft must not offer editable rows');
assert.equal(await page.getByRole('button',{name:/Recognize/}).count(),0,'a running draft must not offer to start a second run');
await page.goto(baseURL);
await page.getByText('Recognizing…').waitFor();   // the home draft list says which are still working
await page.goBack();await page.getByText('Recognizing items from').waitFor();
// When the result lands, the open page must pick it up on its own.
setLock("from inventory.models import Draft\nDraft.objects.filter(state='open').update(analyzing_until=None,entries=[{'name':'Recognized later','description':'arrived while away','aliases':''}])");
await page.getByLabel('Item or assortment name',{exact:true}).waitFor({timeout:15000});
assert.equal(await page.getByLabel('Item or assortment name',{exact:true}).inputValue(),'Recognized later','the poll must redraw with the result that landed');
await page.getByRole('button',{name:'Discard'}).click();await page.waitForURL('**/box/3');
// Quick snap from the home screen: one control to the camera, recognition starts on arrival, and the
// box is chosen while it runs. The analyze stub is held open so the filing happens mid-recognition.
let release, snapContext=null;
await page.route('**/api/drafts/*/analyze/',async route=>{
  const req=route.request().postDataJSON();snapContext=req.context;
  const id=route.request().url().split('/')[5];
  await new Promise(done=>{release=done;});
  const response=await page.request.post(`/api/drafts/${id}/`,{data:{revision:req.revision,entries:[{name:'Snapped thing',description:'from the camera',aliases:''}]},headers:{'X-CSRFToken':await (await page.request.get('/api/session/')).json().then(x=>x.csrfToken)}});
  await route.fulfill({response});
});
await page.goto(baseURL);
const chooser=page.waitForEvent('filechooser');
await page.getByRole('button',{name:'Snap an item'}).click();
await (await chooser).setFiles(path.join(directory,'photo.png'));
await page.waitForURL('**/drafts/*analyze=1');
await page.getByText('Recognizing…').first().waitFor();
assert.equal(await page.getByRole('button',{name:'Choose a box to save'}).count(),1,'an unfiled draft cannot be saved yet');
// Pick the box while the model is still reading, which is the point of the flow.
// A mis-tap: file it into the wrong box, then correct it in place. The select must stay on screen.
await page.getByLabel('Which box does this go in?').selectOption('12');
await page.getByRole('status').filter({hasText:'Filed under Box 12'}).waitFor();
assert.equal(await page.locator('#f-draft-box').count(),1,'filing must stay correctable, not vanish once set');
assert.equal(await page.locator('#f-draft-box').isDisabled(),false,'and must stay usable while the model reads');
await page.locator('#f-draft-box').selectOption('3');
await page.getByRole('status').filter({hasText:'Filed under Box 3'}).waitFor();
// Context can be given during the wait, which is what makes a retry cheap instead of retyping.
await page.locator('#f-draft-note').fill('these are rivets');
await page.locator('#f-draft-note').blur();   // saved on blur, as a real user leaving the field would
await page.getByRole('status').filter({hasText:'Note saved'}).waitFor();
release();
await page.getByLabel('Item or assortment name',{exact:true}).first().waitFor({timeout:15000});
assert.equal(await page.getByLabel('Item or assortment name',{exact:true}).first().inputValue(),'Snapped thing','filing mid-run must not discard the recognition');
assert.equal(snapContext,undefined,'the first pass started before any note existed');
// Once the result lands the panel redraws, and the filing control reads as settled rather than asking.
assert.equal(await page.getByLabel('Filed in').count(),1,'a filed draft shows where it is going');
assert.equal(await page.locator('#f-draft-box').inputValue(),'3');
// The note written during the wait is already on the draft, so the retry needs no typing.
await page.locator('#analyze').click();
assert.equal(await page.getByLabel('What was wrong? (optional)').inputValue(),'these are rivets','a note left during the run must arm the retry');
await page.getByRole('button',{name:'Cancel'}).click();
await page.getByRole('button',{name:'Save to Box 3'}).click();
await page.waitForURL('**/box/3');
await page.getByRole('heading',{name:'Snapped thing',exact:true}).waitFor();
// The talking flow carries a note too, kept separate from the words themselves.
await page.goto(baseURL+'/box/3');
await page.getByLabel('Box actions').click();await page.getByRole('button',{name:'Add items by talking'}).click();
await page.getByLabel('What is in the box').fill('a bag of M4 screws and the grey USB hub');
await page.getByLabel('Anything we should know? (optional)').fill('ignore the tangent about the shelf');
await page.getByRole('button',{name:'Sort it out'}).click();
await page.waitForURL('**/drafts/*');
const spokenDraft=await page.evaluate(()=>JSON.parse(document.querySelector('#bootstrap').textContent).draft);
assert.equal(spokenDraft.context,'ignore the tangent about the shelf','the talking flow must send the note');
assert.equal(spokenDraft.transcript,'a bag of M4 screws and the grey USB hub','the note must not be folded into the transcript');
await page.getByRole('button',{name:'Discard'}).click();await page.waitForURL('**/box/3');
// Box contents browse as names by default; the long descriptions are opt-in and the choice sticks.
await page.goto(baseURL+'/box/3');
const blurb=page.locator('.item-row').first().locator('.item-copy p').first();
await page.getByRole('heading',{name:'M3 screw, nut and washer assortment'}).waitFor();
assert.equal(await blurb.isVisible(),false,'descriptions start hidden so a box can be skimmed');
await page.getByRole('button',{name:'Show details'}).click();
assert.equal(await blurb.isVisible(),true);
await page.reload();
await page.getByRole('heading',{name:'M3 screw, nut and washer assortment'}).waitFor();
assert.equal(await page.locator('.item-row').first().locator('.item-copy p').first().isVisible(),true,'the choice must survive a reload');
assert.equal(await page.getByRole('button',{name:'Hide details'}).count(),1);
await page.getByRole('button',{name:'Hide details'}).click();
assert.equal(await page.locator('.item-row').first().locator('.item-copy p').first().isVisible(),false);
// An oversized merge must preserve every original row and never autosave truncated text.
const auditCsrf=(await (await page.request.get('/api/session/')).json()).csrfToken;
const auditHeaders={'X-CSRFToken':auditCsrf};
const createdDraft=await (await page.request.post('/api/boxes/3/drafts/',{multipart:{transcript:'two synthetic parts'},headers:auditHeaders})).json();
const longRows=[{name:'Part A',description:'A'.repeat(1800),aliases:'first'},{name:'Part B',description:'B'.repeat(1800),aliases:'second'}];
await page.request.post(`/api/drafts/${createdDraft.id}/`,{data:{revision:0,entries:longRows},headers:auditHeaders});
await page.goto(baseURL+`/drafts/${createdDraft.id}`);
await page.locator('#draft-select-all').check();
await page.getByRole('button',{name:'Merge selected entries'}).click();
await page.getByText('Nothing was merged.',{exact:false}).waitFor();
assert.equal(await page.locator('.draft-row').count(),2);
assert.equal(await page.locator('#description-1').inputValue(),'B'.repeat(1800));
assert.deepEqual((await (await page.request.get(`/api/drafts/${createdDraft.id}/`)).json()).entries,longRows);

// Cached ranking may be reused, but the box location must always be current.
const cachedItem=(await (await page.request.get('/api/search/')).json()).items.find(i=>i.box===3);
await page.evaluate(item=>sessionStorage.setItem('ai-search:audit cached',JSON.stringify([{...item,explanation:'Check the size'}])),cachedItem);
const boxRevision=await page.evaluate(()=>JSON.parse(document.querySelector('#bootstrap').textContent).box.revision);
await page.request.post('/api/boxes/3/edit/',{data:{revision:boxRevision,category:cachedItem.category,location:'Audit shelf'},headers:auditHeaders});
let auditSearchCalls=0;
await page.route('**/api/search/ai/',async route=>{auditSearchCalls++;await route.fulfill({json:{matches:[]}});});
await page.goto(baseURL+'/?q=audit%20cached&mode=ai');
await page.locator('#result-list').getByText('Audit shelf',{exact:false}).waitFor();
assert.equal(auditSearchCalls,0,'location refresh must not need another AI call');
await page.request.post(`/api/items/${cachedItem.id}/edit/`,{data:{...cachedItem,name:'Updated audit item'},headers:auditHeaders});
await page.reload();
await page.getByText('No close match.',{exact:true}).waitFor();
assert.equal(auditSearchCalls,1,'changed item content invalidates the cached explanation');
await page.unroute('**/api/search/ai/');
// Camera failures: unsupported browser decoding, a lost successful upload response, and retry.
await page.goto(baseURL);
await page.route('**/api/drafts/*/analyze/',route=>route.fulfill({status:503,json:{error:'Synthetic AI offline',draft_preserved:true}}));
await page.evaluate(()=>{
  window.createImageBitmap=async()=>{throw Error('Unsupported camera format');};csrf='stale-before-camera';
  const original=window.fetch.bind(window);let attempts=0;
  window.fetch=async(url,options)=>{
    const response=await original(url,options);
    if(url==='/api/drafts/new/'&&++attempts===1){
      window.auditUploadedId=(await response.clone().json()).id;
      throw TypeError('Simulated connection loss after server commit');
    }
    return response;
  };
});
let uploadedId, cameraPosts=0;
const countCamera=request=>{if(request.url().endsWith('/api/drafts/new/'))cameraPosts++;};
page.on('request',countCamera);
const uploadsBefore=(await (await page.request.get('/api/drafts/')).json()).drafts.length;
const retryChooser=page.waitForEvent('filechooser');
await page.getByRole('button',{name:'Snap an item',exact:true}).click();
const cameraChooser=await retryChooser;
assert(await cameraChooser.element().evaluate(e=>e.isConnected),'camera input stays attached while the native picker is open');
await cameraChooser.setFiles(path.join(directory,'photo.png'));
await page.getByRole('button',{name:'Retry this photo'}).waitFor();
assert.match(await page.locator('#snap-status').textContent(),/photo is still selected/);
uploadedId=await page.evaluate(()=>window.auditUploadedId);assert(uploadedId,'server must have accepted the original photo');
await page.getByRole('button',{name:'Retry this photo'}).click();
await page.waitForURL(`**/drafts/${uploadedId}?analyze=1`);
assert.equal(cameraPosts,2);
assert.equal((await (await page.request.get('/api/drafts/')).json()).drafts.length,uploadsBefore+1,'lost response retry must not create another draft');
page.off('request',countCamera);

// A camera may return with files set but without change; a hanging decoder falls back after 15s.
await page.goto(baseURL);
await page.clock.install();
await page.evaluate(()=>{window.createImageBitmap=()=>new Promise(()=>{});});
const originalPhoto=fs.readFileSync(path.join(directory,'photo.png')).toString('base64');
await page.evaluate(encoded=>{
  const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  const data=new DataTransfer();data.items.add(new File([bytes],'camera.png',{type:'image/png'}));
  document.querySelector('#snap-photo').files=data.files;
  window.dispatchEvent(new Event('focus'));
},originalPhoto);
await page.clock.fastForward(501);
await page.locator('#snap-status').getByText('Preparing your photo…',{exact:true}).waitFor();
await page.clock.fastForward(15001);
await page.waitForURL('**/drafts/*analyze=1');

// A stalled network request ends in a visible retry rather than leaving the button busy forever.
await page.goto(baseURL);
await page.evaluate(()=>{
  const original=window.fetch.bind(window);window.auditFetch=original;
  window.fetch=(url,options)=>url==='/api/drafts/new/'?new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')))):original(url,options);
});
await page.locator('#snap-photo').setInputFiles(path.join(directory,'photo.png'));
await page.getByRole('button',{name:'Uploading photo…',exact:true}).waitFor();
await page.clock.fastForward(60001);
await page.getByRole('button',{name:'Retry this photo'}).waitFor();
assert.match(await page.locator('#snap-status').textContent(),/Upload timed out/);
assert.equal(await page.getByRole('button',{name:'Snap an item',exact:true}).isEnabled(),true);
await page.evaluate(()=>{window.fetch=window.auditFetch;});
await page.getByRole('button',{name:'Retry this photo'}).click();
await page.waitForURL('**/drafts/*analyze=1');
// Session expiry while the camera is open must allow sign-in without losing the selected photo.
await page.goto(baseURL);
const beforeLogout=(await (await page.request.get('/api/session/')).json()).csrfToken;
await page.request.post('/api/logout/',{data:{},headers:{'X-CSRFToken':beforeLogout}});
await page.locator('#snap-photo').setInputFiles(path.join(directory,'photo.png'));
await page.getByRole('dialog').waitFor();
assert.match(await page.locator('#snap-status').textContent(),/Sign in to finish uploading/);
await page.getByLabel('Username',{exact:true}).fill('preview');
await page.getByLabel('Password',{exact:true}).fill('preview-test-only');
await page.getByRole('button',{name:'Sign in',exact:true}).click();
await page.waitForURL('**/drafts/*analyze=1');
// A favicon that 404s looks identical to no favicon, so check it is linked *and* served.
const iconHref=await page.locator('link[rel="icon"]').getAttribute('href');
assert.ok(iconHref&&iconHref.endsWith('.svg'),'the page must link an svg icon');
const icon=await page.request.get(new URL(iconHref,baseURL).href);
assert.equal(icon.status(),200,'the icon must actually be served');
assert.match(icon.headers()['content-type']||'',/svg/);
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);console.log('UI flows passed: search, household flag, login, manual entry/move, photo review/autosave/save-what-you-see, dictation across a pause, flag resolution, archive/restore and number reuse, draft held read-only while recognizing, owner note on upload, talking and retry, snap-then-file, merge limits, cache refresh, camera decode/event/network failure recovery, upload idempotency, session-expiry recovery, favicon served.');} finally {if(browser)await browser.close();server.kill();await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});fs.rmSync(directory,{recursive:true,force:true});}
})();
