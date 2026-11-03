export const dynamic = 'force-dynamic';
export async function GET() {
  return Response.json({ service: 'kavosh-one', status: 'up', stage: 'backend-foundation' }, { headers: { 'Cache-Control': 'no-store' } });
}
