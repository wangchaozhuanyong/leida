import pg from 'pg';

type ProbeClient = {
  connect(): Promise<unknown>;
  query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<unknown>;
};
type ClientFactory = (connectionString: string) => ProbeClient;
export type NativeDatabaseHealth = {
  database: 'ready' | 'unavailable';
  probe: 'native-connection-only';
  diagnosticCode?: string;
};

const failure = (diagnosticCode: string): NativeDatabaseHealth => ({
  database: 'unavailable', probe: 'native-connection-only', diagnosticCode,
});
const createClient: ClientFactory = connectionString => {
  const client = new pg.Client({
    connectionString, connectionTimeoutMillis: 3000, query_timeout: 3000,
    statement_timeout: 3000, application_name: 'reset-radar-connection-check',
  });
  // Connection details remain private, including errors between connect/query/end.
  client.on('error', () => {});
  return client;
};

/** Explicit connection test only. Reads no business rows and never selects a backend. */
export async function nativeDatabaseHealth(
  connectionString: string | undefined,
  factory: ClientFactory = createClient,
): Promise<NativeDatabaseHealth> {
  if (!connectionString) return failure('NATIVE_DB_NOT_CONFIGURED');
  try {
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname ||
        !url.username || !url.password || url.pathname.length < 2) {
      return failure('NATIVE_DB_CONFIG_INVALID');
    }
  } catch { return failure('NATIVE_DB_CONFIG_INVALID'); }

  let client: ProbeClient | undefined;
  try {
    client = factory(connectionString);
    await client.connect();
    const result = await client.query('SELECT 1 AS ready');
    return result.rows[0]?.ready === 1
      ? { database: 'ready', probe: 'native-connection-only' }
      : failure('NATIVE_DB_INVALID_RESPONSE');
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (code === '28P01') return failure('NATIVE_DB_AUTH_FAILED');
    if (code === '28000' || code === '42501') return failure('NATIVE_DB_ACCESS_DENIED');
    if (code === '3D000') return failure('NATIVE_DB_DATABASE_MISSING');
    if (code === '53300') return failure('NATIVE_DB_CONNECTION_LIMIT');
    if (['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(String(code))) {
      return failure('NATIVE_DB_UNREACHABLE');
    }
    return failure('NATIVE_DB_CONNECTION_FAILED');
  } finally {
    try { await client?.end(); } catch { /* Never expose cleanup errors or connection URLs. */ }
  }
}

/** Share concurrent checks and briefly reuse results so a public probe cannot open
 * a fresh database connection for every HTTP request. Configuration changes reset it. */
export function createNativeDatabaseHealthCheck(check = nativeDatabaseHealth, clock = Date.now) {
  let current: { connectionString: string | undefined; pending?: Promise<NativeDatabaseHealth>;
    result?: NativeDatabaseHealth; expiresAt: number } | undefined;
  return (connectionString: string | undefined): Promise<NativeDatabaseHealth> => {
    if (current && current.connectionString === connectionString) {
      if (current.pending) return current.pending;
      if (current.result && clock() < current.expiresAt) return Promise.resolve(current.result);
    }
    const next: NonNullable<typeof current> = { connectionString, expiresAt: 0 };
    current = next;
    next.pending = check(connectionString).then(result => {
      next.result = result;
      next.expiresAt = clock() + 10_000;
      next.pending = undefined;
      return result;
    });
    return next.pending;
  };
}

export const getNativeDatabaseHealth = createNativeDatabaseHealthCheck();
