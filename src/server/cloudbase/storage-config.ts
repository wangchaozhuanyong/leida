import { CloudbaseRpc, CloudbaseRpcError } from './rpc';

let current: { env: string; key: string; rpc: CloudbaseRpc } | undefined;
/** Explicit whole business-store opt-in; never changes a running native process. */
export function configuredStorageRpc(): CloudbaseRpc | undefined {
  const mode = process.env.RADAR_STORAGE_BACKEND ?? 'native';
  if (mode === 'native') return;
  if (mode !== 'cloudbase') throw new CloudbaseRpcError('configuration');
  if (process.env.RADAR_PUBLIC_READ_BACKEND === 'native') throw new CloudbaseRpcError('configuration');
  const env = process.env.CLOUDBASE_ENV_ID ?? '', key = process.env.CLOUDBASE_API_KEY ?? '';
  if (current?.env === env && current.key === key) return current.rpc;
  const rpc = new CloudbaseRpc(env, key);
  current = { env, key, rpc };
  return rpc;
}
