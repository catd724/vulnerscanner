import { repo } from '@/lib/core';
import { route, body } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async () => repo.groups.list());

export const POST = route(async (request) => repo.groups.create(await body(request)), {
  requiresUnlock: true,
});
