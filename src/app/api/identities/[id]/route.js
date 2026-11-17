import { repo } from '@/lib/core';
import { route, body, idParam } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async (request, context) => {
  const identity = await repo.identities.find(await idParam(context));
  if (!identity) throw new Error('Identity not found');
  return identity;
});

// Sealing the merged secret needs the master key, so this is unlock-gated.
export const PUT = route(
  async (request, context) => repo.identities.update(await idParam(context), await body(request)),
  { requiresUnlock: true }
);

export const DELETE = route(
  async (request, context) => repo.identities.remove(await idParam(context)),
  { requiresUnlock: true }
);
