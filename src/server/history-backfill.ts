import {createHash} from 'node:crypto';
import bundleFile from './data/history-backfill-20261017.json';
import {list,one,insert,put,transaction,lockTransaction} from '../db';
import type {Candidate,DraftContent,Evidence,RadarEvent,Article,Source} from '../lib/types';
import {buildAutomaticTemplate,evidenceFingerprint,isClearlyUnrelated} from './automatic-content';
import {gatherEvidenceContext,namespace,selectOriginal,originalConflict} from './source-context';
import {actionIdentityEvidence,contextFor,resolveLinkedEvents} from './worker';
import {publishHistoricalDraft,partitionAutomaticActions,automaticNewsContextUpgrade,audit} from './service';
import {DomainError,hash,now,validateDraft} from './domain';
import {TIBO_PUBLIC_SOURCE} from './tibo-public';

interface HistoryMessage {messageId:string;publishedAt:string;referenceOnly:boolean;expectedActions:{kind:string;stage:string}[];}
export interface HistoryBundle {id:string;schemaVersion:number;rulesVersion:string;startsAt:string;endsAt:string;reviewedAt:string;evidence:Evidence[];messages:HistoryMessage[];reposts?:{messageId:string;replacementId:string}[];}
interface HistoryReceipt {id:string;digest:string;phase:'publishing'|'complete';nextIndex:number;insertedEvidence:number;published:number;references:number;existing:number;updatedAt:string;}
const BUNDLE_DIGEST='482a3fc5b5df25429467131b592690a4670307398c1be8e1d6cba9d492f3c8c8';
const bundle=bundleFile as unknown as HistoryBundle;
const receiptId='maintenance:'+bundle.id;
const key=(e:Evidence)=>`${namespace(e)}:${e.messageId}`;
export function canUpgradeHistoryArticle(article:Article,event:RadarEvent|undefined,humanEdited=false):boolean {
  return !humanEdited&&article.status==='published'&&article.publicationMode==='news_only'&&article.contentOrigin==='template'&&!article.manualFields?.length&&event?.status==='published'&&!event.manualFields?.length;
}

/** The input is a reviewed, versioned repository asset, never a request body or URL.
 * Its pinned rule version and digest stay immutable after completion. New live
 * rules must pass every bundled expected-action regression before release. */
export function validateHistoryBundle(value:HistoryBundle,digest=BUNDLE_DIGEST):void {
  if(createHash('sha256').update(JSON.stringify(value)).digest('hex')!==digest||value.schemaVersion!==1||value.rulesVersion!==bundle.rulesVersion||!value.id||value.messages.length>120||value.evidence.length>240)throw new DomainError('历史补录清单校验失败');
  const ids=new Set(value.evidence.map(e=>e.messageId));
  if(ids.size!==value.evidence.length||new Set(value.messages.map(m=>m.messageId)).size!==value.messages.length)throw new DomainError('历史补录清单包含重复原帖');
  if(!Number.isFinite(Date.parse(value.startsAt))||!Number.isFinite(Date.parse(value.endsAt))||Date.parse(value.endsAt)>Date.now()+300000)throw new DomainError('历史补录时间范围无效');
  for(const row of value.evidence)if(row.sourceId!=='tibo-public'||row.textOrigin!=='original'||!row.historical||!/^https:\/\/x\.com\/thsottiaux\/status\/\d+$/.test(row.url)||!row.url.endsWith('/'+row.messageId)||!row.text||row.text.length>12000||!Number.isFinite(Date.parse(row.publishedAt))||Date.parse(row.publishedAt)>Date.parse(value.endsAt))throw new DomainError('历史补录来源或原文无效');
  for(const row of value.messages)if(!ids.has(row.messageId)||row.publishedAt<value.startsAt||row.publishedAt>value.endsAt)throw new DomainError('历史补录消息超出范围');
  for(const pair of value.reposts??[]){const first=value.evidence.find(e=>e.messageId===pair.messageId),second=value.evidence.find(e=>e.messageId===pair.replacementId);if(!first||!second||!first.parentId||first.parentId!==second.parentId||Date.parse(second.publishedAt)<=Date.parse(first.publishedAt)||Date.parse(second.publishedAt)-Date.parse(first.publishedAt)>600000)throw new DomainError('历史重发关联未通过核对');}
}

export function historicalDraft(primary:Evidence,all:Evidence[],message:HistoryMessage):DraftContent {
  const context=gatherEvidenceContext(primary,all),generated=buildAutomaticTemplate(context);
  const facts=generated?.actions.map(a=>({kind:a.kind,stage:a.stage}));
  if(!message.referenceOnly&&generated&&JSON.stringify(facts)===JSON.stringify(message.expectedActions)&&!validateDraft(generated,all).length)return generated;
  return {title:'重置相关历史消息',summary:'公开来源曾发布这条重置相关消息。其类型、适用对象或完成状态仍需结合原文核对，暂不计入已完成次数。',translation:'',category:'reset',actions:[],evidenceIds:[primary.id],publicationMode:'news_only',contentOrigin:'template',reviewStatus:'pending',reviewReasons:['历史来源记录，尚不足以确认公共发放动作']};
}

/** Bounded, additive, resumable data maintenance using the existing storage transaction. */
export async function applyBundledHistory():Promise<HistoryReceipt> {
  const already=await one<HistoryReceipt>('settings',receiptId);
  if(already?.digest===BUNDLE_DIGEST&&already.phase==='complete')return already;
  validateHistoryBundle(bundle);
  await transaction(async c=>{
    await lockTransaction(c,'radar_publication');
    const prior=await one<HistoryReceipt>('settings',receiptId,c);
    if(prior){if(prior.digest!==BUNDLE_DIGEST)throw new DomainError('历史补录批次已变化');return;}
    if(!await one<Source>('sources',TIBO_PUBLIC_SOURCE.id,c))await insert('sources',TIBO_PUBLIC_SOURCE,c);
    const all=await list<Evidence>('evidence',c);let insertedEvidence=0;
    for(const input of bundle.evidence){
      // Preserve original bodies; append only verified context enrichment.
      const prior=selectOriginal(all.filter(e=>key(e)===key(input)&&e.textOrigin==='original'));
      if(prior&&(originalConflict(input,[prior])||!(input.contextComplete&&!prior.contextComplete||input.parentId&&!prior.parentId)))continue;
      const metadata={...prior?.metadata,...input.metadata};
      const contextComplete=prior?.contextComplete||input.contextComplete;
      const checksum=hash(JSON.stringify({text:input.text,url:input.url,publishedAt:input.publishedAt,parentId:input.parentId,contextComplete,provenance:input.provenance,textOrigin:input.textOrigin,metadata}));
      const row={...input,id:`evidence_history_${hash(key(input)+':'+checksum)}`,hash:checksum,historical:true,collectedAt:now(),metadata,contextComplete};
      if(await insert('evidence',row,c)){all.push(row);insertedEvidence++;}
    }
    await put('settings',{id:receiptId,digest:BUNDLE_DIGEST,phase:'publishing',nextIndex:0,insertedEvidence,published:0,references:0,existing:0,updatedAt:now()} satisfies HistoryReceipt,c);
  });
  for(let batch=0;batch<12;batch++){
    const receipt=await transaction(async c=>{
      await lockTransaction(c,'radar_publication');
      const current=await one<HistoryReceipt>('settings',receiptId,c);
      if(!current||current.digest!==BUNDLE_DIGEST)throw new DomainError('历史补录批次不匹配');
      if(current.phase==='complete')return current;
      const all=await list<Evidence>('evidence',c),articles=await list<Article>('articles',c),events=await list<RadarEvent>('events',c),candidates=await list<Candidate>('candidates',c);
      const identity=new Map(all.map(e=>[e.id,key(e)]));
      const next={...current};
      for(const message of bundle.messages.slice(current.nextIndex,current.nextIndex+10)){
        const prototype=bundle.evidence.find(e=>e.messageId===message.messageId)!;
        const primary=selectOriginal(all.filter(e=>key(e)===key(prototype)));
        if(!primary||isClearlyUnrelated(primary))throw new DomainError('历史补录主帖未核对');
        const existing=articles.find(a=>identity.get(a.evidenceIds[0])===key(primary));
        const humanEdited=!!existing&&candidates.some(candidate=>candidate.humanEdited&&candidate.status==='published'&&(candidate.automation?.articleId===existing.id||identity.get(candidate.evidenceId)===key(primary)));
        if(existing&&!canUpgradeHistoryArticle(existing,events.find(e=>e.id===existing.eventId),humanEdited)){next.existing++;next.nextIndex++;continue;}
        const context=gatherEvidenceContext(primary,all);let draft=historicalDraft(primary,all,message);
        let linked=resolveLinkedEvents(primary,context,events,all).filter(e=>e.status==='published');
        if(draft.publicationMode==='news_only')linked=[];
        if(!existing&&linked.length>1)draft=historicalDraft(primary,all,{...message,referenceOnly:true});
        let target=existing?events.find(e=>e.id===existing.eventId):linked.length===1?linked[0]:undefined;
        if(existing&&target){
          const upgrades=linked.filter(event=>event.id!==target!.id&&automaticNewsContextUpgrade(primary,draft,target!,event,all,articles)?.id===existing.id);
          if(upgrades.length===1)target=upgrades[0];
          else if(linked.some(event=>event.id!==target!.id&&event.actions.length))draft=historicalDraft(primary,all,{...message,referenceOnly:true});
        }
        if(target&&draft.actions.some(action=>target!.actions.filter(a=>a.kind===action.kind&&a.scope===action.scope).length>1)){
          draft=historicalDraft(primary,all,{...message,referenceOnly:true});target=undefined;
        }
        const root=actionIdentityEvidence(primary,context);
        draft={...draft,eventId:target?.id,actions:draft.actions.map((action,index)=>{
          const prior=target?.actions.filter(a=>a.kind===action.kind&&a.scope===action.scope)??[];
          if(prior.length>1)throw new DomainError('历史补录动作轮次不明确');
          return {...action,id:prior[0]?.id??`action_${hash(`${key(root)}:${action.kind}:${action.scope}:${index}`)}`};
        })};
        const partition=partitionAutomaticActions(draft,target);
        if(partition.stale.length)draft={...draft,actions:partition.current,...(!partition.current.length?{publicationMode:'news_only' as const,title:'较早公告记录',summary:`公开来源的较早声明：${draft.summary}`}:{})};
        const errors=validateDraft(draft,all);if(errors.length)throw new DomainError('历史补录事实校验未通过');
        const previousCandidate=candidates.find(candidate=>candidate.id.startsWith('candidate_history_')&&!candidate.humanEdited&&identity.get(candidate.evidenceId)===key(primary));
        if(draft.publicationMode==='news_only'){
          // Unresolved references stay in the existing review queue, not customer news.
          if(!previousCandidate&&!existing)await insert('candidates',{id:`candidate_history_${hash(bundle.id+':'+message.messageId)}`,evidenceId:primary.id,version:1,status:'draft',content:draft,reasons:draft.reviewReasons??['历史原帖待核对'],createdAt:now(),updatedAt:now(),humanEdited:false} satisfies Candidate,c);
          next.references++;next.nextIndex++;continue;
        }
        const publication=await publishHistoricalDraft(draft,c,`补齐近半年公开历史，原帖 ${message.messageId}；历史补录不发送实时提醒`,existing);
        const candidate:Candidate={id:previousCandidate?.id??`candidate_history_${hash(bundle.id+':'+message.messageId)}`,evidenceId:primary.id,version:(previousCandidate?.version??0)+1,status:'published',content:{...draft,eventId:publication.eventId},reasons:[],createdAt:previousCandidate?.createdAt??now(),updatedAt:now(),humanEdited:false};
        // This frozen, reviewed import is final; do not enqueue paid prose enrichment.
        candidate.automation={state:'ready',reasonCodes:[],dependencyIds:[],inputFingerprint:evidenceFingerprint(contextFor(candidate,primary,all)),evaluatedAt:now(),articleId:publication.articleId,templatePublished:false};
        if(previousCandidate)await put('candidates',candidate,c);else await insert('candidates',candidate,c);
        const articleIndex=articles.findIndex(a=>a.id===publication.articleId);if(articleIndex<0)articles.push(publication.article);else articles[articleIndex]=publication.article;
        if(existing&&existing.eventId!==publication.eventId){const old=events.find(e=>e.id===existing.eventId);if(old){old.status='merged';old.mergedInto=publication.eventId;}}
        const oldIndex=events.findIndex(e=>e.id===publication.eventId);if(oldIndex<0)events.push(publication.event);else events[oldIndex]=publication.event;
        next.published++;next.nextIndex++;
      }
      next.phase=next.nextIndex===bundle.messages.length?'complete':'publishing';next.updatedAt=now();
      if(next.phase==='complete')for(const pair of bundle.reposts??[]){
        const sourceArticle=articles.find(a=>identity.get(a.evidenceIds[0])===key(bundle.evidence.find(e=>e.messageId===pair.messageId)!)),targetArticle=articles.find(a=>identity.get(a.evidenceIds[0])===key(bundle.evidence.find(e=>e.messageId===pair.replacementId)!));
        const source=events.find(e=>e.id===sourceArticle?.eventId),target=events.find(e=>e.id===targetArticle?.eventId);
        if(!source||!target||source.id===target.id||source.status!=='published'||target.status!=='published')continue;
        if([source,target].some(e=>e.manualFields?.length)||[sourceArticle!,targetArticle!].some(a=>a.status!=='published'||a.manualFields?.length||a.contentOrigin!=='template')||candidates.some(candidate=>candidate.humanEdited&&candidate.status==='published'&&([sourceArticle!.id,targetArticle!.id].includes(candidate.automation?.articleId??'')||[pair.messageId,pair.replacementId].some(messageId=>identity.get(candidate.evidenceId)===key(bundle.evidence.find(e=>e.messageId===messageId)!)))))continue;
        const [first,second]=[source.actions,target.actions];
        if(first.length!==1||second.length!==1||first[0].stage!=='claimed_complete'||second[0].stage!=='claimed_complete'||JSON.stringify([first[0].kind,first[0].scope,first[0].eligibility,first[0].evidenceQuote])!==JSON.stringify([second[0].kind,second[0].scope,second[0].eligibility,second[0].evidenceQuote]))throw new DomainError('重发原帖动作不一致，保留人工核对');
        const merged={...source,status:'merged' as const,mergedInto:target.id,version:source.version+1,updatedAt:now()};await put('events',merged,c);
        await audit('authorized-history-backfill','history.repost_merge',source.id,'已核对为同一完成声明的文字修正重发；两条原文和旧快照保留，重置只计一次',source,merged,c);
      }
      await put('settings',next,c);
      if(next.phase==='complete')await audit('authorized-history-backfill','history.backfill',bundle.id,'按用户要求补齐近半年可查公开历史；未生成实时提醒',undefined,next,c);
      return next;
    });
    if(receipt.phase==='complete')return receipt;
  }
  throw new DomainError('历史补录批次未完成');
}
