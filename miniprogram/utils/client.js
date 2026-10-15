const { configurationError, createTransport } = require('./transport');
const merge = (a, b) => [...new Map([...a, ...b].map(item => [item.id, item])).values()];
const query = options => Object.entries(options).filter(([,value]) => value !== undefined && value !== null && value !== '').map(([key,value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
const sameContent = (a, b) => a.contentVersion && b.contentVersion ? a.contentVersion === b.contentVersion : a.version === b.version;
const append = (a, b) => ({ ...b, data:{...b.data,...Object.fromEntries(['events','articles','publications','evidence','notices'].map(key=>[key,merge(a.data[key],b.data[key])]))},page:{...b.page,ids:[...new Set([...(a.page?.ids||[]),...(b.page?.ids||[])])]} });
/** Foreground public reads; independent views and response epochs protect page changes. */
function createClient({ wxApi, config, timers = { setTimeout, clearTimeout }, now = () => Date.now(), random = Math.random }) {
  const request = createTransport(wxApi, config), listeners = new Set(), views = new Map();
  const empty = () => ({ data: null, version: '', contentVersion:'', page:null, pagesLoaded:0, loading: false, error: configurationError(config), unconfigured: !!configurationError(config), receivedAt: 0, validatedAt: -Infinity });
  let state = empty();
  let active = false, timer, pending, epoch = 0, task, failures = 0, view = {view:'home'};
  const pollMs = Math.max(5000, Number(config.pollMs)||300000);
  let latestVersion = '', lastCheckAt = -Infinity;
  const emit = patch => {
    state = { ...state, ...patch };
    if (state.data) views.set(query(view), { ...state, loading:false });
    listeners.forEach(fn => fn(state));
  };
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
    emit({ loading: true });
    try {
      lastCheckAt = now();
      const path = pathFor(cursor);
      let result = await read(checkOnly && state.data ? '/api/v1/version?light=1' : path, checkOnly ? state.version : undefined);
      if (checkOnly && state.data) {
        if (result.unchanged || result.version === state.version) { failures=0; latestVersion=state.version; emit({ error: '', validatedAt:now() }); return; }
        const stateOnly = !!result.contentVersion && result.contentVersion === state.contentVersion;
        result = await read(stateOnly ? '/api/v1/bootstrap?view=state' : path);
        if (stateOnly && result.contentVersion === state.contentVersion) {
          failures=0; latestVersion=result.version; emit({data:{...state.data,sources:result.data.sources,serverTime:result.data.serverTime},version:result.version,receivedAt:now(),validatedAt:now(),error:''}); return;
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
      failures=0; latestVersion=result.version; emit({ data:result.data, page:result.page||null, pagesLoaded, version: result.version, contentVersion:result.contentVersion||'', receivedAt: now(), validatedAt:now(), error: '' });
    } catch (error) { if (generation === epoch) { failures=Math.min(4,failures+1); emit({ error: error.message || '资料暂时无法加载',...(invalidated?{page:state.page?{...state.page,nextCursor:null}:null,validatedAt:-Infinity}:{}) }); } }
    finally { if (generation === epoch) emit({ loading: false }); }
  }
  function refresh(checkOnly = false, cursor) {
    if (state.unconfigured) { emit({ loading: false, error: configurationError(config) }); return Promise.resolve(); }
    if (pending) return pending;
    const work = run(checkOnly,cursor); pending=work;
    work.finally(() => { if(pending===work)pending=undefined; }); return work;
  }
  function cancel() { epoch++; if(task)task.abort(); task=undefined;pending=undefined; }
  const current = () => state.data && !state.error && state.version===latestVersion && now()-state.validatedAt<pollMs;
  return {
    subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
    getState() { return state; }, refresh,
    setView(next) {
      if (JSON.stringify(next)===JSON.stringify(view)) return current() ? pending||Promise.resolve() : refresh(true);
      cancel(); view={...next};
      // Each page/filter restores only its own validated snapshot. Known version
      // changes and expiry revalidate it; a cold page never shows another view.
      const cached=views.get(query(view));
      state={...empty(),...cached}; emit({});
      return current() ? Promise.resolve() : refresh(!!cached?.data);
    },
    more() { return state.page?.nextCursor ? refresh(false,state.page.nextCursor) : Promise.resolve(); },
    start() { if(active)return pending||Promise.resolve(); active=true;const first=state.data&&now()-lastCheckAt<60000?Promise.resolve():refresh(!!state.data);first.finally(schedule);return first; },
    stop() { active=false;cancel();if(timer!==undefined)timers.clearTimeout(timer);timer=undefined;emit({loading:false}); }
  };
}
module.exports = { createClient };
