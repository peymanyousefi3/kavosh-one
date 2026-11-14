import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import type { TestDatabase } from './database.ts';
import { expectedSchemaRevision } from '../src/core/database.ts';
import {installDispositionInspectorInTransaction} from '../src/platform/disposition-installation.ts';

// First assert the historical migration's own effects. Only then use this
// helper before CURRENT workers;never fake schema_revision or weaken readiness.
export async function upgradeToCurrent(database:TestDatabase){
 const revision=(await database.query<{revision:number}>('SELECT public.schema_revision() revision')).rows[0].revision;assert.ok(Number.isInteger(revision)&&revision>0);
 const directory=new URL('../db/migrations/',import.meta.url);
 for(const name of (await readdir(directory)).filter(n=>/^\d+_[a-z_]+\.sql$/.test(n)&&Number.parseInt(n,10)>revision).sort())await database.exec(await readFile(new URL(name,directory),'utf8'));
 assert.equal((await database.query<{revision:number}>('SELECT public.schema_revision() revision')).rows[0].revision,expectedSchemaRevision);
 await database.exec('BEGIN');try{await installDispositionInspectorInTransaction(database);await database.exec('COMMIT');}catch(error){await database.exec('ROLLBACK');throw error;}
}
