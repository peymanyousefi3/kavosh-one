import 'server-only';
import { handleBusinessApi } from '../../../../src/server/business-api.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  // Database initialization happens only for requests; builds need no secrets.
  return handleBusinessApi(request,path.join('/'));
}
export { handle as GET,handle as HEAD, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
