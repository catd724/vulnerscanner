import { db } from '@/lib/core';
import { route, body } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * User preferences and feature toggles.
 */
const DEFAULT_UI_THEME = 'dark';

export const GET = route(async () => {
  const aiEnabledVal = await db.getSetting('ai_enabled', 'false');
  return {
    aiEnabled: aiEnabledVal === 'true',
    uiTheme: await db.getSetting('ui_theme', DEFAULT_UI_THEME),
  };
});

export const POST = route(async (request) => {
  const data = await body(request);
  if (typeof data.aiEnabled === 'boolean') {
    await db.setSetting('ai_enabled', data.aiEnabled ? 'true' : 'false');
  }
  if (typeof data.uiTheme === 'string') {
    await db.setSetting('ui_theme', data.uiTheme);
  }
  return {
    aiEnabled: (await db.getSetting('ai_enabled', 'false')) === 'true',
    uiTheme: await db.getSetting('ui_theme', DEFAULT_UI_THEME),
  };
});
