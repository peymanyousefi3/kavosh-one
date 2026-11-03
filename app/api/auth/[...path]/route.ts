import { getIdentity } from '../../../../src/server/identity.ts';
export const runtime='nodejs';
export const dynamic='force-dynamic';
async function handle(request:Request) {
  try {return await getIdentity().handle(request);}
  catch {return Response.json({error:{code:'AUTH_UNAVAILABLE'}},{status:503,headers:{'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});}
}
export { handle as GET,handle as POST };
