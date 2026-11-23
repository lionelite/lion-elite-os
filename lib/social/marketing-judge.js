'use strict';

// Marketing quality gate: judge a generated post the way a marketing/
// advertising/conversion-minded human would, score it 0–10, and only let
// content at or above the threshold reach publishing. Below-threshold
// content is regenerated and re-judged up to a cap; if it still can't
// clear the bar it is NOT posted — it's flagged for review. Posting
// nothing beats posting weak content.
//
// Two judges:
//  - AI judge (primary): an LLM scores the copy against a marketing rubric
//    ("as per your knowledge"). Uses the same key resolution as
//    lib/social/ai-provider.js.
//  - Heuristic judge (fallback / zero-secrets / CI): deterministic signals
//    (hook, CTA, clarity, length, specificity, engagement). Always
//    available so the gate never silently no-ops.
//
// The gate never relaxes compliance: a regenerated caption must still pass
// lib/social/social-compliance.js before it can be judged or posted.

const { resolveConfig } = require('./ai-provider');

const DEFAULT_THRESHOLD = 9.5;
const DEFAULT_MAX_ATTEMPTS = 4;
const JUDGE_TIMEOUT_MS = 45000;

const RUBRIC = Object.freeze([
  ['hook', 'Does the first line stop the scroll?'],
  ['clarity', 'Is it instantly understandable?'],
  ['relevance', 'Does it speak to the target audience?'],
  ['cta', 'Is there a clear, compelling next step?'],
  ['conversion', 'How likely is it to drive the desired action?'],
  ['brand_voice', 'Premium, confident, on-brand?']
]);

function clamp10(n) {
  const x = Number(n);
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(10, x));
}

// ---- Heuristic judge (deterministic) ----------------------------------

const CTA_SIGNALS = /\b(dm|comment|explore|learn more|link in bio|apply|shop|read|discover|visit|reach out|ask about|start|book)\b|https?:\/\/|lionelite\w+\.com/i;
const HOOK_WEAK_STARTS = /^(hi|hello|hey|today|we are|we're|introducing|check out)\b/i;

function firstLine(text) {
  return String(text || '').split('\n')[0].trim();
}

/**
 * Deterministic 0–10 marketing score. Intentionally strict at the top end
 * so a 9.5 gate means something. Returns dimensions + one-line feedback.
 */
const STRONG_CTA = /\b(dm|comment|apply|explore|link in bio|reach out|book|start today)\b|https?:\/\/|lionelite\w+\.com/i;
const SOFT_CTA = /\b(learn more|read|discover|visit|shop|ask about|start)\b/i;
const POWER_WORDS = /\b(stop|most|why|the truth|nobody|before you|the one|here's why|the difference|what (?:nobody|no one))\b/i;
const PREMIUM_WORDS = /\b(standard|discipline|precision|research|documented|verified|elite|quality)\b/i;

function heuristicScore(text) {
  const body = String(text || '').trim();
  const head = firstLine(body);
  const dims = {};

  // hook — reachable 10 for a concise, power-word opener
  let hook = 6;
  if (head.length > 0 && head.length <= 80) hook += 2;
  if (/[?]$/.test(head) || /^["“]/.test(head)) hook += 1;
  if (POWER_WORDS.test(head)) hook += 2;
  if (HOOK_WEAK_STARTS.test(head)) hook -= 3;
  dims.hook = clamp10(hook);

  // clarity — reward short sentences, penalize walls of text
  const sentences = body.split(/(?<=[.!?])\s+/).filter(Boolean);
  const avgLen = sentences.length ? body.length / sentences.length : body.length;
  let clarity = 7;
  if (avgLen <= 90) clarity += 2;
  if (avgLen <= 60) clarity += 1;
  clarity -= Math.max(0, (avgLen - 130) / 40) + (body.length > 1000 ? 3 : 0);
  dims.clarity = clamp10(clarity);

  // relevance — concrete nouns/numbers read as specific, not generic
  const specificity = (body.match(/\b\d+\b/g) || []).length +
    (body.match(/\b(research|coa|batch|coaching|accountability|purity|protocol|biomarker)\b/gi) || []).length;
  dims.relevance = clamp10(6 + Math.min(4, specificity));

  // cta — strong call-to-action reaches the top
  dims.cta = clamp10(STRONG_CTA.test(body) ? 10 : SOFT_CTA.test(body) ? 7 : 3);

  // conversion — strong CTA + strong hook + right length + specificity
  const lengthOk = body.length >= 80 && body.length <= 500;
  dims.conversion = clamp10(
    (dims.cta >= 10 ? 4 : dims.cta >= 7 ? 2 : 1) +
    (dims.hook >= 8 ? 3 : dims.hook >= 6 ? 1 : 0) +
    (lengthOk ? 2 : 0) +
    (specificity >= 2 ? 1 : 0)
  );

  // brand_voice — premium tone, not hypey
  const hypey = /\b(insane|crazy|miracle|guaranteed|blow your mind)\b/i.test(body);
  dims.brand_voice = clamp10(9 + (PREMIUM_WORDS.test(body) ? 1 : 0) - (hypey ? 4 : 0));

  const score = Number(
    (RUBRIC.reduce((sum, [key]) => sum + dims[key], 0) / RUBRIC.length).toFixed(2)
  );

  const weakest = RUBRIC.map(([k]) => [k, dims[k]]).sort((a, b) => a[1] - b[1])[0];
  return {
    score,
    dimensions: dims,
    feedback: `Weakest dimension: ${weakest[0]} (${weakest[1]}/10). Sharpen the ${weakest[0]}.`,
    judge: 'heuristic'
  };
}

// ---- AI judge ----------------------------------------------------------

function buildJudgePrompt(brand, platform) {
  return (
    `You are a demanding direct-response marketing director judging ONE ${platform} ` +
    `post for ${brand}. Score each dimension 0-10 against this rubric: ` +
    RUBRIC.map(([k, q]) => `${k} (${q})`).join('; ') +
    '. Be strict — 10 is reserved for genuinely exceptional, conversion-driving copy. ' +
    'Return ONLY JSON: {"dimensions":{"hook":n,...},"overall":n,"feedback":"one actionable sentence"}. ' +
    'overall is your holistic 0-10 marketing score, not necessarily the average.'
  );
}

async function aiJudge({ text, brand, platform, config }) {
  if (!config || !config.enabled) return null;
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildJudgePrompt(brand, platform) },
          { role: 'user', content: text }
        ]
      })
    });
    if (!response.ok) return null;
    const data = await response.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    const parsed = JSON.parse(content);
    return {
      score: clamp10(parsed.overall),
      dimensions: parsed.dimensions || {},
      feedback: String(parsed.feedback || '').slice(0, 300),
      judge: 'ai'
    };
  } catch {
    return null;
  }
}

/**
 * Judge one caption. Uses the AI judge when configured, else the heuristic.
 * Always resolves to a score object (never throws / never null).
 */
async function judgeCaption({ text, brand = 'the brand', platform = 'social', config = resolveConfig() }) {
  const ai = await aiJudge({ text, brand, platform, config });
  return ai || heuristicScore(text);
}

/**
 * Generate → judge → (regenerate → judge)* loop. `regenerate(feedback,
 * attempt)` returns improved text or null to stop. Never posts below
 * threshold: returns approved=false with the best attempt so the caller
 * can skip + flag.
 */
async function qualifyCaption({
  text, brand, platform,
  regenerate = null,
  threshold = DEFAULT_THRESHOLD,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  config = resolveConfig(),
  judge = judgeCaption
}) {
  const history = [];
  let current = text;
  let best = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await judge({ text: current, brand, platform, config });
    history.push({ attempt, score: result.score, judge: result.judge });
    if (!best || result.score > best.score) best = { text: current, ...result };

    if (result.score >= threshold) {
      return { approved: true, score: result.score, text: current, attempts: attempt, dimensions: result.dimensions, history };
    }
    if (attempt >= maxAttempts || typeof regenerate !== 'function') break;

    const next = await regenerate(result.feedback, attempt);
    if (!next || next === current) break;
    current = next;
  }

  return {
    approved: false,
    score: best.score,
    text: best.text,
    attempts: history.length,
    dimensions: best.dimensions,
    reason: `Best marketing score ${best.score} < threshold ${threshold} after ${history.length} attempt(s).`,
    history
  };
}

module.exports = {
  DEFAULT_THRESHOLD,
  DEFAULT_MAX_ATTEMPTS,
  RUBRIC,
  heuristicScore,
  judgeCaption,
  qualifyCaption
};
