import type { TestDatabase } from './database.ts';
import type { Database } from '../src/core/database.ts';
import { processOneReport } from '../src/reports/export-worker.ts';

// Shared native/embedded adapter only. The real worker still verifies its
// dedicated role,schema,requester,source policy,lease and atomic result save.
export function fixtureReportDatabase(f:{pg:TestDatabase}):Database{return {async connect(){const c=f.pg.runtime?await f.pg.runtime.connect():{query:f.pg.query.bind(f.pg),release(){}};await c.query('SET ROLE kavosh_automation_worker');return c;}};}
export async function runFixtureReportWorker(f:{pg:TestDatabase;a:string}){
 try{return await processOneReport(fixtureReportDatabase(f),[f.a]);}finally{if(!f.pg.runtime)await f.pg.exec('RESET ROLE');}
}
