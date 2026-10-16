export const WORKER_IDLE_MS = 15_000;
export const WORKER_HEARTBEAT_MS = 60_000;
const intervals = { sources: 60_000, generation: 5*60_000, wechat: 30_000, forecast: 60_000 };
type Maintenance = keyof typeof intervals;

/** Local cadence only; database leases and read-set validation remain authoritative. */
export function createWorkerCadence(clock = Date.now) {
  const due = new Map<Maintenance, number>();
  const pending = new Map<Maintenance, Promise<void>>();
  const revisions = new Map<Maintenance, number>();
  const inputs = new Map<Maintenance, string | undefined>();
  const nudge=(...names:Maintenance[])=>{for(const name of names){due.delete(name);revisions.set(name,(revisions.get(name)??0)+1);}};
  return {
    nudge(...names: Maintenance[]) {
      nudge(...names);
    },
    /** Persistent input revisions also wake service/admin/backfill writes from another process. */
    observe(name:Maintenance,revision:string|undefined) {
      if(!inputs.has(name)||inputs.get(name)!==revision){inputs.set(name,revision);nudge(name);}
    },
    run(name: Maintenance, work: () => Promise<void>): Promise<void> {
      const old = pending.get(name);
      if (old) return old;
      if (clock() < (due.get(name) ?? -Infinity)) return Promise.resolve();
      const revision = revisions.get(name);
      const task = Promise.resolve().then(work).then(() => {
        if (revisions.get(name) === revision) due.set(name, clock() + intervals[name]);
      }, error => {
        // A failure is not a successful scan. Retry soon, without hammering an isolated database.
        if (revisions.get(name) === revision) due.set(name, clock() + WORKER_IDLE_MS);
        throw error;
      }).finally(() => { pending.delete(name); });
      pending.set(name, task);
      return task;
    },
  };
}

export function workerRetryDelay(failures: number): number {
  return Math.min(60_000, WORKER_IDLE_MS * 2 ** Math.min(2, Math.max(0, failures - 1)));
}

/** All heartbeat writes share this channel, including error transitions during long jobs. */
export function createWorkerHeartbeat(write: (error?: string, processedAt?: string) => Promise<void>, clock = Date.now) {
  let error: string | undefined, processedAt: string | undefined;
  let revision = 0, attemptedRevision = -1, attemptedAt = -Infinity;
  let pending: Promise<void> | undefined;
  const flush = (): Promise<void> => {
    if (pending) return pending.then(flush);
    if (attemptedRevision === revision && clock() - attemptedAt < WORKER_HEARTBEAT_MS) return Promise.resolve();
    const snapshot = { error, processedAt };
    attemptedAt = clock(); attemptedRevision = revision;
    const task = Promise.resolve().then(() => write(snapshot.error, snapshot.processedAt)).then(() => {
      if (processedAt === snapshot.processedAt) processedAt = undefined;
    }, () => { /* Retain the completion time; retry on the next heartbeat or state change. */ })
      .finally(() => { pending = undefined; });
    pending = task;
    return task;
  };
  return {
    processed() { processedAt = new Date(clock()).toISOString(); },
    setError(value?: string) { if (error !== value) { error = value; revision++; } },
    flush,
    settled: () => pending ?? Promise.resolve(),
  };
}
