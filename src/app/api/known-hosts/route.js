import { repo } from '@/lib/core';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async () => repo.knownHosts.list());
