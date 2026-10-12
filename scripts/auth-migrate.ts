import 'dotenv/config';
import {getMigrations} from 'better-auth/db/migration';
import {betterAuth} from 'better-auth';
import pg from 'pg';
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
const auth=betterAuth({database:pool,secret:process.env.BETTER_AUTH_SECRET,baseURL:process.env.BETTER_AUTH_URL,emailAndPassword:{enabled:true,disableSignUp:true}});
try{const {runMigrations}=await getMigrations(auth.options);await runMigrations();console.log('站长登录表已就绪');}finally{await pool.end()}
