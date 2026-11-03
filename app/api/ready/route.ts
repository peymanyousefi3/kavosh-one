import { getDatabase } from '../../../src/server/database.ts';
import { assertRuntimeRole } from '../../../src/core/database.ts';
export const dynamic = 'force-dynamic';
export async function GET() {
  let db;
  try {
    db = await getDatabase().connect();
    await assertRuntimeRole(db);
    await db.query('SELECT id FROM public.academies LIMIT 0');
    return Response.json({ ready: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ ready: false }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  } finally { db?.release(); }
}
