import { repo } from '@/lib/core';
import { route, body, idParam } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async (request, context) => {
  const host = await repo.hosts.find(await idParam(context));
  if (!host) throw new Error('Host not found');
  return host;
});

export const PUT = route(
  async (request, context) => repo.hosts.update(await idParam(context), await body(request)),
  { requiresUnlock: true }
);

export const DELETE = route(
  async (request, context) => repo.hosts.remove(await idParam(context)),
  { requiresUnlock: true }
);
