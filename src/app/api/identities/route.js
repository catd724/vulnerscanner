import { repo } from '@/lib/core';
import { route, body } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Listing returns the public projection only - secretBlob never leaves repo.js.
export const GET = route(async () => repo.identities.list());

export const POST = route(async (request) => repo.identities.create(await body(request)), {
  requiresUnlock: true,
});
