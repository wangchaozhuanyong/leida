import {readFileSync} from 'node:fs';
import net from 'node:net';

let summary = 'pending';
export const networkDiagnosticSummary = () => summary;

function rpfCounter() {
  try {
    const lines = readFileSync('/proc/net/netstat', 'utf8').trim().split('\n');
    for (let index = 0; index + 1 < lines.length; index += 2) {
      const names = lines[index].trim().split(/\s+/);
      const position = names.indexOf('IPReversePathFilter');
      if (position < 0) continue;
      const value = Number(lines[index + 1].trim().split(/\s+/)[position]);
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
  } catch {}
  return null;
}
const delta = (start, end) => start !== null && end !== null && end >= start ? end - start : 'na';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));


function tcpProbe(target, timeoutMs) {
  return new Promise(resolve => {
    const socket = net.createConnection({host:target.hostname, port:Number(target.port || 80)});
    let ended = false;
    const finish = value => {if (ended) return; ended = true; clearTimeout(timer); socket.destroy(); resolve(value);};
    const timer = setTimeout(() => finish('tcp-timeout'), timeoutMs);
    socket.once('connect', () => finish('tcp-connected'));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED' ? 'tcp-refused' : 'tcp-error'));
  });
}

/** One bounded, read-only TCP probe to the same fixed gateway upstream. No request payload or credentials. */
export async function diagnoseGatewayNetwork(upstreamUrl, {idleMs = 10000, timeoutMs = 5000, controlUrl = null, log = console.log} = {}) {
  const target = new URL(upstreamUrl);
  if (target.protocol !== 'http:' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Invalid diagnostic upstream');
  const control = controlUrl ? new URL(controlUrl) : null;
  if (control && (control.protocol !== 'http:' || control.username || control.password || control.pathname !== '/' || control.search || control.hash)) throw new Error('Invalid diagnostic upstream');
  const before = rpfCounter();
  await wait(idleMs);
  const idle = rpfCounter();
  const state = await tcpProbe(target, timeoutMs);
  const probe = rpfCounter();
  await wait(idleMs);
  const after = rpfCounter();
  const controlState = control ? await tcpProbe(control, timeoutMs) : 'not-run';
  const result = {state, controlState, idleMs, probeBudgetMs:timeoutMs, idleRpf:delta(before,idle), probeRpf:delta(idle,probe), afterRpf:delta(probe,after)};
  summary = `${state};idle=${result.idleRpf};probe=${result.probeRpf};after=${result.afterRpf};control=${controlState}`;
  log('Gateway network diagnostic ' + JSON.stringify(result));
  return result;
}
