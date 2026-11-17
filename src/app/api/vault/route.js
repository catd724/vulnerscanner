import { vault, legacy } from '@/lib/core';
import { route, body } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Vault lifecycle. The master password is accepted here, converted to a key,
 * and discarded - it is never stored, logged, or echoed back.
 */

export const GET = route(async () => {
  const status = await vault.status();
  return { ...status, legacyPending: await legacy.pending() };
});

export const POST = route(async (request) => {
  const { action, masterPassword, newPassword, minutes, code, account } = await body(request);

  switch (action) {
    case 'init': {
      await vault.initialise(masterPassword);
      // First unlock is the earliest point the old plaintext rows can be sealed.
      const imported = await legacy.importLegacy();
      return { ...(await vault.status()), imported };
    }

    case 'unlock': {
      await vault.unlock(masterPassword, code);
      const imported = await legacy.importLegacy();
      return { ...(await vault.status()), imported };
    }

    case 'lock':
      vault.lock();
      return vault.status();

    case 'change':
      await vault.changeMasterPassword(masterPassword, newPassword);
      return vault.status();

    case 'autolock':
      vault.setAutoLockMinutes(minutes);
      return vault.status();

    // --- second factor ---------------------------------------------------
    // The setup key is returned exactly once, to the page that is about to
    // display it; it is not stored until a working code confirms enrolment.
    case 'totp-begin':
      return vault.beginTotpEnrolment(account);

    case 'totp-enable':
      return vault.enableTotp(code);

    case 'totp-disable':
      return vault.disableTotp(masterPassword, code);

    default:
      throw new Error(`Unknown vault action "${action}"`);
  }
});
