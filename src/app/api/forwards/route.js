import { repo } from '@/lib/core';
import { route, body } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async (request) => {
  const hostId = request.nextUrl.searchParams.get('hostId');
  return repo.forwards.list(hostId ? Number(hostId) : null);
});

export const POST = route(async (request) => repo.forwards.create(await body(request)), {
  requiresUnlock: true,
});
