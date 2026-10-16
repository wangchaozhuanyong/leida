const operations = ['radar_cb_auth_snapshot', 'radar_cb_auth_commit', 'radar_cb_claim_job', 'radar_cb_finish_job', 'radar_cb_public_version', 'radar_cb_public_bundle', 'radar_cb_forecast_snapshot', 'radar_cb_store_read', 'radar_cb_store_commit', 'radar_cb_store_lease', 'radar_cb_owner_exists', 'radar_cb_ai_summary', 'radar_cb_ai_reserve', 'radar_cb_ai_finish'] as const;
export type CloudbaseOperation = typeof operations[number];
// Only fixed platform/SQLSTATE/transport codes may reach an API response.
// Never retain provider messages, request URLs, parameters or credentials.
const diagnosticCodes = new Set([
  'INVALID_ENV', '40001', '42501', '42P01', '42883', '28000', '28P01',
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01', '53300', '57P03',
  'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003', 'PGRST202', 'PGRST204', 'PGRST205',
  'PGRST300', 'PGRST301', 'PGRST302', 'PGRST303',
  'INVALID_JSON', 'RESPONSE_TOO_LARGE', 'REQUEST_TIMEOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);
function safeDiagnosticCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const code = value.startsWith('DATABASE_') ? value.slice('DATABASE_'.length) : value;
  return diagnosticCodes.has(code) ? code : undefined;
}
function transportDiagnostic(error: unknown): string | undefined {
  const pending: unknown[] = [error], seen = new Set<unknown>();
  for (let i = 0; i < pending.length && i < 16; i++) {
    const item = pending[i];
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const value = item as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    const code = safeDiagnosticCode(value.code);
    if (code) return code;
    if (value.name === 'AbortError' || value.name === 'TimeoutError') return 'REQUEST_TIMEOUT';
    if (value.cause) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 8));
  }
}
export class CloudbaseRpcError extends Error {
  readonly diagnosticCode: string;
  constructor(public readonly kind: 'configuration' | 'rejected' | 'conflict' | 'unknown' | 'response', public readonly status?: number, code?: unknown) {
    super(kind === 'conflict' ? '数据库内容已变化，请刷新后重试' : kind === 'unknown' ? '数据库请求结果未知，已停止自动重试' : '数据库接口暂不可用');
    this.name = 'CloudbaseRpcError';
    const http = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status < 600 ? status : 0;
    this.diagnosticCode = `CB_${kind.toUpperCase()}_${http}_${safeDiagnosticCode(code) ?? 'UNCLASSIFIED'}`;
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
  async call<T>(operation: CloudbaseOperation, params: Record<string, unknown> = {}, options: {signal?: AbortSignal} = {}): Promise<T> {
    if (!(operations as readonly string[]).includes(operation)) throw new CloudbaseRpcError('configuration');
    let body: string;
    try { body = JSON.stringify(params); } catch { throw new CloudbaseRpcError('configuration'); }
    if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new CloudbaseRpcError('configuration');
    if (options.signal?.aborted) throw new CloudbaseRpcError('unknown', undefined, 'REQUEST_TIMEOUT');
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const assertActive = () => { if (controller.signal.aborted) throw new CloudbaseRpcError('unknown', undefined, 'REQUEST_TIMEOUT'); };
    let rejectAborted!: (error: CloudbaseRpcError) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
    const onAbort = () => {
      // A custom transport/body reader may ignore signal; the race still releases its caller.
      void reader?.cancel().catch(() => {});
      rejectAborted(new CloudbaseRpcError('unknown', undefined, 'REQUEST_TIMEOUT'));
    };
    const onExternalAbort = () => controller.abort();
    controller.signal.addEventListener('abort', onAbort, {once: true});
    options.signal?.addEventListener('abort', onExternalAbort, {once: true});
    if (options.signal?.aborted) controller.abort();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      return await Promise.race([aborted, (async () => {
      assertActive();
      const response = await this.#fetch(this.#endpoint + operation, { method: 'POST', headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' }, body, redirect: 'error', cache: 'no-store', signal: controller.signal });
      if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); assertActive(); }
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) try {
        for (;;) {
          const result = await reader.read();
          assertActive();
          if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new CloudbaseRpcError('response', response.status, 'RESPONSE_TOO_LARGE'); }
          chunks.push(result.value);
        }
      } finally { reader.releaseLock(); }
      let result: unknown;
      try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CloudbaseRpcError('response', response.status, 'INVALID_JSON'); }
      if (!response.ok) {
        const code = typeof result === 'object' && result !== null && 'code' in result ? result.code : undefined;
        // The CloudBase gateway wraps PostgreSQL SQLSTATE as DATABASE_<code>.
        // Preserve the existing conflict semantics and only an allowlisted code.
        throw new CloudbaseRpcError(code === '40001' || code === 'DATABASE_40001' ? 'conflict' : 'rejected', response.status, code);
      }
      assertActive();
      return result as T;
      })()]);
    } catch (error) {
      if (error instanceof CloudbaseRpcError) throw error;
      // A request can commit before a connection drops. Never retry it silently.
      throw new CloudbaseRpcError('unknown', undefined, controller.signal.aborted ? 'REQUEST_TIMEOUT' : transportDiagnostic(error));
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onExternalAbort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }
}
