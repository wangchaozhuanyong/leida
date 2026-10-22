import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeGatewayNetwork} from '../scripts/cloudrun-network-init.mjs';

function fixture({uid = 0, gid = 0, values = ['1', '1'], groups = [0]} = {}) {
  const paths = ['/proc/sys/net/ipv4/conf/eth0/rp_filter', '/proc/sys/net/ipv4/conf/eth1/rp_filter'];
  const files = new Map(paths.map((path, index) => [path, values[index]]));
  const actions = [];
  const identity = {
    getuid: () => uid, getgid: () => gid, getgroups: () => groups,
    setgroups(value) {actions.push('groups'); groups = value;},
    setgid(value) {actions.push('gid'); gid = value;},
    setuid(value) {actions.push('uid'); uid = value;}
  };
  const read = path => {assert.ok(files.has(path)); return files.get(path);};
  const write = (path, value) => {assert.ok(files.has(path)); actions.push(path); files.set(path, value);};
  return {paths, files, actions, identity, read, write};
}

test('configures only the two gateway interfaces then removes root and supplementary groups', () => {
  const f = fixture(); initializeGatewayNetwork(f);
  assert.deepEqual(f.actions, [...f.paths, 'groups', 'gid', 'uid']);
  assert.deepEqual([...f.files.values()], ['2\n', '2\n']);
  assert.equal(f.identity.getuid(), 1000); assert.equal(f.identity.getgid(), 1000); assert.deepEqual(f.identity.getgroups(), []);
});

test('does not write global sysctls or rewrite already configured interfaces', () => {
  const f = fixture({values:['2', '2']}); initializeGatewayNetwork(f);
  assert.deepEqual(f.actions, ['groups', 'gid', 'uid']);
});

test('unprivileged startup succeeds only with both interfaces already configured', () => {
  const f = fixture({uid:1000, gid:1000, groups:[1000], values:['2', '2']}); initializeGatewayNetwork(f);
  assert.deepEqual(f.actions, []);
  const strict = fixture({uid:1000, gid:1000, groups:[1000]});
  assert.throws(() => initializeGatewayNetwork(strict), /network validation unavailable/); assert.deepEqual(strict.actions, []);
});

test('read-only sysctl failure stops startup before privilege drop and HTTP binding', () => {
  const f = fixture(); f.write = () => {throw Object.assign(new Error('read-only namespace'), {code:'EROFS'});};
  assert.throws(() => initializeGatewayNetwork(f), {code:'EROFS'}); assert.deepEqual(f.actions, []);
});

test('ignoring a sysctl write is detected by readback before privilege drop', () => {
  const f = fixture(); f.write = () => {};
  assert.throws(() => initializeGatewayNetwork(f), /network validation unavailable/); assert.deepEqual(f.actions, []);
});

test('failed or ineffective UID drop never permits startup to continue', () => {
  const failed = fixture({values:['2', '2']}); failed.identity.setuid = () => {throw new Error('uid denied');};
  assert.throws(() => initializeGatewayNetwork(failed), /uid denied/);
  const ineffective = fixture({values:['2', '2']}); ineffective.identity.setuid = () => {};
  assert.throws(() => initializeGatewayNetwork(ineffective), /privilege drop failed/);
});

test('unexpected identity or supplementary group cannot serve requests', () => {
  for (const state of [{uid:1001,gid:1000,groups:[1000]},{uid:1000,gid:0,groups:[1000]},{uid:1000,gid:1000,groups:[0]}]) {
    assert.throws(() => initializeGatewayNetwork(fixture({...state, values:['2', '2']})), /privilege drop failed/);
  }
});
