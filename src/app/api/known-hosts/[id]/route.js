import { repo } from '@/lib/core';
import { route, idParam } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Forgetting a key forces a fresh trust prompt on the next connection, so a
// locked vault must not allow it: dropping the trust anchors is exactly what
// an attacker needs before stepping into the next connection.
export const DELETE = route(
  async (request, context) => repo.knownHosts.forget(await idParam(context)),
  { requiresUnlock: true }
);
