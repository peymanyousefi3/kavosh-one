import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { after } from 'node:test';
import { expectedSchemaRevision,type Database } from '../src/core/database.ts';
import { Kysely,PostgresDialect,PGliteDialect,CompiledQuery } from 'kysely';

export interface TestDatabase {
  identityDb(role?:'kavosh_identity'|'kavosh_delivery'): Kysely<unknown>;
  runtime?: Database;
  query<Row=Record<string,unknown>>(sql: string, params?: unknown[]): Promise<{ rows: Row[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}
export async function testDatabase(template?:string): Promise<TestDatabase> {
  const connectionString = process.env.TEST_DATABASE_URL;
  if(template!==undefined&&!/^kavosh_schema_[a-f0-9]{32}$/.test(template))throw new Error('Invalid owned test schema template');
  if (!connectionString) {
    if(template)throw new Error('Schema templates require native PostgreSQL');
    const engine=new PGlite({extensions:{btree_gist,pg_trgm}});
    return Object.assign(engine,{identityDb:()=>new Kysely<unknown>({dialect:new PGliteDialect({pglite:engine})}).withSchema('identity')});
  }
  const url = new URL(connectionString);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Integration tests require an isolated loopback PostgreSQL instance');
  const admin = new pg.Client({ connectionString });let created=false,clientForCleanup:pg.Client|undefined;
  // This exact, generated disposable database is the only teardown target.
  const name = `kavosh_test_${randomUUID().replaceAll('-','')}`;
  try{await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"${template?` TEMPLATE "${template}"`:''}`);
  created=true;
  url.pathname=`/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  clientForCleanup=client;
  await client.connect();
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  return {
    identityDb:(role='kavosh_identity')=>new Kysely<unknown>({dialect:new PostgresDialect({
      pool:new pg.Pool({connectionString:url.toString(),max:4}),
      async onCreateConnection(connection){await connection.executeQuery(CompiledQuery.raw(`SET ROLE ${role}`));}
    })}).withSchema('identity'),
    runtime: {
      async connect() {
        const connection=await pool.connect();
        try { await connection.query('SET ROLE kavosh_runtime'); }
        catch(error) { connection.release(true); throw error; }
        return connection;
      }
    },
    async query<Row>(sql: string, params?: unknown[]) { const result=await client.query(sql,params); return { rows: result.rows as Row[],affectedRows:result.rowCount??undefined }; },
    async exec(sql:string) { return client.query(sql); },
    async close() {
      await pool.end();
      await client.end();
      await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  };
  }catch(error){try{await clientForCleanup?.end();}finally{try{if(created)await admin.query(`DROP DATABASE "${name}"`);}finally{await admin.end();}}throw error;}
}

// Test-only native optimization. Every fixture still has a distinct real
// database,pool and teardown. Only an empty,actually migrated schema is cloned;
// no actor,session,approval,financial or business rows are shared. Historical
// schema/migration tests continue through the original empty-database path.
const schemaTemplates=new Map<string,Promise<string>>();
async function installTestSchema(db:{exec(sql:string):Promise<unknown>}){
 const directory=new URL('../db/migrations/',import.meta.url);
 for(const name of(await readdir(directory)).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
}
async function makeSchemaTemplate(connectionString:string){
 const url=new URL(connectionString);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Test schema templates require isolated loopback PostgreSQL');
 const name='kavosh_schema_'+randomUUID().replaceAll('-',''),owner=new pg.Client({connectionString});let created=false;
 try{await owner.connect();await owner.query(`CREATE DATABASE "${name}"`);created=true;url.pathname='/'+name;const seed=new pg.Client({connectionString:url.toString()});
  try{await seed.connect();await installTestSchema({exec:sql=>seed.query(sql)});if((await seed.query<{revision:number}>('SELECT public.schema_revision() revision')).rows[0]?.revision!==expectedSchemaRevision)throw new Error('Fixture schema is not current');}finally{await seed.end();}
  // Seal the seed after its owner connection closes. Test clients and
  // background maintenance must not modify the source between fixture copies.
  await owner.query(`ALTER DATABASE "${name}" ALLOW_CONNECTIONS false`);return name;
 }catch(error){if(created)await owner.query(`DROP DATABASE "${name}"`);throw error;}finally{await owner.end();}
}
export async function migratedTestDatabase():Promise<TestDatabase>{
 const connectionString=process.env.TEST_DATABASE_URL;if(!connectionString){const db=await testDatabase();try{await installTestSchema(db);if((await db.query<{revision:number}>('SELECT public.schema_revision() revision')).rows[0]?.revision!==expectedSchemaRevision)throw new Error('Fixture schema is not current');return db;}catch(error){await db.close();throw error;}}
 let template=schemaTemplates.get(connectionString);if(!template){template=makeSchemaTemplate(connectionString);schemaTemplates.set(connectionString,template);}
 return testDatabase(await template);
}
after(async()=>{for(const[connectionString,pending]of schemaTemplates){let name:string;try{name=await pending;}catch{continue;}const owner=new pg.Client({connectionString});await owner.connect();try{await owner.query(`DROP DATABASE "${name}"`);}finally{await owner.end();}}});
