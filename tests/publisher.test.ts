import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {openDb} from '../src/db.ts';
import {publish,reconcile} from '../src/publisher.ts';
import {jsonFile} from '../src/local.ts';
import {ProviderError,retryTime} from '../src/buffer.ts';
import type {Post} from '../src/buffer.ts';
const fixture=jsonFile('tests/fixtures/buffer.json');
const options={path:resolve('tests/fixtures/portrait.mp4'),channel:'test',caption:'caption',highlight:'h1',live:true,mode:'shareNow' as const};
function adapter(){
 const post:Post=structuredClone(fixture.post);
 return {provider:{channel:vi.fn(async()=>fixture.channel),create:vi.fn(async()=>post.id),read:vi.fn(async()=>post),matches:vi.fn(async()=>[post])},host:vi.fn(async()=>{}),assetUrl:()=> 'https://example.invalid/asset.mp4',delay:async()=>{},polls:1,post};
}
let db:NonNullable<ReturnType<typeof openDb>>,dir:string;
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'hc-pub-'));vi.stubEnv('HYPECLIP_HOME',dir);db=openDb()!;});
afterEach(()=>{db.close();vi.unstubAllEnvs();rmSync(dir,{recursive:true,force:true});});
it('dry run probes and resolves without uploading or posting',async()=>{
 const a=adapter();const r=await publish(null,{...options,live:false},a);
 expect(r).toMatchObject({state:'dry_run',width:90,height:160});expect(a.host).not.toHaveBeenCalled();expect(a.provider.create).not.toHaveBeenCalled();
});
it('claims once for concurrent IDs with the same video',async()=>{
 const a=adapter();await Promise.all([publish(db,options,a),publish(db,{...options,highlight:'alias'},a)]);
 expect(a.provider.create).toHaveBeenCalledTimes(1);expect(db.prepare('SELECT count(*) n FROM highlights').get()?.n).toBe(2);
 expect(await publish(db,options,a)).toMatchObject({state:'published',sentAt:a.post.sentAt});
});
it.each([['scheduled','automatic','pending'],['draft','automatic','review'],['needs_approval','automatic','review'],['sent','notification','review'],['error','automatic','failed']])('maps %s %s',async(status,type,state)=>{
 const a=adapter();a.post.status=status;a.post.schedulingType=type;expect(await publish(db,options,a)).toMatchObject({state});});
it('reconciles ambiguous create without repeating it',async()=>{
 const a=adapter();a.provider.create.mockRejectedValueOnce(Error('timed out'));expect(await publish(db,options,a)).toMatchObject({state:'needs_reconciliation'});
 a.provider.matches.mockResolvedValueOnce([]);expect(await publish(db,options,a)).toMatchObject({state:'needs_reconciliation'});
 expect(await reconcile(db,1,a)).toMatchObject({state:'published'});expect(a.provider.create).toHaveBeenCalledTimes(1);
});
it('persists a status rate-limit deadline',async()=>{
 const a=adapter();a.provider.read.mockRejectedValueOnce(new ProviderError('HTTP 429',Date.now()+60000));
 expect(await publish(db,options,a)).toMatchObject({state:'pending',remoteId:'post-1'});
 await reconcile(db,1,a);expect(a.provider.read).toHaveBeenCalledTimes(1);expect(retryTime('10',1000)).toBe(11000);expect(retryTime('Thu, 01 Jan 1970 00:01:00 GMT',10)).toBe(60000);
});
