import { repo, vault, legacy, db } from '@/lib/core';
import { route } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * One round trip for everything the workspace needs at startup.
 * Saves the sidebar, keychain, snippet drawer and tunnel panel each firing
 * their own request before the first paint.
 */
export const GET = route(async () => {
  const status = await vault.status();
  const settings = {
    aiEnabled: (await db.getSetting('ai_enabled', 'false')) === 'true',
    uiTheme: await db.getSetting('ui_theme', 'dark'),
  };

  if (!status.unlocked) {
    // Nothing below is secret, but an empty workspace behind the unlock gate
    // avoids flashing stale data when the vault re-locks.
    return {
      vault: { ...status, legacyPending: await legacy.pending() },
      settings,
      hosts: [],
      groups: [],
      identities: [],
      snippets: [],
      forwards: [],
      knownHosts: [],
    };
  }

  const [hosts, groups, identities, snippets, forwards, knownHosts] = await Promise.all([
    repo.hosts.list(),
    repo.groups.list(),
    repo.identities.list(),
    repo.snippets.list(),
    repo.forwards.list(),
    repo.knownHosts.list(),
  ]);

  return {
    vault: { ...status, legacyPending: await legacy.pending() },
    settings,
    hosts,
    groups,
    identities,
    snippets,
    forwards,
    knownHosts,
  };
});
