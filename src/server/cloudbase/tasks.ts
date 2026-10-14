import type { Job } from '../../lib/types';
import { CloudbaseRpc, CloudbaseRpcError } from './rpc';

/** Domain calls for the CloudBase path; this does not emulate a pg connection. */
export function cloudbaseTasks(rpc: CloudbaseRpc) {
  return {
    async claim(): Promise<Job | undefined> {
      const result = await rpc.call<Job | null>('radar_cb_claim_job');
      if (result === null) return;
      if (!result || typeof result.id !== 'string' || result.status !== 'running' || typeof result.leaseUntil !== 'string' || !Number.isFinite(Date.parse(result.leaseUntil)) || !Number.isInteger(result.attempts)) throw new CloudbaseRpcError('response');
      return result;
    },
    async finish(job: Job, result: Pick<Job, 'status' | 'payload' | 'availableAt'> & Partial<Pick<Job, 'error' | 'finishedAt'>>): Promise<boolean> {
      if (job.status !== 'running' || !job.leaseUntil || !['queued', 'succeeded', 'failed'].includes(result.status)) throw new CloudbaseRpcError('configuration');
      const value = await rpc.call<unknown>('radar_cb_finish_job', { p_id: job.id, p_lease_until: job.leaseUntil, p_attempts: job.attempts, p_result: result });
      if (typeof value !== 'boolean') throw new CloudbaseRpcError('response');
      return value;
    }
  };
}
