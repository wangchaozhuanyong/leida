import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pool,insert,put,transaction} from '../src/db';
import type {BenefitAction,Evidence,Publication,PublicData} from '../src/lib/types';
import {getPublicRead,readPublicFacts} from '../src/server/public-read';
import {parseCodexLimitsObservations} from '../src/server/codexlimits-observation-source';
import {resetObservations} from '../src/lib/reset-observations';
import {publicActions} from '../src/lib/public-facts';
import {recordCalendar} from '../miniprogram/utils/record-calendar';

const oldAt='2026-10-22T17:00:00.000Z',newAt='2026-10-23T17:40:00.000Z';
const collectedAt='2026-10-23T20:19:26.735Z';
function publication(id:string,e:Evidence,actions:BenefitAction[]=[]):Publication {
  const mode=actions.length?'state_change' as const:'news_only' as const;
  const event:Publication['event']={id:`event-${id}`,title:id,version:1,status:'published',actions,evidenceIds:[e.id],publicationId:id,updatedAt:collectedAt};
  const article:Publication['article']={id:`article-${id}`,eventId:event.id,publicationId:id,title:`隔离读取验证 ${id}`,summary:'第三方来源观测，仅核对记录展示，不表示账户到账。',translation:'完整隔离测试原文',category:'reset',status:'published',version:1,evidenceIds:[e.id],publishedAt:collectedAt,sourcePublishedAt:e.publishedAt,updatedAt:collectedAt,publicationMode:mode,historical:true};
  return {id,eventId:event.id,articleId:article.id,event,article,mode,publishedAt:collectedAt,cutoffAt:collectedAt,reason:'isolated public read regression'};
}
const observationDates=(data:PublicData)=>resetObservations(data).map(o=>o.observedAt).sort();
const ids=(data:PublicData)=>data.publications.map(p=>p.id).sort();

test('真实 PostgreSQL 公开读取：23/24日观测证明、日历、类型历史、详情和撤回一致', {skip:process.env.RADAR_OBSERVATION_CALENDAR_INTEGRATION!=='1'},async t=>{
  const url=new URL(process.env.DATABASE_URL!);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55489');
  assert.match(url.pathname,/^\/radar_qa_observation_calendar_[a-z0-9_]+$/,'只允许新建的本项目隔离测试库');
  const old:Evidence={id:'qa-old-observation',sourceId:'reset-archive',messageId:'observed-2113162413008884099',url:'https://x.com/thsottiaux/status/2113162413008884099',text:'Codex 使用限额已重置。查看你的限额。',publishedAt:oldAt,collectedAt,contextComplete:false,historical:true,hash:'qa-old',provenance:'archive',textOrigin:'archive_excerpt',metadata:{sourceGroup:'codex-resets',category:'reset'}};
  const html=readFileSync(new URL('./fixtures/codexlimits-reset-observations.html',import.meta.url),'utf8');
  const raw=parseCodexLimitsObservations(html,collectedAt).find(e=>e.publishedAt===newAt)!;
  assert.ok(raw,'使用真实来源HTML中的10月23日17:40UTC观测');
  const latest:Evidence={...raw,id:'qa-limits-observation',hash:'qa-limits',historical:true};
  const ordinary:Evidence={id:'qa-ordinary-banked',sourceId:'official-fixture',messageId:'banked-fixture',url:'https://example.invalid/isolated-evidence',text:'仅隔离夹具：公开重置卡已经发放',publishedAt:'2026-10-21T17:00:00.000Z',collectedAt,contextComplete:true,historical:true,hash:'qa-banked',provenance:'official',textOrigin:'original',metadata:{category:'reset',benefitKind:'banked_reset'}};
  const forged:Evidence={...latest,id:'qa-invalid-proof',hash:'qa-invalid',metadata:{...latest.metadata,referenceReset:{...latest.metadata!.referenceReset!,summary:'not the declared third-party observation'}}};
  const unpublished:Evidence={...latest,id:'qa-unpublished',hash:'qa-unpublished'};
  const oldPub=publication('qa-publication-old',old),newPub=publication('qa-publication-limits',latest);
  const bankedPub=publication('qa-publication-banked',ordinary,[{id:'qa-banked-action',kind:'banked_reset',stage:'claimed_complete',scope:'public',eligibility:'仅隔离夹具',statementAt:ordinary.publishedAt,evidenceIds:[ordinary.id]}]);
  const forgedPub=publication('qa-publication-invalid',forged);
  const expected=[oldAt,newAt].sort(),publications=[oldPub,newPub,bankedPub,forgedPub];
  const snapshot=async()=>Object.fromEntries(await Promise.all(['evidence','publications','events','articles','notices','jobs','wechat_deliveries'].map(async table=>[table,(await pool.query(`SELECT id,payload FROM radar_${table} ORDER BY id`)).rows])));
  try {
    await transaction(async client=>{
      for(const e of [old,latest,ordinary,forged,unpublished])assert.equal(await insert('evidence',e,client),true);
      for(const p of publications){await put('events',p.event,client);await put('articles',p.article,client);assert.equal(await insert('publications',p,client),true);}
    });
    const before=await snapshot();
    let calendar:PublicData;
    await t.test('home/calendar/history经过实际SQL裁剪仍保留两种来源严格证明，普通正文仍裁掉',async()=>{
      for(const view of ['home','calendar','history'] as const){
        const result=await getPublicRead({view,filter:'all'});
        assert.deepEqual(observationDates(result.data),expected,`${view}不能裁掉观测证明或漏选发布记录`);
        const e=result.data.evidence.find(e=>e.id===latest.id)!;
        assert.equal(e.text,latest.text);assert.deepEqual(e.metadata,latest.metadata);
        const ordinaryRead=result.data.evidence.find(e=>e.id===ordinary.id)!;
        assert.ok(ordinaryRead);assert.equal(ordinaryRead.text,'');assert.equal(ordinaryRead.metadata,undefined,'不能为了观测把所有原文开放到精简接口');
        assert.deepEqual(publicActions(result.data).map(item=>item.action.kind),['banked_reset'],'第三方观测不提升为正式完成');
        if(view==='calendar')calendar=result.data;
      }
    });
    await t.test('真实calendar响应生成北京时间23日01:00和24日01:40，来源观测标记和详情链接正确',()=>{
      const oldDay=recordCalendar(calendar!,{date:'2026-10-23'}),newDay=recordCalendar(calendar!,{date:'2026-10-24'});
      assert.equal(oldDay.selectedItems.length,1);assert.equal(oldDay.selectedItems[0].time,'01:00');assert.equal(oldDay.selectedItems[0].sourceName,'Codex Resets');
      assert.equal(newDay.selectedItems.length,1);assert.equal(newDay.selectedItems[0].time,'01:40');assert.equal(newDay.selectedItems[0].sourceName,'Codex Limits');
      assert.equal(newDay.selectedItems[0].evidenceType,'observed');assert.equal(newDay.selectedItems[0].statusLabel,'来源观测');
      assert.equal(newDay.selectedItems[0].path,`/pages/detail/index?publicationId=${newPub.id}`);
      assert.equal(newDay.selectedItems[0].href,`/events/${newPub.eventId}?version=${newPub.id}`);
      const marker=newDay.days.find(day=>day.date==='2026-10-24')!;
      assert.equal(marker.observedCount,1);assert.equal(marker.confirmedCount,0);assert.equal(marker.confirmedAutomatic,false);
      assert.equal(newDay.observedCount,2);assert.equal(newDay.confirmedCount,1);
      assert.equal(recordCalendar(calendar!,{kind:'banked_reset'}).selectedObservedCount,0);
    });
    await t.test('history按类型选择，严格拒绝错误证明和未发布证据',async()=>{
      const all=await getPublicRead({view:'history',filter:'all'}),automatic=await getPublicRead({view:'history',filter:'automatic_reset'}),banked=await getPublicRead({view:'history',filter:'banked_reset'});
      assert.deepEqual(ids(all.data),[oldPub.id,newPub.id,bankedPub.id].sort());assert.equal(all.page!.total,3);
      assert.deepEqual(ids(automatic.data),[oldPub.id,newPub.id].sort());assert.equal(automatic.page!.total,2);assert.deepEqual(observationDates(automatic.data),expected);
      assert.deepEqual(ids(banked.data),[bankedPub.id]);assert.equal(banked.page!.total,1);assert.deepEqual(resetObservations(banked.data),[]);
      assert.ok(!ids(calendar!).includes(forgedPub.id));
      const hidden=await getPublicRead({view:'detail',entity:'sources',id:unpublished.id});assert.equal(hidden.data.publications.length,0);assert.equal(hidden.data.evidence.length,0);
    });
    await t.test('event/article/publication/source详情保留固定发布身份与完整原文，读取不写任何业务行',async()=>{
      for(const p of [oldPub,newPub])for(const [entity,id] of [['events',p.eventId],['articles',p.articleId],['publications',p.id],['sources',p.article.evidenceIds[0]]] as const){
        const detail=await getPublicRead({view:'detail',entity,id,version:p.id});
        assert.deepEqual(ids(detail.data),[p.id]);assert.equal(detail.data.publications[0].article.translation,p.article.translation);
        assert.deepEqual(observationDates(detail.data),[p.article.sourcePublishedAt]);
        if(p===newPub)assert.deepEqual(detail.data.evidence[0].metadata,latest.metadata);
      }
      assert.deepEqual(await snapshot(),before,'公开读取不得创建通知、任务或改写历史原文');
    });
    await t.test('当前事件或文章撤回后新读取排除对应观测，固定历史详情仍保留原始证据',async()=>{
      // Exercise both current-event and current-article guards, without mutating immutable snapshots.
      await put('events',{...newPub.event,status:'withdrawn',version:2});
      await put('articles',{...oldPub.article,status:'withdrawn',version:2});
      await new Promise(resolve=>setTimeout(resolve,10_050)); // Production read cache expires after 10 seconds.
      for(const view of ['home','calendar','history'] as const){
        const result=await getPublicRead({view,filter:'all'});assert.deepEqual(resetObservations(result.data),[],`${view}不能继续认定撤回观测`);
        if(view!=='home')assert.deepEqual(ids(result.data),[bankedPub.id]);
        assert.equal(recordCalendar(result.data).observedCount,0);
      }
      assert.equal((await getPublicRead({view:'history',filter:'automatic_reset'})).page!.total,0);
      for(const p of [oldPub,newPub]){
        const detail=await getPublicRead({view:'detail',entity:'events',id:p.eventId,version:p.id});
        assert.equal(detail.data.publications[0].event.status,'published');assert.equal(detail.data.publications[0].article.status,'published');
        assert.equal(detail.data.evidence[0].text,p===newPub?latest.text:old.text);assert.deepEqual(resetObservations(detail.data),[]);
      }
      const after=await snapshot();assert.deepEqual(after.evidence,before.evidence);assert.deepEqual(after.publications,before.publications);
      for(const table of ['notices','jobs','wechat_deliveries'])assert.deepEqual(after[table],[]);
    });
    await t.test('跨源去重后完成动作引用B仍保留公开证明；未发布或撤回B不能吞掉A观测',async()=>{
      const cases=[{key:'linked',hour:17,published:true,withdrawn:false},{key:'unpublished',hour:18,published:false,withdrawn:false},{key:'withdrawn',hour:19,published:true,withdrawn:true}];
      const linkedPublications:string[]=[];
      for(const [index,item] of cases.entries()){
        // Distinct synthetic identities exercise relation guards without
        // colliding with the captured 17:40 source record verified above.
        const at=`2026-10-23T${item.hour}:50:00.000Z`,post=String(2113162413008884099n+BigInt(index+1));
        const a:Evidence={...old,id:`qa-a-${item.key}`,messageId:`observed-${post}`,url:`https://x.com/thsottiaux/status/${post}`,publishedAt:at};
        const summary=`Third-party observation on Oct 23, ${item.hour}:50 UTC.`;
        const b:Evidence={...latest,id:`qa-z-${item.key}`,hash:`qa-z-${item.key}`,messageId:`observed-codexlimits-${Date.parse(at)}`,publishedAt:at,text:`Usage reset landed\n${summary}`,metadata:{...latest.metadata,referenceReset:{...latest.metadata!.referenceReset!,eventId:`codexlimits:automatic_reset:${at}`,occurredAt:at,summary}}};
        const aPub=publication(`qa-p-a-${item.key}`,a),bPub=publication(`qa-p-b-${item.key}`,b);
        const completion=publication(`qa-p-completion-${item.key}`,ordinary,[{id:`qa-completion-${item.key}`,kind:'automatic_reset',stage:'claimed_complete',scope:'public',eligibility:'隔离引用关系夹具',statementAt:`2026-10-23T${item.hour}:51:00.000Z`,evidenceIds:[b.id]}]);
        await transaction(async client=>{
          assert.equal(await insert('evidence',a,client),true);assert.equal(await insert('evidence',b,client),true);
          for(const p of [aPub,completion,...(item.published?[bPub]:[])]){
            await put('events',p===bPub&&item.withdrawn?{...p.event,status:'withdrawn',version:2}:p.event,client);
            await put('articles',p.article,client);assert.equal(await insert('publications',p,client),true);
          }
        });
        if(item.published&&!item.withdrawn)linkedPublications.push(bPub.id);
      }
      await new Promise(resolve=>setTimeout(resolve,10_050));
      const full=await transaction(client=>readPublicFacts(client,new Date().toISOString()));
      const compact=(await getPublicRead({view:'calendar',filter:'all'})).data;
      const fullCalendar=recordCalendar(full,{date:'2026-10-24'}),compactCalendar=recordCalendar(compact,{date:'2026-10-24'});
      assert.equal(fullCalendar.confirmedCount,4);assert.equal(fullCalendar.observedCount,2);
      assert.equal(compactCalendar.confirmedCount,fullCalendar.confirmedCount);assert.equal(compactCalendar.observedCount,fullCalendar.observedCount);
      assert.deepEqual(compactCalendar.selectedItems.map(item=>[item.id,item.evidenceType,item.at]),fullCalendar.selectedItems.map(item=>[item.id,item.evidenceType,item.at]));
      assert.ok(linkedPublications.every(id=>ids(compact).includes(id)),'B已公开但跨源去重后仍需保留引用证明');
      assert.ok(!ids(compact).includes('qa-p-b-unpublished'));assert.ok(!ids(compact).includes('qa-p-b-withdrawn'));
      assert.ok(!compactCalendar.selectedItems.some(item=>item.evidenceType==='observed'&&item.at==='2026-10-23T17:50:00.000Z'));
      for(const hour of [18,19])assert.ok(compactCalendar.selectedItems.some(item=>item.evidenceType==='observed'&&item.at===`2026-10-23T${hour}:50:00.000Z`),'未公开或已撤回B不构成有效完成引用关系');
    });
  } finally {await pool.end();}
});
