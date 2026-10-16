import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import {createCipheriv,createHash,randomBytes} from 'node:crypto';
import type {Client,Table} from '../src/db';
import type {Article,Evidence,Job,Notice,Publication,RadarEvent} from '../src/lib/types';
import type {WechatDelivery,WechatGrant,WechatReader} from '../src/lib/wechat';
import {createWechatService,defaultWechat,publicationScene,publicationForScene,wechatTemplateData,WECHAT_DISPATCH_BATCH_SIZE,WECHAT_SEND_MAX_PER_SECOND,type WechatStore} from '../src/server/wechat';
import {createWechatProvider,WechatServiceError} from '../src/server/wechat-provider';
import {validateWechatImage} from '../src/server/wechat-image';
const actualPng=await QRCode.toBuffer('https://example.invalid/actual-decodable-fixture',{type:'png',width:430});
// Locally generated, decodable 16x16 RGB JPEG; no external image request is used.
const actualJpeg=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD6pooooA//2Q==','base64');

function memory() {
  let records=new Map<Table,Map<string,unknown>>();
  let tail=Promise.resolve();
  const rows=(table:Table)=>{if(!records.has(table))records.set(table,new Map());return records.get(table)!;};
  const client={query:async(sql:string,params:string[]=[])=>{
    if(sql.includes('count(*)::int AS attempts')&&sql.includes('radar_wechat_deliveries')){
      const times=[...rows('wechat_deliveries').values()].map(value=>(value as WechatDelivery).attemptedAt).filter((at):at is string=>!!at&&at>params[0]).sort();
      return {rows:[{attempts:times.length,oldest:times[0]}],rowCount:1};
    }
    return {rows:[],rowCount:0};
  }} as unknown as Client;
  const store:WechatStore={
    async list<T>(table:Table){return [...rows(table).values()].map(value=>structuredClone(value)) as T[];},
    async one<T>(table:Table,id:string){return structuredClone(rows(table).get(id)) as T|undefined;},
    async put(table,value){rows(table).set(value.id,structuredClone(value));},
    async insert(table,value){if(rows(table).has(value.id))return false;rows(table).set(value.id,structuredClone(value));return true;},
    async transaction<T>(fn:(client:Client)=>Promise<T>) {
      const waiting=tail;let release!:()=>void;tail=new Promise(resolve=>{release=resolve;});await waiting;
      const before=structuredClone(records);try{return await fn(client);}catch(error){records=before;throw error;}finally{release();}
    }
  };return store;
}
async function fixture(overrides:{apiLimit?:number;send?:'ok'|'reject'|'timeout';qr?:'png'|'error'|'truncated';token?:'ok'|'fail';beforeToken?:()=>Promise<void>;beforeCode?:()=>Promise<void>;beforeSend?:()=>Promise<void>;preparePublicPage?:(id:string)=>Promise<void>}={}) {
  const store=memory();let time=Date.parse('2026-10-10T02:00:00Z');const calls:{url:string;body?:Record<string,unknown>}[]=[];
  const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input);assert.equal(new URL(url).origin,'https://api.weixin.qq.com');assert.equal(init?.redirect,'error');const body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({url,body});
    if(url.includes('jscode2session'))return Response.json({openid:new URL(url).searchParams.get('js_code')==='another-code'?'another_openid_123456789':'fixture_openid_123456789',session_key:'do-not-persist-session-key',unionid:'do-not-persist-unionid'});
    if(url.includes('stable_token')){await overrides.beforeToken?.();return overrides.token==='fail'?Response.json({errcode:40125,errmsg:'contains-sensitive-provider-text'}):Response.json({access_token:'fixture_provider_token_1234567890',expires_in:7200});}
    if(url.includes('getwxacodeunlimit')){await overrides.beforeCode?.();return overrides.qr==='error'?Response.json({errcode:41030,errmsg:'invalid page'}):new Response(new Uint8Array(overrides.qr==='truncated'?actualPng.subarray(0,11):actualPng),{headers:{'Content-Type':'image/png'}});}
    if(url.includes('subscribe/send')) {
      await overrides.beforeSend?.();
      if(overrides.send==='timeout')throw new Error('socket unknown with confidential content');
      return Response.json(overrides.send==='reject'?{errcode:43101,errmsg:'user not subscribed'}:{errcode:0,errmsg:'ok'});
    }
    throw new Error('unexpected fixture endpoint');
  }) as typeof fetch;
  const service=createWechatService({store,fetcher,clock:()=>time,encryptionKey:()=>Buffer.alloc(32,7),preparePublicPage:overrides.preparePublicPage??(async()=>{})});
  const configure=async(patch:Record<string,unknown>={})=>{
    const current=await service.adminWechat();return service.saveWechatSettings({...current,appId:'wx0123456789abcdef',qrEnabled:true,subscriptionsEnabled:true,envVersion:'trial',templateId:'actual-template-fixture',templateFields:{title:'thing1',status:'phrase2',time:'time3'},dailyApiLimit:overrides.apiLimit??100,dailyQrLimit:20,dailySendLimit:20,secret:'fixture-secret-not-real',...patch},'fixture-admin');
  };
  await configure();
  const event:RadarEvent={id:'event-fixture',title:'公告称完成',version:1,status:'published',actions:[],evidenceIds:['ev'],publicationId:'pub-legacy-fixture',updatedAt:new Date(time).toISOString()};
  const article:Article={id:'article-fixture',eventId:event.id,title:'公告称完成',summary:'来源公告称对应动作完成。',translation:'',category:'reset',version:1,status:'published',publicationId:event.publicationId,evidenceIds:['ev'],publishedAt:new Date(time).toISOString(),updatedAt:new Date(time).toISOString(),historical:false};
  const publication:Publication={id:event.publicationId,eventId:event.id,articleId:article.id,event,article,cutoffAt:new Date(time).toISOString(),publishedAt:new Date(time).toISOString(),reason:'fixture'};
  const evidence:Evidence={id:'ev',sourceId:'fixture',messageId:'msg',url:'https://example.invalid/source',text:'Original evidence',publishedAt:new Date(time).toISOString(),collectedAt:new Date(time).toISOString(),hash:'fixture',contextComplete:true,historical:false,provenance:'official'};
  await store.put('events',event);await store.put('articles',article);await store.insert('publications',publication);await store.insert('evidence',evidence);
  async function login(code='first-code'){return service.wechatLogin(code);}
  async function accept(token:string) {const challenge=await service.wechatSubscriptionChallenge(token);assert.ok(challenge.nonce);return {challenge,state:await service.confirmWechatSubscription(token,{nonce:challenge.nonce,templateId:challenge.templateId,result:'accept'})};}
  async function notice(patch:Partial<Notice>={}) {time+=1000;const value:Notice={id:`notice-${time}`,eventId:event.id,publicationId:publication.id,semanticKey:`fact-${time}`,title:'重置公告中文标题',summary:'对应公开变化',categories:['result'],status:'active',createdAt:new Date(time).toISOString(),...patch};await store.insert('notices',value);return value;}
  async function queued() {await service.scheduleWechatDeliveries();return (await store.list<Job>('jobs')).filter(job=>job.kind==='wechat_send');}
  return {store,service,calls,fetcher,configure,event,article,publication,evidence,login,accept,notice,queued,advance:(ms:number)=>{time+=ms;},now:()=>time};
}

async function recipients(f:Awaited<ReturnType<typeof fixture>>,count:number){
  const session=await f.login();await f.accept(session.sessionToken);
  const reader=(await f.store.list<WechatReader>('wechat_readers'))[0],grant=(await f.store.list<WechatGrant>('wechat_grants'))[0];
  for(let index=1;index<count;index++){
    const value=`synthetic-recipient-${index}`,iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.alloc(32,7),iv),body=Buffer.concat([cipher.update(value),cipher.final()]);
    const next={...reader,id:`synthetic-reader-${index}`,openidHash:createHash('sha256').update(value).digest('hex'),encryptedOpenid:Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64'),sessions:[]};
    await f.store.put('wechat_readers',next);await f.store.put('wechat_grants',{...grant,id:`synthetic-grant-${index}`,readerId:next.id});
  }
}

test('通知分批建立任务，重复调度不会重复占用授权',async()=>{
  const f=await fixture();await recipients(f,105);await f.notice();
  await f.service.scheduleWechatDeliveries();assert.equal((await f.store.list('jobs')).length,WECHAT_DISPATCH_BATCH_SIZE);
  await f.service.scheduleWechatDeliveries();assert.equal((await f.store.list('jobs')).length,100);
  await f.service.scheduleWechatDeliveries();await f.service.scheduleWechatDeliveries();
  assert.equal((await f.store.list('jobs')).length,105);assert.equal((await f.store.list('wechat_deliveries')).length,105);
});

test('通知限速跨服务实例和重启有效；等待不扣次数、不消耗授权',async()=>{
  const f=await fixture({apiLimit:1000});await f.configure({dailySendLimit:100});await recipients(f,25);await f.notice();const jobs=await f.queued();
  const restarted=createWechatService({store:f.store,fetcher:f.fetcher,clock:f.now,encryptionKey:()=>Buffer.alloc(32,7),preparePublicPage:async()=>{}});
  const results=await Promise.all(jobs.map((job,index)=>(index%2?restarted:f.service).processWechatJob(job)));
  assert.equal(results.filter(result=>result.state==='sent').length,WECHAT_SEND_MAX_PER_SECOND);
  assert.equal(results.filter(result=>result.state==='deferred').length,15);
  assert.equal((await f.service.adminWechat()).sendsToday,10);
  const deferred=(await f.store.list<WechatDelivery>('wechat_deliveries')).filter(row=>row.status==='queued');
  assert.ok(deferred.every(row=>row.attempts===0));assert.equal((await f.store.list<WechatGrant>('wechat_grants')).filter(row=>row.status==='reserved').length,15);
  f.advance(1000);for(const job of jobs)await restarted.processWechatJob(job);
  assert.equal((await f.service.adminWechat()).sendsToday,20);
  f.advance(1000);for(const job of jobs)await restarted.processWechatJob(job);
  assert.equal((await f.service.adminWechat()).sendsToday,25);assert.equal(f.calls.filter(call=>call.url.includes('subscribe/send')).length,25);
});

test('通知页面不可读时先排队，不调用微信、不消耗本次订阅',async()=>{
  const f=await fixture({preparePublicPage:async()=>{throw Error('unavailable');}}),session=await f.login();await f.accept(session.sessionToken);await f.notice();const job=(await f.queued())[0];
  const result=await f.service.processWechatJob(job);assert.equal(result.state,'deferred');assert.equal(Date.parse(result.resumeAt!)-f.now(),5000);
  assert.equal(f.calls.filter(call=>call.url.includes('subscribe/send')||call.url.includes('stable_token')).length,0);
  assert.equal((await f.store.list<WechatDelivery>('wechat_deliveries'))[0].status,'queued');assert.equal((await f.store.list<WechatGrant>('wechat_grants'))[0].status,'reserved');assert.equal((await f.service.adminWechat()).sendsToday,0);
});

test('微信默认关闭不发网络请求；后台不泄漏密钥及读者标识',async()=>{
  const store=memory();let calls=0;const service=createWechatService({store,fetcher:async()=>{calls++;throw new Error('forbidden');},encryptionKey:()=>Buffer.alloc(32)});
  assert.equal((await service.adminWechat()).hasSecret,false);await service.scheduleWechatDeliveries();await assert.rejects(service.wechatLogin('code'),/尚未配置/);assert.equal(calls,0);
  const f=await fixture();await f.login();const safe=JSON.stringify(await f.service.adminWechat()),audit=JSON.stringify(await f.store.list('audits'));
  assert.ok(!safe.includes('fixture-secret'));assert.ok(!safe.includes('openid'));assert.ok(!safe.includes('encryptedSecret'));assert.ok(!audit.includes('fixture-secret'));assert.equal((await f.service.adminWechat()).hasSecret,true);
});

test('32位scene支持旧发布ID，解析精确版本且拒绝非法/未知',async()=>{
  const f=await fixture(),scene=publicationScene(f.publication.id);assert.match(scene,/^[0-9a-f]{32}$/);assert.deepEqual(await f.service.resolveWechatScene(scene),{publicationId:f.publication.id});
  assert.throws(()=>publicationForScene('bad',[f.publication]),/参数无效/);assert.throws(()=>publicationForScene('0'.repeat(32),[f.publication]),/未找到/);
  assert.throws(()=>publicationForScene(scene,[f.publication,f.publication]),/标识冲突/);
});

test('真实码接口使用固定页/scene和环境；重复获取复用缓存；JSON错误不能充作图',async()=>{
  const f=await fixture();const first=await f.service.generateWechatCode(f.publication.id),second=await f.service.generateWechatCode(f.publication.id);
  assert.equal(first.contentType,'image/png');assert.equal(first.publicationId,f.publication.id);assert.ok(first.image.equals(second.image));
  const code=f.calls.filter(call=>call.url.includes('getwxacodeunlimit'));assert.equal(code.length,1);assert.equal(code[0].body?.scene,publicationScene(f.publication.id));assert.equal(code[0].body?.page,'pages/detail/index');assert.equal(code[0].body?.env_version,'trial');assert.equal(code[0].body?.check_path,false);
  const bad=await fixture({qr:'error'});await assert.rejects(bad.service.generateWechatCode(bad.publication.id),/41030/);assert.equal((await bad.service.adminWechat()).codesToday,1);
});

test('体验和开发码允许尚未正式发布的固定详情页，正式码仍检查页面且不自动降级',async()=>{
  const calls:Record<string,unknown>[]=[];
  const provider=createWechatProvider(async(_input,init)=>{
    const body=JSON.parse(String(init?.body));calls.push(body);
    assert.equal(body.page,'pages/detail/index');
    return body.check_path?Response.json({errcode:41030}):new Response(new Uint8Array(actualPng));
  });
  for(const env of ['trial','develop']){
    const result=await provider.code('fixture-token','0'.repeat(32),env);
    assert.equal(result.contentType,'image/png');assert.ok(result.image.equals(actualPng));assert.equal(calls.at(-1)?.env_version,env);
  }
  await assert.rejects(provider.code('fixture-token','0'.repeat(32),'release'),/41030/);
  assert.equal(calls.at(-1)?.check_path,true);assert.equal(calls.length,3);
});

test('当前内容撤回、合并及历史快照撤回都禁止解析和生成',async()=>{
  for(const type of ['event','article','snapshot'] as const) {
    const f=await fixture();if(type==='event')await f.store.put('events',{...f.event,status:'merged'});if(type==='article')await f.store.put('articles',{...f.article,status:'withdrawn'});if(type==='snapshot'){const alternate={...f.publication,id:'pub-retracted',event:{...f.event,status:'withdrawn' as const}};await f.store.insert('publications',alternate);await assert.rejects(f.service.generateWechatCode(alternate.id),/不可分享/);continue;}
    await assert.rejects(f.service.generateWechatCode(f.publication.id),/不可分享/);await assert.rejects(f.service.resolveWechatScene(publicationScene(f.publication.id)),/不可分享/);assert.equal(f.calls.length,0);
  }
});

test('微信身份由服务端交换，openid加密/session仅哈希且过期失效',async()=>{
  const f=await fixture(),session=await f.login(),rows=await f.store.list<WechatReader>('wechat_readers');assert.equal(rows.length,1);
  const raw=JSON.stringify(rows);for(const secret of ['fixture_openid_123456789',session.sessionToken,'do-not-persist-session-key','do-not-persist-unionid'])assert.ok(!raw.includes(secret));
  assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).state,'none');await assert.rejects(f.service.wechatSubscriptionState('fixture_openid_123456789'),/重新打开/);f.advance(8*24*3600_000);await assert.rejects(f.service.wechatSubscriptionState(session.sessionToken),/会话已过期/);
});

test('订阅nonce绑定读者及配置模板，幂等accept至多生成一份授权',async()=>{
  const f=await fixture(),a=await f.login(),b=await f.login('another-code');const challenge=await f.service.wechatSubscriptionChallenge(a.sessionToken);assert.ok(challenge.nonce);
  await assert.rejects(f.service.confirmWechatSubscription(b.sessionToken,{nonce:challenge.nonce,templateId:challenge.templateId,result:'accept'}),/不存在/);
  await assert.rejects(f.service.confirmWechatSubscription(a.sessionToken,{nonce:challenge.nonce,templateId:'forged-template',result:'accept'}),/模板已变化/);
  const results=await Promise.all([1,2,3].map(()=>f.service.confirmWechatSubscription(a.sessionToken,{nonce:challenge.nonce,templateId:challenge.templateId,result:'accept'})));assert.ok(results.every(result=>result.state==='available'));
  const already=await f.service.wechatSubscriptionChallenge(a.sessionToken);assert.ok(already.nonce);assert.equal((await f.service.wechatSubscriptionState(a.sessionToken)).remainingCount,1);assert.equal((await f.store.list<WechatGrant>('wechat_grants')).filter(grant=>grant.status==='available').length,1);
  await f.notice();await Promise.all([f.service.scheduleWechatDeliveries(),f.service.scheduleWechatDeliveries()]);assert.equal((await f.store.list<WechatDelivery>('wechat_deliveries')).length,1);assert.equal((await f.queued()).length,1);
});

test('一次发送成功后仅记录微信接受，重复执行/旧nonce不制造新额度',async()=>{
  const f=await fixture(),session=await f.login(),accepted=await f.accept(session.sessionToken);await f.notice();const job=(await f.queued())[0];assert.ok(job);
  assert.equal((await f.service.processWechatJob(job)).state,'sent');assert.equal((await f.service.processWechatJob(job)).state,'sent');assert.equal(f.calls.filter(call=>call.url.includes('subscribe/send')).length,1);
  assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).state,'consumed');assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).lastResult,'sent');
  const replay=await f.service.confirmWechatSubscription(session.sessionToken,{nonce:accepted.challenge.nonce,templateId:accepted.challenge.templateId,result:'accept'});assert.equal(replay.state,'consumed');
  await f.notice();await f.service.scheduleWechatDeliveries();assert.equal((await f.store.list<WechatDelivery>('wechat_deliveries')).length,1);
  const sent=f.calls.find(call=>call.url.includes('subscribe/send'))!.body!;assert.equal(sent.miniprogram_state,'trial');assert.equal(sent.page,`pages/detail/index?publicationId=${f.publication.id}`);assert.match((sent.data as Record<string,{value:string}>).phrase2.value,/公告称/);
});

test('三次独立accept累积三次机会，按三个不同新提醒依次扣减，旧nonce不能加次数',async()=>{
  const f=await fixture(),session=await f.login(),receipts=[];
  for(let count=1;count<=3;count++){const accepted=await f.accept(session.sessionToken);receipts.push(accepted.challenge);assert.equal(accepted.state.remainingCount,count);}
  const notices=[await f.notice({categories:['announcement']}),await f.notice({categories:['result']}),await f.notice({categories:['correction']})];
  const handled=new Set<string>();
  for(let remaining=2;remaining>=0;remaining--){
    const job=(await f.queued()).find(job=>!handled.has(job.id));assert.ok(job);handled.add(job.id);
    assert.equal((await f.service.processWechatJob(job)).state,'sent');
    assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).remainingCount,remaining);
  }
  await f.notice();assert.equal((await f.queued()).length,3);
  assert.deepEqual((await f.store.list<WechatDelivery>('wechat_deliveries')).map(delivery=>delivery.noticeId),notices.map(notice=>notice.id));
  assert.equal(f.calls.filter(call=>call.url.includes('subscribe/send')).length,3);
  for(const receipt of receipts){const replay=await f.service.confirmWechatSubscription(session.sessionToken,{nonce:receipt.nonce,templateId:receipt.templateId,result:'accept'});assert.equal(replay.remainingCount,0);}
});

test('追加拒绝不清除已有次数，重复回报或客户端传次数不能增发机会',async()=>{
  const f=await fixture(),session=await f.login();await f.accept(session.sessionToken);
  const rejected=await f.service.wechatSubscriptionChallenge(session.sessionToken);
  assert.equal((await f.service.confirmWechatSubscription(session.sessionToken,{nonce:rejected.nonce,templateId:rejected.templateId,result:'reject'})).remainingCount,1);
  assert.equal((await f.service.confirmWechatSubscription(session.sessionToken,{nonce:rejected.nonce,templateId:rejected.templateId,result:'accept',remainingCount:999})).remainingCount,1);
  const fresh=await f.service.wechatSubscriptionChallenge(session.sessionToken);
  const responses=await Promise.all([1,2,3].map(()=>f.service.confirmWechatSubscription(session.sessionToken,{nonce:fresh.nonce,templateId:fresh.templateId,result:'accept',remainingCount:999})));
  assert.ok(responses.every(response=>response.remainingCount===2));
});

test('已排队时追加授权保留原发送绑定，预留次数在发送成功后才扣减',async()=>{
  const f=await fixture(),session=await f.login();await f.accept(session.sessionToken);await f.accept(session.sessionToken);await f.notice();
  const job=(await f.queued())[0],before=await f.service.wechatSubscriptionState(session.sessionToken);assert.equal(before.remainingCount,2);assert.equal(before.pendingCount,1);
  assert.equal((await f.accept(session.sessionToken)).state.remainingCount,3);
  assert.equal((await f.service.processWechatJob(job)).state,'sent');
  assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).remainingCount,2);
  await f.service.processWechatJob(job);assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).remainingCount,2);
});

test('发送前撤回内容会释放预留次数，关闭提醒清空剩余并拒绝未确认旧nonce',async()=>{
  const f=await fixture(),session=await f.login();await f.accept(session.sessionToken);const withdrawn=await f.notice();await f.queued();
  await f.store.put('notices',{...withdrawn,status:'withdrawn'});await f.service.scheduleWechatDeliveries();
  assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).remainingCount,1);
  const pending=await f.service.wechatSubscriptionChallenge(session.sessionToken);
  assert.equal((await f.service.revokeWechatSubscription(session.sessionToken)).remainingCount,0);
  await assert.rejects(f.service.confirmWechatSubscription(session.sessionToken,{nonce:pending.nonce,templateId:pending.templateId,result:'accept'}),/失效/);
  await f.accept(session.sessionToken);assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).remainingCount,1);
  await f.notice();const firstDelivery=(await f.store.list<WechatDelivery>('wechat_deliveries'))[0];const job=(await f.queued()).find(job=>job.payload.deliveryId!==firstDelivery.id);
  assert.ok(job);assert.equal((await f.service.processWechatJob(job)).state,'sent');
});

test('关闭后自动预备与冷启动读取仍显示已关闭，只有新选择才能重新开启',async()=>{
  const f=await fixture(),session=await f.login();await f.accept(session.sessionToken);
  const old=await f.service.wechatSubscriptionChallenge(session.sessionToken);
  assert.equal((await f.service.revokeWechatSubscription(session.sessionToken)).state,'revoked');
  const prepared=await f.service.wechatSubscriptionChallenge(session.sessionToken);
  assert.ok(prepared.nonce);assert.equal(typeof prepared.state,'object');
  assert.equal((prepared.state as {state:string}).state,'revoked');
  await Promise.all(Array.from({length:3},()=>assert.rejects(f.service.confirmWechatSubscription(session.sessionToken,{nonce:old.nonce,templateId:old.templateId,result:'accept'}),{status:409})));
  const cold=await f.login();const restarted=createWechatService({store:f.store,fetcher:f.fetcher,clock:f.now,encryptionKey:()=>Buffer.alloc(32,7),preparePublicPage:async()=>{}});
  assert.equal((await restarted.wechatSubscriptionState(cold.sessionToken)).state,'revoked');
  f.advance(20*60_000);
  const fresh=await restarted.wechatSubscriptionChallenge(cold.sessionToken);
  assert.ok(fresh.nonce);const closed=await restarted.wechatSubscriptionState(cold.sessionToken);
  assert.equal(closed.state,'revoked');assert.equal(closed.remainingCount,0);assert.equal(closed.pendingCount,0);
  await f.notice();await restarted.scheduleWechatDeliveries();assert.equal((await f.store.list('wechat_deliveries')).length,0);
  const reopened=await Promise.all(Array.from({length:3},()=>restarted.confirmWechatSubscription(cold.sessionToken,{nonce:fresh.nonce,templateId:fresh.templateId,result:'accept'})));
  for(const state of reopened){assert.equal(state.state,'available');assert.equal(state.remainingCount,1);}
  assert.equal((await restarted.confirmWechatSubscription(cold.sessionToken,{nonce:fresh.nonce,templateId:fresh.templateId,result:'accept'})).remainingCount,1);
  assert.equal(f.calls.some(call=>call.url.includes('subscribe/send')),false);
});

test('关闭后预备仍受读者绑定、过期与再次关闭保护，不复活已撤销的选择',async()=>{
  const f=await fixture(),session=await f.login();await f.accept(session.sessionToken);await f.service.revokeWechatSubscription(session.sessionToken);
  const fresh=await f.service.wechatSubscriptionChallenge(session.sessionToken),other=await f.login('another-code');
  await assert.rejects(f.service.confirmWechatSubscription(other.sessionToken,{nonce:fresh.nonce,templateId:fresh.templateId,result:'accept'}),/不存在/);
  await f.service.revokeWechatSubscription(session.sessionToken);
  await assert.rejects(f.service.confirmWechatSubscription(session.sessionToken,{nonce:fresh.nonce,templateId:fresh.templateId,result:'accept'}),/失效/);
  const expired=await f.service.wechatSubscriptionChallenge(session.sessionToken);f.advance(5*60_000);
  await assert.rejects(f.service.confirmWechatSubscription(session.sessionToken,{nonce:expired.nonce,templateId:expired.templateId,result:'accept'}),/失效/);
  const closed=await f.service.wechatSubscriptionState(session.sessionToken);assert.equal(closed.state,'revoked');assert.equal(closed.remainingCount,0);
});

test('旧版单次授权只迁移一次，次数不能用于授权之前的消息或活动',async()=>{
  const f=await fixture(),session=await f.login();await f.accept(session.sessionToken);
  const grant=(await f.store.list<WechatGrant>('wechat_grants'))[0];const {credits:_credits,challengeTimes:_times,...legacy}=grant;await f.store.put('wechat_grants',legacy);
  assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).remainingCount,1);
  const oldNotice=await f.notice();await f.accept(session.sessionToken);
  assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).remainingCount,2);
  await f.service.scheduleWechatDeliveries();const first=(await f.queued())[0];assert.ok(first);await f.service.processWechatJob(first);
  assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).remainingCount,1);
  await f.notice({categories:['activity']});await f.service.scheduleWechatDeliveries();assert.equal((await f.queued()).length,1);
  assert.equal((await f.store.list<WechatDelivery>('wechat_deliveries'))[0].noticeId,oldNotice.id);
});

test('多次机会遇到明确拒绝或未知发送均暂停，不把剩余次数继续自动发送',async()=>{
  for(const send of ['reject','timeout'] as const){
    const f=await fixture({send}),session=await f.login();
    for(let count=0;count<3;count++)await f.accept(session.sessionToken);
    await f.notice();const job=(await f.queued())[0];await f.service.processWechatJob(job);
    const state=await f.service.wechatSubscriptionState(session.sessionToken);
    assert.equal(state.state,send==='reject'?'rejected':'unknown');
    assert.equal(state.remainingCount,send==='reject'?0:2);assert.equal(state.pendingCount,0);
    await f.notice();await f.service.scheduleWechatDeliveries();await f.service.processWechatJob(job);
    assert.equal((await f.store.list<WechatDelivery>('wechat_deliveries')).length,1);
    assert.equal(f.calls.filter(call=>call.url.includes('subscribe/send')).length,1);
    if(send==='timeout'){const challenge=await f.service.wechatSubscriptionChallenge(session.sessionToken);assert.equal(challenge.nonce,undefined);}
  }
});

test('追加准备有独立频率限制；过期和已清理旧回执不能制造次数',async()=>{
  const f=await fixture(),session=await f.login(),first=await f.accept(session.sessionToken);
  for(let index=0;index<9;index++)await f.service.wechatSubscriptionChallenge(session.sessionToken);
  await assert.rejects(f.service.wechatSubscriptionChallenge(session.sessionToken),/操作太快/);
  assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).remainingCount,1);
  f.advance(61_000);const expired=await f.service.wechatSubscriptionChallenge(session.sessionToken);f.advance(5*60_000);
  await assert.rejects(f.service.confirmWechatSubscription(session.sessionToken,{nonce:expired.nonce,templateId:expired.templateId,result:'accept'}),/失效/);
  await f.notice();await f.service.processWechatJob((await f.queued())[0]);
  f.advance(16*60_000);await f.accept(session.sessionToken);
  await assert.rejects(f.service.confirmWechatSubscription(session.sessionToken,{nonce:first.challenge.nonce,templateId:first.challenge.templateId,result:'accept'}),/失效/);
  assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).remainingCount,1);
});

test('微信43101拒绝不自动恢复授权或再次发送',async()=>{
  const f=await fixture({send:'reject'}),session=await f.login();await f.accept(session.sessionToken);await f.notice();const job=(await f.queued())[0];assert.equal((await f.service.processWechatJob(job)).state,'rejected');await f.service.scheduleWechatDeliveries();await f.service.processWechatJob(job);
  assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).state,'rejected');assert.equal((await f.store.list<WechatDelivery>('wechat_deliveries'))[0].errorCode,43101);assert.equal(f.calls.filter(call=>call.url.includes('subscribe/send')).length,1);
});

test('网络未知及服务退出遗留sending均停止重发，不能冒充成功',async()=>{
  const f=await fixture({send:'timeout'}),session=await f.login();await f.accept(session.sessionToken);await f.notice();const job=(await f.queued())[0];assert.equal((await f.service.processWechatJob(job)).state,'unknown');assert.equal((await f.service.processWechatJob(job)).state,'unknown');assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).state,'unknown');assert.equal(f.calls.filter(call=>call.url.includes('subscribe/send')).length,1);
  const restarted=await fixture(),s=await restarted.login();await restarted.accept(s.sessionToken);await restarted.notice();const old=(await restarted.queued())[0],delivery=(await restarted.store.list<WechatDelivery>('wechat_deliveries'))[0];await restarted.store.put('wechat_deliveries',{...delivery,status:'sending'});assert.equal((await restarted.service.processWechatJob(old)).state,'unknown');assert.equal(restarted.calls.filter(call=>call.url.includes('subscribe/send')).length,0);
});

test('用户取消及消息撤回取消队列，发送前不会消耗真实授权',async()=>{
  for(const action of ['user','notice','event'] as const) {
    const f=await fixture(),session=await f.login();await f.accept(session.sessionToken);const notice=await f.notice();const job=(await f.queued())[0];
    if(action==='user')await f.service.revokeWechatSubscription(session.sessionToken);if(action==='notice')await f.store.put('notices',{...notice,status:'withdrawn'});if(action==='event')await f.store.put('events',{...f.event,status:'withdrawn'});
    await f.service.scheduleWechatDeliveries();assert.equal((await f.service.processWechatJob(job)).state,'cancelled');assert.equal(f.calls.filter(call=>call.url.includes('subscribe/send')).length,0);
  }
});

test('授权前旧消息与历史补录不补发，重要更正保留资格',async()=>{
  const f=await fixture();await f.notice();const session=await f.login();await f.accept(session.sessionToken);f.advance(1);assert.equal((await f.queued()).length,0);
  await f.store.put('evidence',{...f.evidence,publishedAt:'2026-03-01T00:00:00Z',historical:false});await f.notice();assert.equal((await f.queued()).length,0);
  await f.notice({categories:['correction']});assert.equal((await f.queued()).length,1);
});

test('预算耗尽只在发送前暂缓，失败凭据请求也计入调用上限',async()=>{
  const f=await fixture({apiLimit:1}),session=await f.login();await f.accept(session.sessionToken);await f.notice();const job=(await f.queued())[0],result=await f.service.processWechatJob(job);assert.equal(result.state,'deferred');assert.equal(result.resumeAt,'2026-10-10T16:00:00.000Z');assert.equal(f.calls.filter(call=>call.url.includes('subscribe/send')).length,0);assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).state,'reserved');
  const bad=await fixture({apiLimit:2,token:'fail'});await assert.rejects(bad.service.generateWechatCode(bad.publication.id),/40125/);await assert.rejects(bad.service.generateWechatCode(bad.publication.id),/40125/);await assert.rejects(bad.service.generateWechatCode(bad.publication.id),/调用上限/);assert.equal(bad.calls.length,2);assert.equal((await bad.service.adminWechat()).callsToday,2);
});

test('模板字段严格限制，完成限定词保留且按五字phrase/二十字thing输出',()=>{
  const settings={...defaultWechat,templateFields:{title:'thing1',status:'phrase2',time:'time3'}};
  const notice={id:'n',eventId:'e',publicationId:'p',semanticKey:'s',status:'active',categories:['result'],title:'无限长标题'.repeat(10),summary:'',createdAt:'2026-10-10T02:00:00Z'} satisfies Notice;
  const data=wechatTemplateData(settings,notice);assert.ok(Array.from(data.thing1.value).length<=20);assert.match(data.thing1.value,/^公告称完成/);assert.equal(data.phrase2.value,'公告称完成');assert.equal(data.time3.value,'2026-10-10 10:00');
  assert.throws(()=>wechatTemplateData({...settings,templateFields:{title:'name1',status:'phrase2',time:'time3'}},notice),/不兼容/);assert.throws(()=>wechatTemplateData({...settings,templateFields:{title:'thing1',status:'thing1',time:'time3'}},notice),/不兼容/);
});

test('额度重置模板使用公开福利类型和阶段，混合阶段不冒称全部完成',async()=>{
  const f=await fixture(),settings={...defaultWechat,templateFields:{title:'thing1',status:'thing3',time:'time5'}};
  const notice=await f.notice({title:'不应复制到额度类型的整条公告标题'});
  const action=(kind:'automatic_reset'|'banked_reset',stage:RadarEvent['actions'][number]['stage'],scope:RadarEvent['actions'][number]['scope']='public'):RadarEvent['actions'][number]=>({id:`${kind}-${scope}`,kind,stage,scope,eligibility:'以公开来源为准',evidenceIds:['ev'],statementAt:new Date(f.now()).toISOString()});
  for(const row of [
    {actions:[action('automatic_reset','promised')],type:'编程套餐额度',stage:'已公布计划'},
    {actions:[action('banked_reset','claimed_complete')],type:'重置卡',stage:'公告称完成'},
    {actions:[action('automatic_reset','in_progress')],type:'编程套餐额度',stage:'公告称进行中'},
    {actions:[action('banked_reset','cancelled')],type:'重置卡',stage:'公告已取消'},
    {actions:[action('automatic_reset','claimed_complete'),action('banked_reset','promised')],type:'用量重置与重置卡',stage:'公开进展更新'},
    {actions:[action('automatic_reset','promised'),action('banked_reset','claimed_complete','private')],type:'编程套餐额度',stage:'已公布计划'},
  ]){
    const publication={...f.publication,event:{...f.publication.event,actions:row.actions}};
    const data=wechatTemplateData(settings,notice,publication);
    assert.deepEqual(data,{thing1:{value:row.type},thing3:{value:row.stage},time5:{value:'2026-10-10 10:00'}});
    assert.doesNotMatch(JSON.stringify(data),/到账|所有账户|整条公告标题/);
  }
  const mixed={...f.publication,event:{...f.publication.event,actions:[action('automatic_reset','claimed_complete'),action('banked_reset','promised')]}};
  const phrase=wechatTemplateData({...settings,templateFields:{...settings.templateFields,status:'phrase3'}},notice,mixed);
  assert.equal(phrase.phrase3.value,'进展已更新');assert.ok(Array.from(phrase.phrase3.value).length<=5);
  assert.equal(wechatTemplateData(settings,{...notice,categories:['correction']},mixed).thing3.value,'公告更正');
  assert.throws(()=>wechatTemplateData(settings,{...notice,publicationId:'different-fixed-version'},mixed),/不属于额度重置/);
});

test('额度模板拒绝纯活动、产品和仅私有福利，不消耗可用订阅',async()=>{
  for(const category of ['activity','product'] as const){
    const f=await fixture(),session=await f.login();await f.accept(session.sessionToken);
    const pub={...f.publication,article:{...f.publication.article,category}};
    await f.store.put('publications',pub);const notice=await f.notice({categories:['activity']});
    assert.throws(()=>wechatTemplateData({...defaultWechat,templateFields:{title:'thing1',status:'thing3',time:'time5'}},notice,pub),/不属于额度重置/);
    assert.equal((await f.queued()).length,0);assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).state,'available');
    assert.equal(f.calls.filter(call=>call.url.includes('stable_token')||call.url.includes('subscribe/send')).length,0);
  }
  const f=await fixture(),notice=await f.notice();
  const privateOnly={...f.publication,event:{...f.publication.event,actions:[{id:'private',kind:'banked_reset',stage:'claimed_complete',scope:'private',eligibility:'定向对象',evidenceIds:['ev'],statementAt:new Date(f.now()).toISOString()} satisfies RadarEvent['actions'][number]]}};
  assert.throws(()=>wechatTemplateData({...defaultWechat,templateFields:{title:'thing1',status:'thing3',time:'time5'}},notice,privateOnly),/不属于额度重置/);
});

test('真实发送路径的替身使用thing1、thing3、time5及对应发布版本，不读取公告标题作额度类型',async()=>{
  const f=await fixture();await f.configure({templateFields:{title:'thing1',status:'thing3',time:'time5'}});
  f.publication.event.actions=[{id:'public-reset',kind:'automatic_reset',stage:'promised',scope:'public',eligibility:'以公开来源为准',evidenceIds:['ev'],statementAt:new Date(f.now()).toISOString()}];
  await f.store.put('publications',f.publication);
  const session=await f.login();await f.accept(session.sessionToken);await f.notice({categories:['announcement'],title:'不应发送到额度类型的长标题'});
  const jobs=await f.queued();assert.equal(jobs.length,1);assert.equal((await f.service.processWechatJob(jobs[0])).state,'sent');
  const body=f.calls.find(call=>call.url.includes('subscribe/send'))!.body!;
  assert.deepEqual(body.data,{thing1:{value:'编程套餐额度'},thing3:{value:'已公布计划'},time5:{value:'2026-10-10 10:00'}});
  assert.equal(body.page,`pages/detail/index?publicationId=${f.publication.id}`);
});

test('已排队额度提醒在发送前失去重置内容时取消，不调用微信发送',async()=>{
  const f=await fixture(),session=await f.login();await f.accept(session.sessionToken);await f.notice();
  const [job]=await f.queued();assert.ok(job);
  await f.store.put('publications',{...f.publication,article:{...f.publication.article,category:'product'}});
  assert.equal((await f.service.processWechatJob(job)).state,'cancelled');
  assert.equal(f.calls.filter(call=>call.url.includes('stable_token')||call.url.includes('subscribe/send')).length,0);
});

test('provider不会回传含密钥的网络错误/URL，未明确errcode零不判成功',async()=>{
  const failed=createWechatProvider(async()=>{throw new Error('SECRET_QUERY_URL_OPENID');});await assert.rejects(failed.send('token-secret',{touser:'private'}),(error:unknown)=>error instanceof WechatServiceError&&error.failureKind==='unknown'&&!error.message.includes('SECRET'));
  const invalid=createWechatProvider(async()=>Response.json({errmsg:'ok'}));await assert.rejects(invalid.send('token-secret',{}),(error:unknown)=>error instanceof WechatServiceError&&error.failureKind==='unknown');
});

test('连接失败区分证书、域名、超时和网络错误，登录不重试且不回传原始错误',async()=>{
  const privateMarker='fixture-private-request-url';
  const cause=(code:string)=>Object.assign(new Error(privateMarker),{code});
  const cases:[unknown,string][]=[
    [new TypeError(privateMarker,{cause:cause('UNABLE_TO_VERIFY_LEAF_SIGNATURE')}),'微信接口证书校验失败（UNABLE_TO_VERIFY_LEAF_SIGNATURE），请联系站长检查云端证书配置'],
    [new TypeError(privateMarker,{cause:new AggregateError([cause('SELF_SIGNED_CERT_IN_CHAIN')],privateMarker)}),'微信接口证书校验失败（SELF_SIGNED_CERT_IN_CHAIN），请联系站长检查云端证书配置'],
    [new TypeError(privateMarker,{cause:cause('ENOTFOUND')}),'微信接口域名解析失败，请稍后重试'],
    [new DOMException(privateMarker,'TimeoutError'),'微信接口连接超时，请稍后重试'],
    [new TypeError(privateMarker,{cause:new AggregateError([cause('ETIMEDOUT')],privateMarker)}),'微信接口连接超时，请稍后重试'],
    [new TypeError(privateMarker,{cause:cause('ECONNRESET')}),'微信接口网络连接失败，请稍后重试'],
    [new Error(privateMarker),'微信接口暂时无法连接'],
  ];
  for(const [failure,message] of cases) {
    let attempts=0;const provider=createWechatProvider(async()=>{attempts++;throw failure;});
    await assert.rejects(provider.login('fixture-app','fixture-secret','fixture-code'),(error:unknown)=>{
      assert.ok(error instanceof WechatServiceError);assert.equal(error.status,503);assert.equal(error.failureKind,'transient');assert.equal(error.message,message);
      assert.equal(error.errorCode,undefined);assert.equal(error.cause,undefined);assert.ok(!JSON.stringify(error).includes(privateMarker));return true;
    });assert.equal(attempts,1);
  }
});

test('证书诊断仅显示固定白名单码，不接受含请求数据的伪造码，多项错误按固定顺序分类',async()=>{
  const privateMarker='fixture-private-request-url';
  const failure=(code:string)=>new TypeError(privateMarker,{cause:Object.assign(new Error(privateMarker),{code})});
  for(const code of ['CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','ERR_TLS_CERT_ALTNAME_INVALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY']){
    const provider=createWechatProvider(async()=>{throw failure(code);});
    await assert.rejects(provider.login('fixture-app','fixture-secret','fixture-code'),(error:unknown)=>{
      assert.ok(error instanceof WechatServiceError);assert.equal(error.status,503);assert.equal(error.failureKind,'transient');
      assert.equal(error.message,`微信接口证书校验失败（${code}），请联系站长检查云端证书配置`);
      assert.equal(error.errorCode,undefined);assert.equal(error.cause,undefined);assert.ok(!JSON.stringify(error).includes(privateMarker));return true;
    });
  }
  const malformed=createWechatProvider(async()=>{throw failure('CERT_HAS_EXPIRED?'+privateMarker);});
  await assert.rejects(malformed.login('fixture-app','fixture-secret','fixture-code'),(error:unknown)=>error instanceof WechatServiceError&&error.message==='微信接口暂时无法连接'&&!JSON.stringify(error).includes(privateMarker));
  const aggregate=createWechatProvider(async()=>{throw new AggregateError([failure('SELF_SIGNED_CERT_IN_CHAIN'),failure('CERT_HAS_EXPIRED')],privateMarker);});
  await assert.rejects(aggregate.login('fixture-app','fixture-secret','fixture-code'),(error:unknown)=>error instanceof WechatServiceError&&error.message==='微信接口证书校验失败（CERT_HAS_EXPIRED），请联系站长检查云端证书配置');
});

test('连接诊断不会把不明确的发送改成可重试失败，循环cause也不阻塞',async()=>{
  const failure:Error&{code:string;cause?:unknown}=Object.assign(new Error('fixture-private-request-url'),{code:'SELF_SIGNED_CERT_IN_CHAIN'});failure.cause=failure;
  let attempts=0;const provider=createWechatProvider(async()=>{attempts++;throw failure;});
  await assert.rejects(provider.send('fixture-token',{}),(error:unknown)=>error instanceof WechatServiceError&&error.failureKind==='unknown'&&error.message==='微信发送结果未知，已停止自动重发');
  assert.equal(attempts,1);
});

test('并发二维码请求合并真实调用，独立服务进程也不能穿透生成租约',async()=>{
  let release!:()=>void,entered!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const f=await fixture({beforeCode:async()=>{entered();await hold;}});
  const a=f.service.generateWechatCode(f.publication.id);await started;
  const b=f.service.generateWechatCode(f.publication.id);
  let foreignCalls=0;const other=createWechatService({store:f.store,clock:f.now,encryptionKey:()=>Buffer.alloc(32,7),fetcher:async()=>{foreignCalls++;throw new Error('must not run');}});
  await assert.rejects(other.generateWechatCode(f.publication.id),/正在生成/);release();const result=await Promise.all([a,b]);assert.ok(result[0].image.equals(result[1].image));assert.equal(f.calls.filter(call=>call.url.includes('getwxacodeunlimit')).length,1);assert.equal(foreignCalls,0);assert.equal((await f.service.adminWechat()).codesToday,1);
});

test('准备发送期间读者取消，最终锁内重查授权阻止请求',async()=>{
  let revoke!:()=>Promise<void>;const f=await fixture({beforeToken:async()=>revoke()});const session=await f.login();await f.accept(session.sessionToken);await f.notice();const job=(await f.queued())[0];revoke=async()=>{await f.service.revokeWechatSubscription(session.sessionToken);};
  assert.equal((await f.service.processWechatJob(job)).state,'cancelled');assert.equal(f.calls.filter(call=>call.url.includes('subscribe/send')).length,0);assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).state,'revoked');
});

test('并发撤销与调度不能将已撤销授权覆盖为reserved',async()=>{
  const f=await fixture(),session=await f.login();await f.accept(session.sessionToken);await f.notice();await Promise.all([f.service.scheduleWechatDeliveries(),f.service.revokeWechatSubscription(session.sessionToken),f.service.scheduleWechatDeliveries()]);assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).state,'revoked');
  for(const job of await f.queued())assert.equal((await f.service.processWechatJob(job)).state,'cancelled');assert.equal(f.calls.filter(call=>call.url.includes('subscribe/send')).length,0);
});

test('旧发送迟到回包不覆盖读者后来取消/新授权，重复执行也不会重复调用',async()=>{
  let release!:()=>void,entered!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});const f=await fixture({beforeSend:async()=>{entered();await hold;}}),session=await f.login();await f.accept(session.sessionToken);await f.notice();const job=(await f.queued())[0];const sending=f.service.processWechatJob(job);await started;
  const duplicate=await f.service.processWechatJob(job);assert.equal(duplicate.state,'deferred');await f.service.revokeWechatSubscription(session.sessionToken);f.advance(31_000);await f.accept(session.sessionToken);release();assert.equal((await sending).state,'sent');assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).state,'available');assert.equal(f.calls.filter(call=>call.url.includes('subscribe/send')).length,1);
});

test('unknown结果不能通过取消再报告accept绕过',async()=>{
  const f=await fixture({send:'timeout'}),session=await f.login();await f.accept(session.sessionToken);await f.notice();await f.service.processWechatJob((await f.queued())[0]);await f.service.revokeWechatSubscription(session.sessionToken);f.advance(31_000);const challenge=await f.service.wechatSubscriptionChallenge(session.sessionToken);assert.equal(challenge.state,'unknown');assert.equal(challenge.nonce,undefined);assert.equal((await f.store.list<WechatDelivery>('wechat_deliveries')).length,1);
});

test('二维码外部响应期间切换配置，不返回其他账号/版本的码',async()=>{
  let change!:()=>Promise<void>;const f=await fixture({beforeCode:async()=>change()});change=async()=>{await f.configure({envVersion:'develop'});};await assert.rejects(f.service.generateWechatCode(f.publication.id),/已变化/);assert.equal((await f.service.adminWechat()).codesToday,1);
});

test('PNG必须含完整有效chunk和可解压图像，截断不能返回或缓存',async()=>{
  assert.equal(validateWechatImage(actualPng),'image/png');
  for(const length of [8,11,32,actualPng.length-1,actualPng.length-12])assert.throws(()=>validateWechatImage(actualPng.subarray(0,length)),/不完整/);
  const corrupt=Buffer.from(actualPng);corrupt[corrupt.length-15]^=1;assert.throws(()=>validateWechatImage(corrupt),/不完整/);
  const f=await fixture({qr:'truncated'});await assert.rejects(f.service.generateWechatCode(f.publication.id),/不完整/);
  assert.equal((await f.store.list<{id:string;base64?:string}>('settings')).filter(record=>record.id.startsWith('wechat_code_')&&record.base64).length,0);
});

test('流读取超过2MB立刻取消，不先读完整响应',async()=>{
  let cancelled=false,pulls=0;const stream=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(700_000));},cancel(){cancelled=true;}});
  const provider=createWechatProvider(async()=>new Response(stream));await assert.rejects(provider.code('fixture-token','0'.repeat(32),'trial'),/内容过大/);assert.equal(cancelled,true);assert.ok(pulls<=4);
});

test('匿名登录分钟限频与日额度分离，不耗尽二维码/发送总额度',async()=>{
  const f=await fixture({apiLimit:100});for(let index=0;index<10;index++)await f.login();await assert.rejects(f.login(),/登录调用已达限制/);assert.equal(f.calls.length,10);f.advance(60_001);await f.login();
  await f.service.generateWechatCode(f.publication.id);assert.equal((await f.service.adminWechat()).codesToday,1);
  const limited=await fixture({apiLimit:4});await limited.login();await assert.rejects(limited.login(),/登录调用已达限制/);await limited.service.generateWechatCode(limited.publication.id);assert.equal((await limited.service.adminWechat()).callsToday,3);
  const store=memory();let failures=0;const failed=createWechatService({store,encryptionKey:()=>Buffer.alloc(32,7),clock:f.now,fetcher:async()=>{failures++;return Response.json({errcode:40029});}});
  const original=await f.store.one<{id:string}>('settings','wechat');await store.put('settings',original!);for(let index=0;index<10;index++)await assert.rejects(failed.wechatLogin('invalid-code'));await assert.rejects(failed.wechatLogin('invalid-code'),/登录调用已达限制/);assert.equal(failures,10);
});

test('JPEG必须有合法尺寸/扫描和完整EOI，响应类型不靠声明猜测',async()=>{
  assert.equal(validateWechatImage(actualJpeg),'image/jpeg');for(const length of [3,6,32,actualJpeg.length-1,actualJpeg.length-2])assert.throws(()=>validateWechatImage(actualJpeg.subarray(0,length)),/不完整/);
  const provider=createWechatProvider(async()=>new Response(new Uint8Array(actualJpeg),{headers:{'Content-Type':'application/octet-stream'}}));assert.equal((await provider.code('fixture-token','0'.repeat(32),'trial')).contentType,'image/jpeg');
});

test('date模板只包含日期，time模板保留日期和时分',()=>{
  const settings={...defaultWechat,templateFields:{title:'thing1',status:'phrase2',time:'date3'}};
  const notice={id:'n',eventId:'e',publicationId:'p',semanticKey:'s',status:'active',categories:['result'],title:'公告称完成',summary:'',createdAt:'2026-10-10T02:00:00Z'} satisfies Notice;
  assert.equal(wechatTemplateData(settings,notice).date3.value,'2026-10-10');
});


test('公开入口检查只返回开放状态，不调用微信、不预留额度或写入记录',async()=>{
  const f=await fixture();
  const before=await f.store.list('settings');
  assert.deepEqual(await f.service.publicWechatAvailability(),{available:true,codeAvailable:true});
  assert.equal(f.calls.length,0);
  assert.deepEqual(await f.store.list('settings'),before);
  const config=await f.store.one<typeof defaultWechat>('settings','wechat');
  assert.ok(config);
  await f.store.put('settings',{...config,subscriptionsEnabled:false});
  assert.deepEqual(await f.service.publicWechatAvailability(),{available:false,codeAvailable:true});
  await f.store.put('settings',{...config,qrEnabled:false});
  assert.deepEqual(await f.service.publicWechatAvailability(),{available:true,codeAvailable:false});
  await f.store.put('settings',{...config,qrEnabled:false,subscriptionsEnabled:false});
  assert.deepEqual(await f.service.publicWechatAvailability(),{available:false,codeAvailable:false});
  await f.store.put('settings',{...config,templateId:''});
  assert.deepEqual(await f.service.publicWechatAvailability(),{available:false,codeAvailable:true});
  assert.equal(f.calls.length,0);
});


test('管理员站内信不会预留微信授权或排入微信发送任务',async()=>{
  const f=await fixture(),session=await f.login();await f.accept(session.sessionToken);f.advance(1000);
  await f.store.put('notices',{id:'manual-inbox',eventId:'',publicationId:'',semanticKey:'manual-inbox',origin:'admin',title:'隔离站内信',summary:'隔离正文',body:'隔离正文',categories:['system'],status:'active',createdAt:new Date(f.now()).toISOString()} satisfies Notice);
  await f.service.scheduleWechatDeliveries();assert.equal((await f.queued()).length,0);assert.equal((await f.service.wechatSubscriptionState(session.sessionToken)).state,'available');
  assert.equal(f.calls.filter(call=>call.url.includes('subscribe/send')).length,0);
});
