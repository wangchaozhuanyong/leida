import {readFileSync, writeFileSync} from 'node:fs';

const interfaceNames = ['eth0', 'eth1'];
const nodeUid = 1000;
const nodeGid = 1000;

/** CloudRun's two interfaces need loose reverse-path validation for asymmetric VPC replies. */
export function initializeGatewayNetwork({read = readFileSync, write = writeFileSync, identity = process} = {}) {
  const root = identity.getuid() === 0;
  for (const name of interfaceNames) {
    const path = `/proc/sys/net/ipv4/conf/${name}/rp_filter`;
    if (root && read(path, 'utf8').trim() !== '2') write(path, '2\n');
    if (read(path, 'utf8').trim() !== '2') throw new Error('Gateway network validation unavailable');
  }
  if (root) {
    identity.setgroups([]);
    identity.setgid(nodeGid);
    identity.setuid(nodeUid);
  }
  if (identity.getuid() !== nodeUid || identity.getgid() !== nodeGid || identity.getgroups().some(group => group !== nodeGid)) {
    throw new Error('Gateway privilege drop failed');
  }
}
