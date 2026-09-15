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
browser=await chromium.launch({headless:true,channel:'chrome'});const page=await browser.newPage({viewport:{width:390,height:844},baseURL});const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
await page.goto(baseURL);await page.waitForLoadState('networkidle');
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
await page.getByRole('searchbox').fill('M3');await page.getByRole('button',{name:'Search inventory'}).click();await page.getByRole('heading',{name:'M3 screw, nut and washer assortment'}).waitFor();
await page.getByRole('link').filter({has:page.getByRole('heading',{name:'M3 screw, nut and washer assortment'})}).click();
await page.getByRole('button',{name:'Flag a change',exact:true}).click();await page.getByLabel('Note (optional)').fill('UI check note');await page.getByRole('button',{name:'Send flag'}).click();await page.getByRole('status').filter({hasText:'Flag sent'}).waitFor();
await page.getByRole('button',{name:'Owner sign in'}).click();await page.getByLabel('Username',{exact:true}).fill('preview');await page.getByLabel('Password',{exact:true}).fill('preview-test-only');await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('button',{name:'Sign out'}).waitFor();
await page.getByLabel('Box actions').click();await page.getByRole('button',{name:'Add manually'}).click();await page.getByLabel('Item or assortment name',{exact:true}).fill('UI check component');await page.getByLabel('Description (optional)').fill('Readable part description');await page.getByRole('button',{name:'Save item',exact:true}).click();await page.getByRole('heading',{name:'UI check component',exact:true}).waitFor();
await page.locator('article').filter({has:page.getByRole('heading',{name:'UI check component',exact:true})}).getByRole('button',{name:'Edit / move'}).click();await page.getByLabel('Home box').selectOption('12');await page.getByRole('button',{name:'Save item',exact:true}).click();await page.waitForURL('**/box/12');
await page.getByLabel('Box actions').click();await page.getByRole('button',{name:'Add items from photos'}).click();await page.getByLabel('Choose photos or take a photo').setInputFiles(path.join(directory,'photo.png'));await page.getByRole('button',{name:'Upload & review'}).click();await page.waitForURL('**/drafts/*');
await page.route('**/api/drafts/*/analyze/',async route=>{const req=route.request().postDataJSON();const id=route.request().url().split('/')[5];const response=await page.request.post(`/api/drafts/${id}/`,{data:{revision:req.revision,entries:[{name:'Suggested connector',description:'Check the size',aliases:'plug'}]},headers:{'X-CSRFToken':await (await page.request.get('/api/session/')).json().then(x=>x.csrfToken)}});await route.fulfill({response});});
await page.getByRole('button',{name:'Recognize items from photos'}).click();await page.getByLabel('Item or assortment name',{exact:true}).waitFor();await page.getByLabel('Item or assortment name',{exact:true}).fill('Reviewed connector');await page.getByRole('status').filter({hasText:'Draft saved'}).waitFor();
await page.reload();await page.getByLabel('Item or assortment name',{exact:true}).waitFor();assert.equal(await page.getByLabel('Item or assortment name',{exact:true}).inputValue(),'Reviewed connector');
await page.getByRole('button',{name:'Save to Box 12'}).click();await page.waitForURL('**/box/12');await page.getByRole('heading',{name:'Reviewed connector',exact:true}).waitFor();await page.screenshot({path:path.join(directory,'box-mobile.png'),fullPage:true});
await page.getByRole('link',{name:/Flags/}).click();await page.locator('.flag-row').filter({hasText:'UI check note'}).getByRole('button',{name:'Resolve',exact:true}).first().click();await page.getByRole('heading',{name:'Flag inbox.'}).waitFor();
assert.deepEqual(errors,[]);console.log('UI flows passed: search, household flag, login, manual entry/move, photo review/autosave/save, flag resolution.');} finally {if(browser)await browser.close();server.kill();await new Promise(resolve=>{if(server.exitCode!==null)resolve();else server.once('exit',resolve);});fs.rmSync(directory,{recursive:true,force:true});}
})();
