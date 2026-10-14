const { configurationError, createTransport } = require('./transport');
const merge = (a, b) => [...new Map([...a, ...b].map(item => [item.id, item])).values()];
const query = options => Object.entries(options).filter(([,value]) => value !== undefined && value !== null && value !== '').map(([key,value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
/** Foreground public reads; independent views and response epochs protect page changes. */
function createClient({ wxApi, config, timers = { setTimeout, clearTimeout }, now = () => Date.now(), random = Math.random }) {
  const request = createTransport(wxApi, config), listeners = new Set();
  let state = { data: null, version: '', contentVersion:'', page:null, loading: false, error: configurationError(config), unconfigured: !!configurationError(config), receivedAt: 0 };
  let active = false, timer, pending, epoch = 0, task, failures = 0, view = {view:'home'};
  const emit = patch => { state = { ...state, ...patch }; listeners.forEach(fn => fn(state)); };
  function schedule() {
    if (!active || state.unconfigured) return;
    if(timer!==undefined)timers.clearTimeout(timer);
    timer = timers.setTimeout(() => { timer=undefined; void refresh(true).finally(schedule); }, Math.min(60000, Math.max(5000, Number(config.pollMs)||5000) * 2 ** failures) + random()*1000);
  }
  async function run(checkOnly, cursor) {
    const generation = epoch;
    emit({ loading: true });
    try {
      const path = `/api/v1/bootstrap?${query({...view,...(cursor?{cursor}:{})})}`;
      task = request(checkOnly && state.data ? '/api/v1/version?light=1' : path, checkOnly ? state.version : undefined);
      let result = await task.promise;
      if (generation !== epoch) return;
      if (checkOnly && state.data) {
        if (result.unchanged || result.version === state.version) { failures=0; emit({ error: '' }); return; }
        const stateOnly = !!result.contentVersion && result.contentVersion === state.contentVersion;
        task = request(stateOnly ? '/api/v1/bootstrap?view=state' : path); result = await task.promise;
        if (generation !== epoch) return;
        if (stateOnly && result.contentVersion === state.contentVersion) {
          failures=0; emit({data:{...state.data,sources:result.data.sources,serverTime:result.data.serverTime},version:result.version,receivedAt:now(),error:''}); return;
        }
        if (stateOnly) { task=request(path); result=await task.promise; if(generation!==epoch)return; }
      }
      let data=result.data, page=result.page||null;
      if(cursor && state.data) {
        data={...data,...Object.fromEntries(['events','articles','publications','evidence','notices'].map(key=>[key,merge(state.data[key],data[key])]))};
        page={...page,ids:[...new Set([...(state.page?.ids||[]),...(page?.ids||[])])]};
      }
      failures=0; emit({ data, page, version: result.version, contentVersion:result.contentVersion||'', receivedAt: now(), error: '' });
    } catch (error) { if (generation === epoch) { failures=Math.min(4,failures+1); emit({ error: error.message || '资料暂时无法加载' }); } }
    finally { if (generation === epoch) emit({ loading: false }); }
  }
  function refresh(checkOnly = false, cursor) {
    if (state.unconfigured) { emit({ loading: false, error: configurationError(config) }); return Promise.resolve(); }
    if (pending) return pending;
    const work = run(checkOnly,cursor); pending=work;
    work.finally(() => { if(pending===work)pending=undefined; }); return work;
  }
  function cancel() { epoch++; if(task)task.abort(); task=undefined;pending=undefined; }
  return {
    subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
    getState() { return state; }, refresh,
    setView(next) {
      if (JSON.stringify(next)===JSON.stringify(view)) return refresh(true);
      cancel(); view={...next}; emit({data:null,page:null,version:'',contentVersion:'',loading:false}); return refresh(false);
    },
    more() { return state.page?.nextCursor ? refresh(false,state.page.nextCursor) : Promise.resolve(); },
    start() { if(active)return pending||Promise.resolve(); active=true;failures=0;const first=refresh(!!state.data);first.finally(schedule);return first; },
    stop() { active=false;cancel();if(timer!==undefined)timers.clearTimeout(timer);timer=undefined;emit({loading:false}); }
  };
}
module.exports = { createClient };
