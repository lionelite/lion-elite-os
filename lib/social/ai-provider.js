'use strict';

// Optional AI caption enhancement for the daily social engine.
//
// Reads AI_API_KEY (Issue #48's name) with OPENAI_API_KEY as a fallback,
// matching the OpenAI-with-template-fallback pattern already used by
// server.js and manual-daily-agent.yml. Every AI result is re-validated by
// lib/social/social-compliance.js in the orchestrator; a failed call, a
// missing key, or a blocked rewrite all fall back to the deterministic
// template text, so this module can never make the pipeline less safe or
// less reliable — only more varied.

const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 60000;

function resolveConfig(env = process.env) {
  const apiKey = (env.AI_API_KEY || env.OPENAI_API_KEY || '').trim();
  return {
    apiKey,
    model: (env.AI_MODEL || env.OPENAI_MODEL || DEFAULT_MODEL).trim(),
    enabled: apiKey.length > 0
  };
}

function buildSystemPrompt(profile) {
  const shared =
    `You rewrite social media captions for ${profile.name}. ` +
    `Voice: ${profile.voice.join(', ')}. Keep the caption structure, CTA, and ` +
    'any disclaimer lines EXACTLY as provided — you may only rewrite the ' +
    'educational body copy to be more engaging. Never add claims, promises, ' +
    'guarantees, or medical language. Return only the rewritten caption text.';
  if (profile.complianceMode === 'research-only') {
    return (
      shared +
      ' HARD RULES: research/education language only. No dosing, no amounts ' +
      'in mg/mcg/IU, no human-use instructions, no treatment or disease ' +
      'claims, no transformation promises, no benefits language. The line ' +
      `"${profile.disclaimer}" must appear verbatim in the output.`
    );
  }
  return (
    shared +
    ' HARD RULES: no medical claims, no guarantees, no specific-outcome ' +
    'promises (no "lose X lbs"), and never mention research compounds or ' +
    'peptides — that is the other brand.'
  );
}

/**
 * Ask the AI provider to rewrite one caption. Returns the rewritten text,
 * or null on any failure (no key, HTTP error, timeout, empty response).
 * The caller is responsible for compliance-validating the result.
 */
async function enhanceCaption({ profile, baseText, platform, config = resolveConfig() }) {
  if (!config.enabled) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.7,
        messages: [
          { role: 'system', content: buildSystemPrompt(profile) },
          {
            role: 'user',
            content:
              `Platform: ${platform}. Rewrite this caption following every rule:\n\n${baseText}`
          }
        ]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (typeof text !== 'string' || text.trim().length === 0) return null;
    return text.trim();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  DEFAULT_MODEL,
  resolveConfig,
  enhanceCaption
};
