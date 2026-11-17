import { db } from '@/lib/core';
import { route, body } from '@/lib/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * terminal.ai - natural-language to shell command and error diagnosis.
 */

const OPENCODE_ENDPOINT = (process.env.OPENCODE_GO_API_URL || 'https://api.opencode.go/v1/chat/completions').replace(/\/$/, '');
const OPENCODE_MODEL = process.env.OPENCODE_GO_MODEL || 'kimi-k2.5-code';
const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = process.env.AI_MODEL || 'anthropic/claude-sonnet-4.5';

const SYSTEM_PROMPT_COMMAND = [
  'You are a shell command assistant embedded in an SSH client.',
  'Reply with ONLY the exact shell command that satisfies the request.',
  'No markdown fences, no explanation, no surrounding prose.',
  'Chain multiple steps with && when one command cannot do it.',
  'Prefer POSIX-portable syntax unless the context shows a specific shell.',
].join(' ');

const SYSTEM_PROMPT_DIAGNOSE = [
  'You are a shell error diagnostic assistant embedded in an SSH client.',
  'Analyze the recent terminal output in context to identify the failed command and error message.',
  'Reply strictly with a JSON object in this format:',
  '{',
  '  "explanation": "Concise 1-2 sentence explanation of the root cause.",',
  '  "fixCommand": "The exact shell command to fix or resolve the issue."',
  '}',
  'Do not include markdown code fences or any text outside the JSON object.',
].join(' ');

const SYSTEM_PROMPT_VULN_ANALYZE = [
  'You are a Linux security analyst.',
  'A vulnerability scanner has produced a JSON report about a Linux server.',
  'Summarize the most important risks in plain language, prioritize critical and high severity issues,',
  'and suggest safe remediation steps. Be concise but actionable.',
  'Format your answer as readable markdown with sections: Summary, Prioritized Risks, Recommended Fixes, and Safety Notes.',
].join(' ');

function stripFences(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

export const POST = route(async (request) => {
  // Check if AI features are enabled by user in settings
  const aiEnabledVal = await db.getSetting('ai_enabled', 'false');
  if (aiEnabledVal !== 'true') {
    return Response.json(
      { error: 'AI features are turned off in settings. Enable AI in the sidebar to use this.' },
      { status: 403 }
    );
  }

  const { query, context, mode = 'command' } = await body(request);

  if (mode === 'command' && (!query || !query.trim())) {
    throw new Error('A query is required');
  }

  const opencodeKey = process.env.OPENCODE_GO_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;

  const provider = opencodeKey ? 'opencode' : openrouterKey ? 'openrouter' : null;
  if (!provider) {
    return Response.json(
      { error: 'No AI provider configured. Set OPENCODE_GO_API_KEY or OPENROUTER_API_KEY in .env.local and restart.' },
      { status: 503 }
    );
  }

  const apiKey = provider === 'opencode' ? opencodeKey : openrouterKey;
  const endpoint = provider === 'opencode' ? OPENCODE_ENDPOINT : OPENROUTER_ENDPOINT;
  const model = provider === 'opencode' ? OPENCODE_MODEL : OPENROUTER_MODEL;

  let systemPrompt;
  if (mode === 'diagnose') systemPrompt = SYSTEM_PROMPT_DIAGNOSE;
  else if (mode === 'vuln-analyze') systemPrompt = SYSTEM_PROMPT_VULN_ANALYZE;
  else systemPrompt = SYSTEM_PROMPT_COMMAND;

  if (context && context.trim()) {
    if (mode === 'vuln-analyze') {
      systemPrompt +=
        '\n\nVulnerability scan report (JSON):\n' +
        '--- BEGIN SCAN REPORT ---\n' +
        context.slice(-6000) +
        '\n--- END SCAN REPORT ---\n';
    } else {
      systemPrompt +=
        '\n\nRecent terminal output for context (previous commands, paths, errors):\n' +
        '--- BEGIN CONTEXT ---\n' +
        context.slice(-4000) +
        '\n--- END CONTEXT ---\n';
    }
  }

  const userMessage =
    mode === 'diagnose'
      ? query && query.trim()
        ? `Diagnose this issue: ${query}`
        : 'Diagnose the last failed command in the terminal output and provide the fix.'
      : mode === 'vuln-analyze'
        ? 'Analyze the attached vulnerability scan report and provide remediation guidance.'
        : query;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (provider === 'openrouter') {
    headers['X-Title'] = 'AI Terminal';
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.2,
      max_tokens: mode === 'vuln-analyze' ? 1200 : 450,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error(`[ai] ${provider} request failed:`, response.status, detail.slice(0, 500));
    return Response.json(
      { error: `Model request failed (${response.status})` },
      { status: response.status }
    );
  }

  const data = await response.json();
  const rawText = stripFences(data.choices?.[0]?.message?.content || '');

  if (!rawText) throw new Error('The model returned an empty response');

  if (mode === 'diagnose') {
    try {
      const parsed = JSON.parse(rawText);
      return {
        mode: 'diagnose',
        explanation: parsed.explanation || 'Identified error in command execution.',
        fixCommand: stripFences(parsed.fixCommand || ''),
        model,
      };
    } catch {
      // Fallback if model output raw text
      return {
        mode: 'diagnose',
        explanation: rawText,
        fixCommand: '',
        model,
      };
    }
  }

  if (mode === 'vuln-analyze') {
    return { mode: 'vuln-analyze', analysis: rawText, model };
  }

  return { mode: 'command', command: rawText, model };
});
