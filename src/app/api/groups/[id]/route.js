import { repo } from '@/lib/core';
import { route, body, idParam } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const PUT = route(
  async (request, context) => repo.groups.update(await idParam(context), await body(request)),
  { requiresUnlock: true }
);

export const DELETE = route(
  async (request, context) => repo.groups.remove(await idParam(context)),
  { requiresUnlock: true }
);
