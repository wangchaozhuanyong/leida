import { CloudbaseRpc, CloudbaseRpcError } from './rpc';

export function cloudbaseAIUsage(rpc: CloudbaseRpc) {
  return {
    async summary(): Promise<{ calls: number; cost: number }> {
      const result = await rpc.call<{ calls: number; cost: number }>('radar_cb_ai_summary');
      if (!result || !Number.isInteger(result.calls) || result.calls < 0 || !Number.isFinite(result.cost) || result.cost < 0) throw new CloudbaseRpcError('response');
      return result;
    },
    async reserve(id: string, version: number, inputBound: number): Promise<'reserved' | 'budget' | 'configuration'> {
      const result = await rpc.call<unknown>('radar_cb_ai_reserve', { p_id: id, p_version: version, p_input_bound: inputBound });
      if (!['reserved', 'budget', 'configuration'].includes(String(result))) throw new CloudbaseRpcError('response');
      return result as 'reserved' | 'budget' | 'configuration';
    },
    async finish(id: string, status: 'succeeded' | 'estimated' | 'failed', inputTokens?: number, outputTokens?: number): Promise<void> {
      const result = await rpc.call<unknown>('radar_cb_ai_finish', { p_id: id, p_status: status, p_input_tokens: inputTokens ?? null, p_output_tokens: outputTokens ?? null });
      if (result !== 'recorded' && result !== 'settled') throw new CloudbaseRpcError('response');
    }
  };
}
