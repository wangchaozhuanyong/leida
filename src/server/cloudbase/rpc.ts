const operations = ['radar_cb_auth_snapshot', 'radar_cb_auth_commit', 'radar_cb_claim_job', 'radar_cb_finish_job', 'radar_cb_public_version', 'radar_cb_public_bundle', 'radar_cb_forecast_snapshot', 'radar_cb_store_read', 'radar_cb_store_commit', 'radar_cb_store_lease', 'radar_cb_owner_exists', 'radar_cb_ai_summary', 'radar_cb_ai_reserve', 'radar_cb_ai_finish'] as const;
export type CloudbaseOperation = typeof operations[number];
export class CloudbaseRpcError extends Error {
  constructor(public readonly kind: 'configuration' | 'rejected' | 'conflict' | 'unknown' | 'response', public readonly status?: number) {
    super(kind === 'conflict' ? '数据库内容已变化，请刷新后重试' : kind === 'unknown' ? '数据库请求结果未知，已停止自动重试' : '数据库接口暂不可用');
    this.name = 'CloudbaseRpcError';
  }
}

/** Backend only. No generic SQL, redirects, response-body logging or write retries. */
export class CloudbaseRpc {
  readonly #token: string;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  constructor(envId: string, apiKey: string, transport: typeof fetch = fetch) {
    if (!/^[a-z][a-z0-9-]{3,80}$/.test(envId) || !apiKey || /[\r\n]/.test(apiKey)) throw new CloudbaseRpcError('configuration');
    this.#endpoint = `https://${envId}.api.tcloudbasegateway.com/v1/rdb/rest/rpc/`;
    this.#token = apiKey;
    this.#fetch = transport;
  }
  async call<T>(operation: CloudbaseOperation, params: Record<string, unknown> = {}): Promise<T> {
    if (!(operations as readonly string[]).includes(operation)) throw new CloudbaseRpcError('configuration');
    let body: string;
    try { body = JSON.stringify(params); } catch { throw new CloudbaseRpcError('configuration'); }
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new CloudbaseRpcError('configuration');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await this.#fetch(this.#endpoint + operation, { method: 'POST', headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' }, body, redirect: 'error', cache: 'no-store', signal: controller.signal });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new CloudbaseRpcError('response', response.status); }
          chunks.push(result.value);
        }
      } finally { reader.releaseLock(); }
      let result: unknown;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CloudbaseRpcError('response', response.status); }
      if (!response.ok) {
        const code = typeof result === 'object' && result !== null && 'code' in result ? result.code : undefined;
        // The CloudBase gateway wraps PostgreSQL SQLSTATE as DATABASE_<code>.
        // Recognize only the observed conflict codes; do not inspect private messages.
        throw new CloudbaseRpcError(code === '40001' || code === 'DATABASE_40001' ? 'conflict' : 'rejected', response.status);
      }
      return result as T;
    } catch (error) {
      if (error instanceof CloudbaseRpcError) throw error;
      // A request can commit before a connection drops. Never retry it silently.
      throw new CloudbaseRpcError('unknown');
    } finally { clearTimeout(timeout); }
  }
}
