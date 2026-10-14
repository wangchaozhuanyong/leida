import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Evidence, Source } from '../src/lib/types';
import { discoverActivityLinks, fetchReleasePages, isHistoricalRecord, MAX_RELEASE_PAGES, RELEASE_PAGE_SIZE, parseActivityDefinition, parseArchive, parseStatus, sourceDefinitions } from '../src/server/ingestion';
import { allowedEmbedRedirect, enrichKnownEvidence, knownPostIdentity, parseEmbeddedEvidence } from '../src/server/source-enrichment';
import { isTruncatedText } from '../src/server/source-context';

const at='2026-10-09T12:00:00.000Z';
const activity=sourceDefinitions.find(s=>s.kind==='activity')!;
const release=sourceDefinitions.find(s=>s.kind==='releases')!;
const originalText='We will load a banked reset for all paid accounts.';
function evidence(extra:Partial<Evidence>={}):Evidence{return {id:'e',hash:'h',sourceId:'reset-archive',messageId:'222',url:'https://x.com/thsottiaux/status/222',text:'已确认在所有账户落地。',publishedAt:at,collectedAt:at,contextComplete:false,historical:false,provenance:'archive',textOrigin:'archive_excerpt',...extra};}
function embed(text:string,id='222'){return {author_url:'https://twitter.com/thsottiaux',html:`<blockquote class="twitter-tweet"><p>${text}</p>— Tibo <a href="https://twitter.com/thsottiaux/status/${id}">日期</a></blockquote>`};}
function challenge(zone='data-timezone="America/Los_Angeles"',rules='每天发布一项产品改进，或为符合资格的用户重置用量。'){return `<h1 id="challenge-title">28天更新活动</h1><aside data-challenge-clock data-start="2026-10-05" data-days="28" ${zone}></aside><figure class="challenge-promise"><blockquote>${rules}</blockquote></figure><li class="challenge-row"><div class="challenge-row-date"><span>第3天</span></div><article class="challenge-entry"><h3 class="challenge-entry-title"><a href="https://x.com/thsottiaux/status/2108040921044639779">所有人获得重置卡</a></h3><p>已确认在所有账户落地。</p></article></li>`;}

test('辅助标题不补正文的福利类型或资格，保留同出版者身份',()=>{
 const row=parseArchive(challenge(),activity,at)[0];
 assert.equal(row.text,'已确认在所有账户落地。');
 assert.equal(row.contextComplete,false);
 assert.equal(row.textOrigin,'archive_excerpt');
 assert.equal(row.metadata?.title,'所有人获得重置卡');
 assert.equal(row.metadata?.sourceGroup,'codex-resets');
 assert.equal(row.metadata?.activity,undefined,'未经时区和规则核验，不建活动');
});
test('活动只用完整明确日期、规则和时区建立，保留已有活动链接',()=>{
 const complete=parseActivityDefinition(challenge(),activity.url)!;
 assert.equal(complete.id,'challenge-28');assert.equal(complete.timezone,'America/Los_Angeles');assert.equal(complete.days,28);
 assert.equal(parseActivityDefinition(challenge(''),activity.url),undefined);
 assert.equal(parseActivityDefinition(challenge('', ''),activity.url,'const zone = "America/Los_Angeles";'),undefined);
 assert.equal(parseActivityDefinition(challenge('data-timezone="PT"'),activity.url),undefined);
 assert.equal(parseActivityDefinition(challenge(),activity.url.replace('codex-resets.com','untrusted.invalid')),undefined);
 assert.equal(parseActivityDefinition(challenge(''),activity.url,'const zone = "America/Los_Angeles";')?.timezone,'America/Los_Angeles');
});
test('活动发现仅同域支持的活动路径，语言页合并，不跟随外链和任意资源',()=>{
 const links=discoverActivityLinks('<a href="/tibo-28">活动</a><a href="/zh-CN/tibo-28?lang=zh-CN">中文</a><a href="https://evil.invalid/challenge-30">恶意</a><a href="/api/private">未知</a><a href="https://codex-resets.com.evil.invalid/tibo-28">伪域</a><a href="/challenge-30">下期</a>');
 assert.deepEqual(links,['https://codex-resets.com/zh-CN/tibo-28','https://codex-resets.com/zh-CN/challenge-30']);
});
test('补采历史判断始终依发布时间，不依赖来源是否已经有游标',()=>{
 assert.equal(isHistoricalRecord('2026-10-07T00:00:00Z',false,Date.parse(at)),true);
 assert.equal(isHistoricalRecord(at,false,Date.parse(at)),false);
 assert.equal(isHistoricalRecord(at,true,Date.parse(at)),true);
});
test('官方状态标题与正文分别保存，故障进展有结构化身份',()=>{
 const row=parseStatus(JSON.stringify({incidents:[{id:'incident',name:'Codex error rate',incident_updates:[{id:'update',body:'We have restored service.',status:'resolved',created_at:at}]}]}),sourceDefinitions[0],at)[0];
 assert.equal(row.text,'We have restored service.');assert.equal(row.metadata?.title,'Codex error rate');assert.equal(row.metadata?.status,'resolved');assert.equal(row.textOrigin,'structured');
});
test('原帖补证只认可已知作者和相同原帖，完整正文不推定父关系',()=>{
 assert.equal(knownPostIdentity('https://x.com/other/status/222'),undefined);
 assert.equal(knownPostIdentity('https://x.com.evil.invalid/thsottiaux/status/222'),undefined);
 assert.equal(knownPostIdentity('http://x.com/thsottiaux/status/222'),undefined);
 const enriched=parseEmbeddedEvidence(embed(originalText),evidence(),at)!;
 assert.equal(enriched.text,originalText);assert.equal(enriched.textOrigin,'original');assert.equal(enriched.contextComplete,true);assert.equal(enriched.parentId,undefined);
 assert.equal(parseEmbeddedEvidence(embed(originalText,'333'),evidence()),undefined);
 assert.equal(parseEmbeddedEvidence(embed(originalText),evidence({provenance:'manual'})),undefined);
 assert.equal(parseEmbeddedEvidence(embed(originalText),evidence({parentId:'111'}))?.contextComplete,false);
 assert.equal(parseEmbeddedEvidence(embed('Confirmed landed across all accounts.'),evidence())?.contextComplete,false);
});
test('截断、闭引号和省略号后短链不能冒充完整原帖',()=>{
 for(const text of ['We have loaded a banked reset for all paid accounts…','我们已为所有付费用户重置了用量……”','We have loaded a banked reset for all paid accounts… https://t.co/test','我们已经 [truncated]','因此……重置已经”']){
  assert.equal(isTruncatedText(text),true,text);assert.equal(parseEmbeddedEvidence(embed(text),evidence()),undefined,text);
 }
 assert.equal(isTruncatedText('为了庆祝……我已经为所有付费用户重置了使用限制。'),false);
});
test('嵌入接口可注入、无登录、限流或外部跳转失败保留旧证据',async()=>{
 let called='';const fetched:typeof fetch=async(input,init)=>{called=String(input);assert.equal(init?.redirect,'manual');assert.equal(new Headers(init?.headers).has('cookie'),false);return new Response(JSON.stringify(embed(originalText)),{status:200});};
 assert.equal((await enrichKnownEvidence(evidence(),fetched))?.textOrigin,'original');assert.ok(called.startsWith('https://publish.twitter.com/oembed?'));
 assert.equal(await enrichKnownEvidence(evidence(),async()=>new Response('rate limited',{status:429})),undefined);
 assert.equal(await enrichKnownEvidence(evidence({url:'https://evil.invalid/path'}),()=>{throw new Error('must not fetch');}),undefined);
 assert.equal(await enrichKnownEvidence(evidence(),async()=>new Response(JSON.stringify({html:'x'.repeat(90000)}),{status:200})),undefined);
});
function releasesPage(page:number,date:string,size=RELEASE_PAGE_SIZE){return Array.from({length:size},(_,i)=>({id:page*1000+i,tag_name:`v${page}.${i}`,body:'Release changes',draft:false,prerelease:false,html_url:`https://github.com/openai/codex/releases/tag/v${page}.${i}`,published_at:date}));}
test('官方分页每轮有上限且持久断点补漏，总回看第一页',async()=>{
 const pages:number[]=[];
 const fetcher:typeof fetch=async url=>{const page=Number(new URL(String(url)).searchParams.get('page'));pages.push(page);return new Response(JSON.stringify(releasesPage(page,at)));};
 const initial=await fetchReleasePages({...release,cursor:'2026-10-08T12:00:00Z'},fetcher);
 assert.equal(pages.length,MAX_RELEASE_PAGES);assert.deepEqual(pages,[1,2,3]);assert.equal(initial.scan.nextPage,4);assert.equal(initial.scan.baseline,'2026-10-08T12:00:00Z');
 pages.length=0;const resumed=await fetchReleasePages({...release,cursor:'2026-10-08T12:00:00Z',releaseScan:initial.scan},fetcher);
 assert.deepEqual(pages,[1,3,4]);assert.equal(resumed.scan.nextPage,5);assert.equal(new Set(resumed.records.map(r=>r.messageId)).size,resumed.records.length);
});
test('官方分页达到回看边界或列表末尾自动结束，不请求任意链接',async()=>{
 const pages:number[]=[];
 const source:Source={...release,cursor:at};
 const result=await fetchReleasePages(source,async url=>{const parsed=new URL(String(url));assert.equal(parsed.origin,'https://api.github.com');assert.equal(parsed.pathname,'/repos/openai/codex/releases');const page=Number(parsed.searchParams.get('page'));pages.push(page);return new Response(JSON.stringify(releasesPage(page,page===1?at:'2026-10-01T00:00:00Z')));});
 assert.deepEqual(pages,[1,2]);assert.equal(result.scan.nextPage,1);assert.equal(result.scan.newestAt,at);assert.ok(result.scan.completedAt);
 const empty=await fetchReleasePages(source,async()=>new Response('[]'));assert.equal(empty.scan.nextPage,1);assert.deepEqual(empty.records,[]);
});

test('明确取消及更正仍需正文中同时具有福利类型和资格',()=>{
 for(const text of ['所有付费账户的重置卡发放已取消。','更正：所有付费账户的重置卡改为稍后发放。','The banked reset for all paid accounts has been cancelled.']){
  assert.equal(parseEmbeddedEvidence(embed(text),evidence())?.contextComplete,true,text);
 }
 assert.equal(parseEmbeddedEvidence(embed('已取消。'),evidence())?.contextComplete,false);
 assert.equal(parseEmbeddedEvidence(embed('The banked reset has been cancelled.'),evidence())?.contextComplete,false);
});
test('嵌入官方迁移最多一跳，其他域、路径或改原帖查询拒绝',async()=>{
 const request=new URL('https://publish.twitter.com/oembed?url=https%3A%2F%2Fx.com%2Fthsottiaux%2Fstatus%2F222&omit_script=true&dnt=true');
 const valid=request.toString().replace('publish.twitter.com','publish.x.com');
 assert.equal(allowedEmbedRedirect(valid,request)?.hostname,'publish.x.com');
 for(const bad of [valid.replace('publish.x.com','evil.invalid'),valid.replace('/oembed?','/login?'),valid.replace('222','333'),valid+'&tracking=extra'])assert.equal(allowedEmbedRedirect(bad,request),undefined);
 let count=0;
 const enriched=await enrichKnownEvidence(evidence(),async url=>{count++;return count===1?new Response('',{status:301,headers:{location:String(url).replace('publish.twitter.com','publish.x.com')}}):new Response(JSON.stringify(embed(originalText)));});
 assert.equal(count,2);assert.equal(enriched?.textOrigin,'original');
 count=0;
 const blocked=await enrichKnownEvidence(evidence(),async url=>{count++;return new Response('',{status:301,headers:{location:String(url).replace('publish.twitter.com','publish.x.com')}});});
 assert.equal(count,2);assert.equal(blocked,undefined);
});

test('活动条目日期不匹配规则时不强行加入每日记录',()=>{
 const definition=parseActivityDefinition(challenge(),activity.url)!;
 const dated=challenge().replace('<span>第3天</span>','<span>第3天</span><time datetime="2026-10-07"></time>');
 assert.equal(parseArchive(dated,activity,at,definition)[0].metadata?.activityDay,3);
 assert.equal(parseArchive(dated.replace('2026-10-07','2026-10-08'),activity,at,definition)[0].metadata?.activityDay,undefined);
 assert.equal(parseArchive(challenge(),activity,at,definition)[0].activityDay,undefined);
});
