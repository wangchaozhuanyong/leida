import test from 'node:test';
import assert from 'node:assert/strict';
import type {Candidate,Evidence,Job,Notice,Publication,Source} from '../src/lib/types';
import type {WechatGrant} from '../src/lib/wechat';
import {buildAutomaticTemplate} from '../src/server/automatic-content';

test('真实隔离库：新观测发布、结果通知、微信任务与发送回执闭环，重复和历史不补发',{skip:process.env.RADAR_REMINDER_DELIVERY_INTEGRATION!=='1'},async t=>{
  const db=new URL(process.env.DATABASE_URL!);assert.equal(db.hostname,'127.0.0.1');assert.equal(db.port,'55489');assert.match(db.pathname,/^\/radar_qa_reminder_[a-z0-9_]+$/);
  const {pool,put,list,one}=await import('../src/db');
  const {createEvidence,publishCandidate,previewCandidate,defaultSite}=await import('../src/server/service');
  const {createWechatService}=await import('../src/server/wechat');
  const {claimJob,runOne}=await import('../src/server/worker');
  const realFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('No external calls in isolated reminder validation');};
  let clock=Date.now()-10*60_000,sequence=0;
  const calls:{path:string;body:Record<string,unknown>}[]=[];
  const service=createWechatService({clock:()=>clock,encryptionKey:()=>Buffer.alloc(32,23),preparePublicPage:async()=>{},fetcher:async(input,init)=>{
    const url=new URL(String(input));assert.equal(url.origin,'https://api.weixin.qq.com');
    const body=init?.body?JSON.parse(String(init.body)):{};calls.push({path:url.pathname,body});
    if(url.pathname==='/sns/jscode2session')return Response.json({openid:'synthetic-isolated-reminder-reader'});
    if(url.pathname==='/cgi-bin/stable_token')return Response.json({access_token:'synthetic-isolated-token',expires_in:7200});
    if(url.pathname==='/cgi-bin/message/subscribe/send')return Response.json({errcode:0,errmsg:'ok'});
    throw new Error('Unexpected synthetic provider endpoint');
  }});
  const base:Source={id:'codexlimits-observations',name:'Isolated observed resets',kind:'archive',url:'https://codexlimits.com/reset-history',enabled:true,validated:true,status:'healthy',intervalMinutes:5,version:1,nextRunAt:'2100-01-01T00:00:00Z'};
  const at=new Date(Math.floor((Date.now()-5*60_000)/60_000)*60_000).toISOString();
  function proof(time=at,alternate=false):Omit<Evidence,'id'|'hash'>{
    const date=new Date(time),collectedAt=new Date().toISOString();
    if(alternate){
      const messageId=((BigInt(date.getTime())-1288834974657n)<<22n).toString();
      return {sourceId:'reset-archive',messageId:`observed-${messageId}`,url:`https://x.com/thsottiaux/status/${messageId}`,text:'Codex usage limits have been reset. Check your limits.',publishedAt:time,collectedAt,historical:false,contextComplete:false,provenance:'archive',textOrigin:'archive_excerpt',metadata:{sourceGroup:'codex-resets',category:'reset'}};
    }
    const stamp=`${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getUTCMonth()]} ${date.getUTCDate()}, ${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')} UTC.`;
    const summary=`Third-party observation on ${stamp}`;
    return {sourceId:base.id,messageId:`observed-codexlimits-${date.getTime()}`,url:base.url,text:`Usage reset landed\n${summary}`,publishedAt:time,collectedAt,historical:false,contextComplete:false,provenance:'archive',textOrigin:'archive_excerpt',metadata:{sourceGroup:'codexlimits',category:'reset',benefitKind:'automatic_reset',referenceReset:{eventId:`codexlimits:automatic_reset:${time}`,occurredAt:time,snapshotAt:collectedAt,referenceUrl:base.url,summary}}};
  }
  async function prepare(input:Omit<Evidence,'id'|'hash'>){
    const created=await createEvidence(input);assert.ok(created.candidate);
    const draft=buildAutomaticTemplate([created.evidence]);assert.ok(draft);
    const candidate={...created.candidate,content:draft,reasons:[]};await put('candidates',candidate);return candidate;
  }
  async function publish(candidate:Candidate){
    return publishCandidate(candidate.id,candidate.version,'worker','Isolated observation notification test',true);
  }
  try{
    await put('settings',{id:'site',...defaultSite});await put('sources',base);
    await put('sources',{...base,id:'reset-archive',url:'https://codex-resets.com/zh-CN'});
    const settings=await service.adminWechat();
    await service.saveWechatSettings({...settings,appId:'wx0123456789abcdef',secret:'synthetic-reminder-fixture-secret',subscriptionsEnabled:true,qrEnabled:false,envVersion:'trial',templateId:'synthetic-isolated-template',templateFields:{title:'thing1',status:'thing3',time:'time5'},dailyApiLimit:100,dailyQrLimit:0,dailySendLimit:20},'isolated-test');
    const session=await service.wechatLogin('synthetic-reminder-code');
    for(let i=0;i<3;i++){const challenge=await service.wechatSubscriptionChallenge(session.sessionToken);await service.confirmWechatSubscription(session.sessionToken,{nonce:challenge.nonce,templateId:challenge.templateId,result:'accept'});clock++;}
    let publication!:Publication;
    await t.test('新观测产生一次result通知，保持news_only和空完成动作，预览与实际一致',async()=>{
      const candidate=await prepare(proof());
      const preview=await previewCandidate(candidate.id,candidate.version);assert.equal(preview.canPublish,true,preview.reasons.join(';'));assert.equal(preview.willNotify,true);assert.match(preview.noticeReason,/有效重置观测/);
      publication=await publish(candidate);assert.equal(publication.mode,'news_only');assert.deepEqual(publication.event.actions,[]);
      const notices=await list<Notice>('notices');assert.equal(notices.length,1);assert.deepEqual(notices[0].categories,['result']);assert.equal(notices[0].publicationId,publication.id);
    });
    await t.test('实际SQL入队和worker任务完成，微信替身收到第三方限定与原观测时间',async()=>{
      clock=Date.now();await service.scheduleWechatDeliveries();
      const jobs=(await list<Job>('jobs')).filter(j=>j.kind==='wechat_send');assert.equal(jobs.length,1);
      const oldAt=new Date(Date.now()-60*60_000).toISOString();
      for(let i=0;i<156;i++){
        await put('jobs',{id:'qa-historical-'+i,kind:'generate',status:'queued',attempts:0,
          availableAt:oldAt,createdAt:oldAt,payload:{historical:true,evidencePublishedAt:oldAt}} satisfies Job);
      }
      assert.equal(await runOne({schedule:false,wechat:job=>service.processWechatJob(job)}),true);
      assert.equal((await one<Job>('jobs',jobs[0].id))?.status,'succeeded');
      assert.equal((await list<Job>('jobs')).filter(job=>job.payload.historical===true&&job.attempts===0).length,156);
      const sends=calls.filter(call=>call.path.endsWith('/subscribe/send'));assert.equal(sends.length,1);
      const expected=new Date(Date.parse(at)+8*3600_000).toISOString().slice(0,16).replace('T',' ');
      assert.deepEqual(sends[0].body.data,{thing1:{value:'Codex额度'},thing3:{value:'已观测到重置（第三方）'},time5:{value:expected}});
      assert.equal(sends[0].body.page,`pages/detail/index?publicationId=${publication.id}`);
      assert.equal((await service.wechatSubscriptionState(session.sessionToken)).remainingCount,2);
      const delivery=await list<{status:string}>('wechat_deliveries');assert.equal(delivery[0].status,'sent');
    });
    await t.test('同一观测补充另一个严格来源与重复调度，通知和发送仍各一次，旧快照不变',async()=>{
      const before=await one<Publication>('publications',publication.id);
      const candidate=await prepare(proof(at,true));await publish(candidate);
      assert.equal((await list<Notice>('notices')).length,1);
      clock=Date.now();await service.scheduleWechatDeliveries();
      assert.equal((await list<Job>('jobs')).filter(j=>j.kind==='wechat_send').length,1);
      assert.equal(calls.filter(call=>call.path.endsWith('/subscribe/send')).length,1);
      assert.deepEqual(await one('publications',publication.id),before);
    });
    await t.test('关闭结果类型不发新观测，历史补录仍静默，恢复开关不追发关闭期间消息',async()=>{
      clock=Date.now();await service.saveWechatReminderPreferences(session.sessionToken,{announcement:true,result:false,correction:true});
      const nextTime=new Date(Date.parse(at)+2*60_000).toISOString();await publish(await prepare(proof(nextTime)));
      clock=Date.now();await service.scheduleWechatDeliveries();assert.equal((await list<Job>('jobs')).filter(j=>j.kind==='wechat_send').length,1);
      const noticesBefore=(await list<Notice>('notices')).length;
      const historical={...proof(new Date(Date.parse(at)-2*86400_000).toISOString()),historical:true};await publish(await prepare(historical));
      assert.equal((await list<Notice>('notices')).length,noticesBefore);
      clock=Date.now();await service.saveWechatReminderPreferences(session.sessionToken,{announcement:true,result:true,correction:true});
      await service.scheduleWechatDeliveries();assert.equal((await list<Job>('jobs')).filter(j=>j.kind==='wechat_send').length,1);
      assert.equal((await service.wechatSubscriptionState(session.sessionToken)).remainingCount,2);
      assert.ok((await list<WechatGrant>('wechat_grants'))[0].credits?.filter(c=>c.status==='available').length===2);
    });
    await t.test('到期实时任务按等待时间轮转，超时历史租约和未来重试不会压住采集或提醒',async()=>{
      const due=(ms:number)=>new Date(Date.now()-ms).toISOString();
      const fixtures:Job[]=[
        {id:'qa-expired-history',kind:'generate',status:'running',attempts:1,availableAt:due(300_000),leaseUntil:due(1000),createdAt:due(300_000),payload:{historical:true,evidencePublishedAt:due(300_000)}},
        {id:'qa-expired-backfill',kind:'backfill',status:'running',attempts:1,availableAt:due(600_000),leaseUntil:due(1000),createdAt:due(600_000),payload:{historical:true}},
        {id:'qa-waiting-collect',kind:'collect',status:'queued',attempts:0,availableAt:due(180_000),createdAt:due(180_000),payload:{}},
        {id:'qa-waiting-send',kind:'wechat_send',status:'queued',attempts:0,availableAt:due(120_000),createdAt:due(120_000),payload:{}},
        {id:'qa-fresh-collect',kind:'collect',status:'queued',attempts:0,availableAt:due(1000),createdAt:due(1000),payload:{}},
        {id:'qa-future-send',kind:'wechat_send',status:'queued',attempts:0,availableAt:due(-60_000),createdAt:due(3600_000),payload:{}},
      ];
      for(const job of fixtures)await put('jobs',job);
      for(const expected of ['qa-waiting-collect','qa-waiting-send','qa-fresh-collect','qa-expired-history','qa-expired-backfill']){
        const claimed=await claimJob();
        assert.equal(claimed?.id,expected);
        assert.equal(claimed.attempts,expected.startsWith('qa-expired-')?2:1);
        await put('jobs',{...claimed,status:'succeeded',leaseUntil:undefined});
      }
      assert.equal((await one<Job>('jobs','qa-future-send'))?.attempts,0);
    });
  }finally{globalThis.fetch=realFetch;await pool.end();}
});
