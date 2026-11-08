import pg from 'pg';
import { z } from 'zod';
import { postgresOptions } from '../src/core/postgres-config.ts';
import { assertSchemaReady } from '../src/core/database.ts';

// Operator-only database operation. Never accepts a web session, creates an
// identity, changes MFA, sends a message or replaces an existing owner.
let client:pg.Client|undefined;
try{
 const user=z.string().uuid().parse(process.env.PLATFORM_OWNER_USER_ID),reason=z.string().trim().min(1).max(2000).parse(process.env.PLATFORM_OWNER_REASON);
 client=new pg.Client(postgresOptions(process.env.MIGRATION_DATABASE_URL));await client.connect();await assertSchemaReady({query:client.query.bind(client),release(){}});
 await client.query('SELECT platform_private.register_owner($1,$2)',[user,reason]);
 console.log('Verified platform owner registered. No identity, invitation or external delivery created.');
}catch{console.error('Platform owner registration failed; check operator credentials and verified MFA identity.');process.exitCode=1;}
finally{await client?.end();}
