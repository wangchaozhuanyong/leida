import {spawnSync} from 'node:child_process';
for(const script of ['scripts/migrate.ts','scripts/auth-migrate.ts','scripts/migrations/forecast.ts','scripts/seed.ts']){const r=spawnSync('pnpm',['exec','tsx',script,...(script.endsWith('/forecast.ts')?['--apply']:[])],{stdio:'inherit',cwd:process.cwd()});if(r.status!==0)process.exit(r.status||1)}
console.log('本地数据库与历史导入已就绪。启动网站后，请在 /admin/setup 自行设置站长账号。');
