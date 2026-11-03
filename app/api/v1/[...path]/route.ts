import { createApi } from '../../../../src/core/api.ts';
import { getDatabase } from '../../../../src/server/database.ts';
import { resolveHuman } from '../../../../src/server/identity.ts';
import { administration } from '../../../../src/modules/administration.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  // Database initialization happens only for requests; builds need no secrets.
  return createApi({ connect: () => getDatabase().connect() },resolveHuman,administration)(request, path.join('/'));
}
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
