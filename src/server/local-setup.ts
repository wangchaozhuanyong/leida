import { randomBytes } from 'node:crypto';
import { subscribe } from 'node:diagnostics_channel';
import type { IncomingMessage, Server } from 'node:http';

const setupProofKey = Symbol.for('radar.local-owner-setup');
const processState = globalThis as typeof globalThis & { [setupProofKey]?: string };
const setupProofHeader = 'x-radar-local-setup-proof';
const loopback = (address: string | undefined) =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

export function registerLocalOwnerSetup() {
  if (processState[setupProofKey]) return;
  const proof = randomBytes(32).toString('base64url');
  processState[setupProofKey] = proof;
  subscribe('http.server.request.start', (message) => {
    const { request, server } = message as { request: IncomingMessage; server: Server };
    // Strip client input before adding process-local proof to a direct request.
    delete request.headers[setupProofHeader];
    if (request.method !== 'POST' || request.url !== '/api/setup') return;
    const listener = server.address();
    const direct = !Object.keys(request.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-'));
    const origin = URL.parse(request.headers.origin ?? '');
    if (listener && typeof listener !== 'string' && loopback(listener.address)
      && loopback(request.socket.remoteAddress) && direct && origin
      && ['127.0.0.1','localhost','[::1]'].includes(origin.hostname)
      && origin.host === request.headers.host) request.headers[setupProofHeader] = proof;
  });
}

export function isDirectLocalOwnerSetup(request: Request) {
  const proof = processState[setupProofKey];
  return proof !== undefined && request.headers.get(setupProofHeader) === proof;
}
