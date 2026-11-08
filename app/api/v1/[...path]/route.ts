import 'server-only';
import { createApi } from '../../../../src/core/api.ts';
import { getDatabase } from '../../../../src/server/database.ts';
import { resolveHuman } from '../../../../src/server/identity.ts';
import { business } from '../../../../src/modules/business.ts';
import { configuredR2Upload,configuredR2Download } from '../../../../src/integrations/r2-config.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handle(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  // Database initialization happens only for requests; builds need no secrets.
  return createApi({ connect: () => getDatabase().connect() },resolveHuman,ctx=>business(ctx,configuredR2Upload,configuredR2Download,{invitationSecret:process.env.AUTH_SECRET}))(request, path.join('/'));
}
export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };
