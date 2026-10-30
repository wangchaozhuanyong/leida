const { configurationError, createTransport } = require('./transport');
const {createPublicSnapshot}=require('./public-snapshot');
const merge = (a, b) => [...new Map([...a, ...b].map(item => [item.id, item])).values()];
const query = options => Object.entries(options).sort(([a],[b])=>a.localeCompare(b)).filter(([,value]) => value !== undefined && value !== null && value !== '').map(([key,value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
const sameContent = (a, b) => a.contentVersion && b.contentVersion ? a.contentVersion === b.contentVersion : a.version === b.version;
const append = (a, b) => ({ ...b, data:{...b.data,...Object.fromEntries(['events','articles','publications','evidence','notices'].map(key=>[key,merge(a.data[key],b.data[key])]))},page:{...b.page,ids:[...new Set([...(a.page?.ids||[]),...(b.page?.ids||[])])]} });
const isAddition = (before, after) => after.publications.length > before.publications.length && ['publications','articles','events','evidence','notices'].every(key => before[key].every(item => after[key].some(next => next.id === item.id && JSON.stringify(next) === JSON.stringify(item))));
const pinned = view => ['home','notices','calendar'].includes(view.view) || ['news','history'].includes(view.view) && (!view.filter || view.filter === 'all');
/** Foreground public reads; independent views and response epochs protect page changes. */
function createClient({ wxApi, config, timers = { setTimeout, clearTimeout }, now = () => Date.now(), random = Math.random }) {
  const request = createTransport(wxApi, config), listeners = new Set(), views = new Map();
  const empty = () => ({ data: null, version: '', contentVersion:'', page:null, pagesLoaded:0, loading: false, loadingMore:false, moreError:'', updateAvailable:false, candidate:null, snapshotPending:false, error: configurationError(config), unconfigured: !!configurationError(config), receivedAt: 0, validatedAt: -Infinity });
  let state = empty();
  let active = false, suspended=false, timer, pending, epoch = 0, task, failures = 0, view = {view:'home'};
  const pollMs = Math.max(5000, Number(config.pollMs)||300000);
  let latestVersion = '', latestContentVersion = '', lastCheckAt = -Infinity;
  const pinnedKeys = new Set();
  let prefetchTask, prefetchEpoch = 0;
  const warmQueue=[],snapshots=new Map();
  const primaryViews=[{view:'calendar'},{view:'news',filter:'all'},{view:'notices'}];
  function snapshotFor(target){
    if(!['home','calendar','news','notices'].includes(target.view)||Object.keys(target).some(key=>key!=='view'&&(key!=='filter'||target.view!=='news'||!['','all',undefined].includes(target.filter))))return null;
    if(!snapshots.has(target.view))snapshots.set(target.view,createPublicSnapshot(wxApi,config,{now,timers,view:target.view}));
    return snapshots.get(target.view);
  }
  let hydration,networkRevision=0;
  const emit = patch => {
    state = { ...state, ...patch };
    if (state.data) {
      const key=query(view);views.delete(key);views.set(key, { ...state, loading:false, loadingMore:false });
      if(pinned(view))pinnedKeys.add(key);
      for(const cachedKey of views.keys()) {
        if(views.size<=20)break;
        if(cachedKey!==key&&!pinnedKeys.has(cachedKey))views.delete(cachedKey);
      }
    }
    listeners.forEach(fn => fn(state));
  };
  function restoreSnapshot(){
    const key=query(view),snapshot=snapshotFor(view);
    if(hydration?.key===key||state.data||state.unconfigured||!snapshot)return;
    const generation=epoch,revision=networkRevision;
    const work=snapshot.load().then(saved=>{
      if(!saved||generation!==epoch||revision!==networkRevision||query(view)!==key||state.data)return;
      emit({data:saved.data,version:saved.version,contentVersion:saved.contentVersion,page:saved.page||null,receivedAt:saved.savedAt,snapshotPending:true,validatedAt:-Infinity,pagesLoaded:1});
    }).finally(()=>{if(hydration?.promise===work)hydration=undefined;});
    hydration={key,promise:work};
  }
  // Read each tab's existing public snapshot at launch, without waiting for the
  // homepage request or serial network prefetch. Never reuse another view's data.
  function primePublicSnapshots(){
    const generation=prefetchEpoch;
    for(const next of primaryViews){
      const key=query(next);if(views.get(key)?.data)continue;
      const snapshot=snapshotFor(next);if(!snapshot)continue;
      void snapshot.load().then(saved=>{
        if(!saved||suspended||generation!==prefetchEpoch||views.get(key)?.data)return;
        const value={...empty(),data:saved.data,version:saved.version,contentVersion:saved.contentVersion,page:saved.page||null,receivedAt:saved.savedAt,snapshotPending:true,validatedAt:-Infinity,pagesLoaded:1};
        views.set(key,value);pinnedKeys.add(key);
        if(query(view)===key&&!state.data)emit({...value,loading:state.loading,error:state.error});
      });
    }
  }
  const canPrefetch=()=>!suspended&&!pending&&!state.loading&&!state.snapshotPending&&!!state.data&&!state.error&&!state.unconfigured;
  function prefetch(next,queued=false){
    const key=query(next),cached=views.get(key);
    if(!canPrefetch()||query(view)===key||cached?.data&&!cached.snapshotPending&&now()-cached.validatedAt>=0&&now()-cached.validatedAt<pollMs&&cached.version===latestVersion)return Promise.resolve(null);
    if(prefetchTask)return prefetchTask.key===key?prefetchTask.promise:Promise.resolve(null);
    const generation=prefetchEpoch,beforeContent=latestContentVersion,requestTask=request(`/api/v1/bootstrap?${key}`);
    const flight={key,view:next,queued,task:requestTask,promise:null};
    const promise=requestTask.promise.then(result=>{
      if(generation!==prefetchEpoch||beforeContent!==latestContentVersion&&result.contentVersion!==latestContentVersion)return null;
      const value={...empty(),data:result.data,version:result.version,contentVersion:result.contentVersion||'',page:result.page||null,pagesLoaded:1,receivedAt:now(),validatedAt:now(),error:''};
      views.set(key,value);pinnedKeys.add(key);snapshotFor(next)?.save(value);
      return {value};
    }).catch(error=>generation===prefetchEpoch?{error:error.message||'资料暂时无法更新，请重试。'}:null).finally(()=>{
      if(prefetchTask===flight)prefetchTask=undefined;
      void Promise.resolve().then(pumpPrefetch);
    });
    flight.promise=promise;prefetchTask=flight;return promise;
  }
  function pumpPrefetch(){
    if(!canPrefetch()||prefetchTask||!warmQueue.length)return;
    const next=warmQueue.shift();void prefetch(next,true).finally(()=>{void Promise.resolve().then(pumpPrefetch);});
  }
  function schedule() {
    if (!active || state.unconfigured) return;
    if(timer!==undefined)timers.clearTimeout(timer);
    timer = timers.setTimeout(() => { timer=undefined; void refresh(true).finally(schedule); }, Math.min(Math.max(pollMs,900000), pollMs * 2 ** failures) + random()*1000);
  }
  async function run(checkOnly, cursor) {
    const generation = epoch;
    const previous = state;
    let invalidated = false;
    const pathFor = next => `/api/v1/bootstrap?${query({...view,...(next?{cursor:next}:{})})}`;
    const read = async (path, version) => {
      task=request(path,version); const result=await task.promise;
      if(generation!==epoch)throw new Error('cancelled');
      return result;
    };
    // Rebuild the already-read range as one coherent snapshot. A racing revision
    // gets one bounded retry; no partial pages are emitted to subscribers.
    const rebuild = async (count, first) => {
      for(let attempt=0;attempt<2;attempt++) {
        let result=first||await read(pathFor()); first=undefined;
        let pagesLoaded=1, changed=false; const cursors=new Set();
        while(pagesLoaded<count&&result.page?.nextCursor) {
          const next=result.page.nextCursor;
          if(cursors.has(next))throw new Error('分页资料暂时无法更新，请重试');
          cursors.add(next);
          const page=await read(pathFor(next));
          if(!sameContent(result,page)){changed=true;invalidated=true;break;}
          result=append(result,page);pagesLoaded++;
        }
        if(!changed)return {...result,pagesLoaded};
      }
      throw new Error('内容正在更新，请稍后重试');
    };
    emit({ loading: true, loadingMore:!!cursor, ...(cursor?{moreError:''}:{}) });
    try {
      lastCheckAt = now();
      const path = pathFor(cursor);
      const versionCheck=checkOnly&&state.data&&!state.snapshotPending;
      let result = await read(versionCheck ? '/api/v1/version?light=1' : path, versionCheck ? state.candidate?.version||state.version : undefined);
      if (versionCheck) {
        if (result.unchanged || result.version === (state.candidate?.version||state.version)) { failures=0; latestVersion=state.candidate?.version||state.version; emit({ error: '', validatedAt:now() }); return; }
        const stateOnly = !!result.contentVersion && result.contentVersion === (state.candidate?.contentVersion||state.contentVersion);
        result = await read(stateOnly ? '/api/v1/bootstrap?view=state' : path);
        if(stateOnly && state.candidate && result.contentVersion===state.candidate.contentVersion){
          failures=0;latestVersion=result.version;latestContentVersion=result.contentVersion||latestContentVersion;emit({candidate:{...state.candidate,version:result.version,data:{...state.candidate.data,sources:result.data.sources,serverTime:result.data.serverTime}},validatedAt:now(),error:''});return;
        }
        if (stateOnly && result.contentVersion === state.contentVersion) {
          failures=0; latestVersion=result.version;latestContentVersion=result.contentVersion||latestContentVersion; emit({data:{...state.data,sources:result.data.sources,serverTime:result.data.serverTime},version:result.version,receivedAt:now(),validatedAt:now(),error:''}); return;
        }
        if (stateOnly) result=await read(path);
      }
      let pagesLoaded=1;
      if(cursor && previous.data && sameContent(previous,result)) {
        result=append(previous,result);pagesLoaded=(previous.pagesLoaded||1)+1;
      } else {
        invalidated=!!previous.data&&!sameContent(previous,result);
        const count=Math.max(1,previous.pagesLoaded||1)+(cursor?1:0);
        result=await rebuild(count,cursor?undefined:result);pagesLoaded=result.pagesLoaded;
      }
      failures=0; networkRevision++; latestVersion=result.version;latestContentVersion=result.contentVersion||latestContentVersion;
      const next={ data:result.data, page:result.page||null, pagesLoaded, version:result.version, contentVersion:result.contentVersion||'', receivedAt:now(), validatedAt:now(), snapshotPending:false, error:'', moreError:'' };
      if(checkOnly && previous.data && ['news','history'].includes(view.view) && isAddition(previous.data,result.data))emit({candidate:next,updateAvailable:true,validatedAt:now(),error:''});
      else emit({...next,candidate:null,updateAvailable:false});
      snapshotFor(view)?.save(next);
    } catch (error) { if (generation === epoch) { failures=Math.min(4,failures+1); emit({ [cursor?'moreError':'error']: error.message || '资料暂时无法加载',...(invalidated?{page:state.page?{...state.page,nextCursor:null}:null,validatedAt:-Infinity}:{}) }); } }
    finally { if (generation === epoch) emit({ loading: false, loadingMore:false }); }
  }
  function refresh(checkOnly = false, cursor) {
    if (state.unconfigured) { emit({ loading: false, error: configurationError(config) }); return Promise.resolve(); }
    if (pending) return pending;
    if(prefetchTask){
      prefetchEpoch++;const previous=prefetchTask;prefetchTask=undefined;previous.task.abort();
      if(previous.queued&&!warmQueue.some(next=>query(next)===previous.key))warmQueue.push(previous.view);
    }
    const work = run(checkOnly,cursor); pending=work;
    work.finally(() => { if(pending===work)pending=undefined;pumpPrefetch(); }); return work;
  }
  function cancel() { epoch++; if(task)task.abort(); task=undefined;pending=undefined; }
  const current = () => state.data && !state.snapshotPending && !state.error && (state.candidate?.version||state.version)===latestVersion && now()-state.validatedAt>=0 && now()-state.validatedAt<pollMs;
  return {
    subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
    getState() { return state; }, refresh,
    prefetchCalendar() { return prefetch({view:'calendar'}); },
    prefetchPrimaryViews(){
      for(const next of primaryViews)if(query(next)!==query(view)&&!warmQueue.some(item=>query(item)===query(next))&&prefetchTask?.key!==query(next))warmQueue.push(next);
      pumpPrefetch();
    },
    setView(next) {
      if (query(next)===query(view)) {restoreSnapshot();return current() ? pending||Promise.resolve() : refresh(true);}
      cancel(); view={...next};
      // Each page/filter restores only its own validated snapshot. Known version
      // changes and expiry revalidate it; a cold page never shows another view.
      const restore=()=>{const cached=views.get(query(view));state={...empty(),...cached};emit({});restoreSnapshot();return current()?Promise.resolve():refresh(!!cached?.data);};
      if(prefetchTask?.key===query(next)){
        const generation=epoch,flight=prefetchTask;state={...empty(),...views.get(query(next))};emit({loading:true});restoreSnapshot();
        const work=flight.promise.then(result=>{
          if(generation!==epoch)return;
          if(result?.error){emit({loading:false,error:result.error});return;}
          networkRevision++;
          if(result?.value){latestVersion=result.value.version;latestContentVersion=result.value.contentVersion||latestContentVersion;lastCheckAt=now();}
          if(pending===work)pending=undefined;
          return restore();
        }).finally(()=>{if(pending===work)pending=undefined;pumpPrefetch();});
        pending=work;return work;
      }
      return restore();
    },
    applyUpdates() { if(state.candidate)emit({...state.candidate,candidate:null,updateAvailable:false}); },
    more() { if(state.snapshotPending||state.moreError&&!state.page?.nextCursor)return refresh(false);if(state.candidate)emit({...state.candidate,candidate:null,updateAvailable:false}); return state.page?.nextCursor ? refresh(false,state.page.nextCursor) : Promise.resolve(); },
    start() { if(active)return pending||Promise.resolve(); active=true;suspended=false;restoreSnapshot();const first=state.data&&!state.snapshotPending&&now()-lastCheckAt>=0&&now()-lastCheckAt<60000?Promise.resolve():refresh(!!state.data);primePublicSnapshots();first.finally(schedule);return first; },
    stop() { active=false;suspended=true;prefetchEpoch++;warmQueue.length=0;if(prefetchTask)prefetchTask.task.abort();prefetchTask=undefined;cancel();if(timer!==undefined)timers.clearTimeout(timer);timer=undefined;emit({loading:false,loadingMore:false}); }
  };
}
module.exports = { createClient };
