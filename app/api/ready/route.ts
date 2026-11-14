import { getDatabase } from '../../../src/server/database.ts';
import { assertRuntimeRole,assertSchemaReady } from '../../../src/core/database.ts';
import { getIdentity } from '../../../src/server/identity.ts';
export const dynamic = 'force-dynamic';
export async function GET() {
  let db;
  try {
    db = await getDatabase().connect();
    await assertRuntimeRole(db);
    await assertSchemaReady(db);
    await getIdentity().store.safe();
    return Response.json({ ready: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ready: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  } finally { db?.release(); }
}
