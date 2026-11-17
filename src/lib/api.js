import 'server-only';

import { vault } from './core';

/**
 * terminal.ai - route handler helpers.
 *
 * Wraps a handler so every route reports failures the same way, and so routes
 * touching sealed data fail closed with 423 instead of leaking a stack trace.
 */

export function route(fn, { requiresUnlock = false } = {}) {
  return async function handler(request, context) {
    try {
      if (requiresUnlock && !vault.isUnlocked) {
        return Response.json({ error: 'Vault is locked', code: 'VAULT_LOCKED' }, { status: 423 });
      }
      const result = await fn(request, context);
      if (result instanceof Response) return result;
      return Response.json(result ?? { ok: true });
    } catch (err) {
      const locked = err?.code === 'VAULT_LOCKED';
      // Validation and credential failures are the caller's problem, not a
      // server fault, so they answer 400 and stay out of the error log.
      // An explicit err.status wins: sniffing the message is a fallback for
      // plain `throw new Error(...)`, and it misclassified anything phrased
      // outside the list - a rejected 2FA code was answering 500.
      const badInput =
        /required|must be|not found|cannot|already|unknown|invalid|incorrect|denied|unsupported|no username|is empty|does not match/i.test(
          err?.message || ''
        );
      const status = locked
        ? 423
        : Number.isInteger(err?.status)
          ? err.status
          : badInput
            ? 400
            : 500;
      if (status === 500) console.error('[api]', err);
      return Response.json(
        { error: err?.message || 'Unexpected error', code: err?.code || null },
        { status }
      );
    }
  };
}

/** Read a JSON body, tolerating an empty one. */
export async function body(request) {
  try {
    return (await request.json()) || {};
  } catch {
    return {};
  }
}

/** Route params are promises in Next 16. */
export async function idParam(context) {
  const params = await context.params;
  const id = Number(params.id);
  if (!Number.isInteger(id)) throw new Error('Invalid id');
  return id;
}
