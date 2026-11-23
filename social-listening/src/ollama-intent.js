'use strict';

// Optional local-model intent analysis via Ollama (http://localhost:11434).
//
// The keyword classifier decides whether a post is surfaced at all; the
// local model only REFINES already-matched posts: it labels intent, flags
// human-use context the regexes missed, and can downgrade a match to
// 'discussion'/'news'. It can never upgrade a non-match, never bypass the
// do-not-engage flag, and never triggers any outbound action — the model's
// output is annotation for the human reviewer, nothing more.
//
// Runs entirely on the local machine (no cloud calls). Configure with:
//   OLLAMA_URL   (default http://localhost:11434)
//   OLLAMA_MODEL (default llama3.2)
// If Ollama is unreachable the monitor logs it once and continues in
// keyword-only mode.

const DEFAULT_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.2';
const TIMEOUT_MS = 20000;

const INTENTS = ['purchase_seeking', 'coach_seeking', 'discussion', 'news', 'promotion', 'other'];

function resolveOllamaConfig(env = process.env) {
  return {
    url: (env.OLLAMA_URL || DEFAULT_URL).replace(/\/$/, ''),
    model: env.OLLAMA_MODEL || DEFAULT_MODEL
  };
}

const SYSTEM_PROMPT =
  'You label social media posts. Respond with ONLY a JSON object: ' +
  `{"intent": one of ${JSON.stringify(INTENTS)}, ` +
  '"human_use": true if the author intends to consume/self-administer a research compound themselves, ' +
  '"confidence": 0.0-1.0}. ' +
  '"purchase_seeking" = author is trying to find/buy/source a product for lab or research use. ' +
  '"coach_seeking" = author wants to find or hire fitness training/coaching for themselves. ' +
  '"promotion" = author is selling or advertising. No prose, JSON only.';

async function checkOllama(config = resolveOllamaConfig()) {
  try {
    const response = await fetch(`${config.url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return false;
    const data = await response.json();
    return Array.isArray(data.models);
  } catch {
    return false;
  }
}

/**
 * Ask the local model to label one post. Returns
 * { intent, humanUse, confidence } or null on any failure.
 */
async function analyzeIntent(text, config = resolveOllamaConfig()) {
  try {
    const response = await fetch(`${config.url}/api/chat`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        stream: false,
        format: 'json',
        options: { temperature: 0 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Post:\n${text.slice(0, 2000)}` }
        ]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const content = data && data.message && data.message.content;
    if (typeof content !== 'string') return null;
    const parsed = JSON.parse(content);
    if (!INTENTS.includes(parsed.intent)) return null;
    return {
      intent: parsed.intent,
      humanUse: Boolean(parsed.human_use),
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0))
    };
  } catch {
    return null;
  }
}

/**
 * Merge a model assessment into a keyword match. Model output can only
 * make the result MORE conservative:
 *  - human_use=true forces doNotEngage on research-peptide matches
 *  - intent 'news'/'promotion'/'other' with confidence >= 0.6 marks the
 *    match low-priority (kept in the log, hidden from the default view)
 */
function applyModelAssessment(match, assessment) {
  if (!assessment) return match;
  const refined = { ...match, model: assessment };
  if (match.audience === 'research-peptides' && assessment.humanUse) {
    refined.doNotEngage = true;
    refined.suggestedOpener = null;
    refined.doNotEngageReason =
      'Local model flagged human-use intent. Research-use-only products ' +
      'must not be marketed to personal-use interest — do not engage.';
  }
  if (['news', 'promotion', 'other'].includes(assessment.intent) && assessment.confidence >= 0.6) {
    refined.lowPriority = true;
  }
  return refined;
}

module.exports = {
  DEFAULT_MODEL,
  INTENTS,
  resolveOllamaConfig,
  checkOllama,
  analyzeIntent,
  applyModelAssessment
};
