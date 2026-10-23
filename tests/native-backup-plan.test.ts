import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=fileURLToPath(new URL('..',import.meta.url));
test('原生服务器备份用已有容器并独立于应用进程受systemd监督，不含密钥、不覆盖旧备份',()=>{
 const script=fileURLToPath(new URL('../scripts/install-native-backup.sh',import.meta.url));
 const result=spawnSync('bash',[script,'--plan',root,'reset-radar-database-1'],{encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);const units=result.stdout;
 assert.equal(units.split('\n').find(line=>line.startsWith('WorkingDirectory=')),`WorkingDirectory=${root.replace(/\/$/,'')}`,'WorkingDirectory is a literal systemd path and must not contain shell quoting');
 assert.match(units,/backup-database\.sh.*--container reset-radar-database-1/);
 assert.match(units,/UMask=0077/);assert.match(units,/TimeoutStartSec=1800/);
 assert.match(units,/Restart=on-failure/);assert.match(units,/RestartSec=30min/);
 assert.match(units,/Persistent=true/);assert.match(units,/Asia\/Shanghai/);
 assert.doesNotMatch(units,/DATABASE_URL|PASSWORD|pg_restore.*--clean|rm -rf/);
 assert.notEqual(spawnSync('bash',[script,'--plan',root,'database; arbitrary-command']).status,0);
 assert.notEqual(spawnSync('bash',[script,'--plan',root+'%x','database']).status,0);
});
