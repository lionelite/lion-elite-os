'use strict';

// Deterministic lesson extraction for the video learning connection.
//
// Everything here is a pure function of the transcript, and every extracted
// line keeps the timestamp it came from so the lesson can be checked against
// the source instead of taken on faith. No AI call is required for any of it —
// AI enrichment is layered on top by the caller and can only add commentary,
// never replace these citations.
//
// The compliance gate matters as much as the extraction: a random creator
// will happily say "dose", "inject", or "fat loss", and that language must
// never flow from a lesson file into customer-facing Lion Elite Wellness copy.
// Lessons carrying it are marked internal-only rather than silently cleaned.

const { validateContent } = require('../social/social-compliance');
const { formatTimestamp, timestampedUrl } = require('./video-sources');

const STOPWORDS = new Set(
  (
    'a about above after again against all am an and any are as at be because been before being ' +
    'below between both but by can cannot could did do does doing down during each few for from ' +
    'further had has have having he her here hers herself him himself his how i if in into is it ' +
    'its itself just me more most my myself no nor not now of off on once only or other our ours ' +
    'ourselves out over own same she should so some such than that the their theirs them themselves ' +
    'then there these they this those through to too under until up very was we were what when ' +
    'where which while who whom why will with you your yours yourself yourselves ' +
    // Spoken-word filler that dominates raw caption text.
    'like really actually basically literally okay ok yeah yep gonna wanna kinda sorta stuff thing ' +
    'things got get gets getting go goes going going know knows let lets look looking make makes ' +
    'want wants say says said see seen think thought take takes right well much many lot lots ' +
    'guys guy folks video channel subscribe comment below link description ' +
    // Spelled-out counts carry no topical meaning on their own; the numbers
    // that matter are captured as metrics, with their units attached.
    'one two three four five six seven eight nine ten per'
  ).split(' ')
);

// Cue phrases that mark a line as instructional rather than narrative. These
// are what make a transcript learnable — they are where the creator states a
// method, rule, or mistake instead of telling a story.
//
// Order matters: the first match wins, so the specific cues ("step one", "the
// biggest mistake") are listed ahead of the generic ones ("you need to"),
// which would otherwise swallow almost every instructional line.
const ACTION_CUES = [
  { code: 'mistake', pattern: /\b(?:biggest\s+mistake|mistake\s+(?:is|that|people)|people\s+get\s+(?:this\s+)?wrong|stop\s+doing|the\s+problem\s+(?:is|with))\b/i },
  { code: 'step', pattern: /\bstep\s+(?:one|two|three|four|five|six|\d+)\b/i },
  { code: 'step', pattern: /\b(?:start|begin)\s+(?:by|with)\b/i },
  { code: 'step', pattern: /\b(?:first\s+thing|second(?:ly)?|third(?:ly)?|after\s+that|finally)\b/i },
  { code: 'rule', pattern: /\b(?:rule\s+of\s+thumb|the\s+rule\s+is|non[-\s]negotiable)\b/i },
  { code: 'rule', pattern: /\b(?:never|always)\s+\w+/i },
  { code: 'recommendation', pattern: /\bi\s+(?:recommend|suggest)\b/i },
  { code: 'recommendation', pattern: /\b(?:pro\s+tip|my\s+advice|best\s+practice|what\s+works)\b/i },
  { code: 'method', pattern: /\bhere(?:'s|\s+is)\s+(?:how|what|the|exactly|why)\b/i },
  { code: 'method', pattern: /\bthe\s+(?:key|trick|secret|whole\s+point|point)\s+(?:is|here|to)\b/i },
  { code: 'method', pattern: /\bwhat\s+(?:i|we)\s+(?:do|did|found|learned)\b/i },
  { code: 'method', pattern: /\bthe\s+way\s+(?:i|we|you)\s+\w+/i },
  { code: 'directive', pattern: /\b(?:you|we)\s+(?:need|have|want|ought)\s+to\b/i },
  { code: 'directive', pattern: /\byou\s+(?:should|must|gotta)\b/i },
  { code: 'directive', pattern: /\bmake\s+sure\b/i }
];

// Concrete numbers are the difference between "post more" and "post 3x a day".
const METRIC_PATTERN =
  /(?:\$\s?[\d,]+(?:\.\d+)?[km]?\b|\b[\d,]+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?x\b|\b[\d,]+(?:\.\d+)?\s*(?:dollars?|cents?|days?|weeks?|months?|years?|hours?|minutes?|seconds?|times?\s+(?:a|per)\s+\w+|leads?|clients?|customers?|sales?|orders?|subscribers?|followers?|views?|impressions?|clicks?|posts?|emails?|calls?|reels?|videos?|k\b|roas\b|cpm\b|cpc\b))/i;

// Platforms and tools this business actually touches; recognizing them makes a
// lesson routable to the right lane instead of a generic pile of notes.
const TOOL_CATALOG = [
  ['Meta Ads', /\bmeta\s+ads?\b|\bfacebook\s+ads?\b|\bads?\s+manager\b/i],
  ['Instagram', /\binstagram\b|\big\b(?!\w)|\breels?\b/i],
  ['TikTok', /\btiktok\b/i],
  ['YouTube', /\byoutube\b|\bshorts\b/i],
  ['Google Ads', /\bgoogle\s+ads?\b|\badwords\b/i],
  ['Shopify', /\bshopify\b/i],
  ['Klaviyo', /\bklaviyo\b/i],
  ['Mailchimp', /\bmailchimp\b/i],
  ['HubSpot', /\bhubspot\b/i],
  ['GoHighLevel', /\bgo\s?high\s?level\b|\bghl\b/i],
  ['Zapier', /\bzapier\b/i],
  ['Make', /\bmake\.com\b|\bintegromat\b/i],
  ['Notion', /\bnotion\b/i],
  ['Canva', /\bcanva\b/i],
  ['CapCut', /\bcapcut\b/i],
  ['Metricool', /\bmetricool\b/i],
  ['Stripe', /\bstripe\b/i],
  ['Calendly', /\bcalendly\b/i],
  ['ManyChat', /\bmanychat\b/i],
  ['LinkedIn', /\blinkedin\b/i],
  ['Pinterest', /\bpinterest\b/i],
  ['X', /\btwitter\b|\bx\.com\b/i],
  ['Reddit', /\breddit\b/i],
  ['Airtable', /\bairtable\b/i],
  ['Webflow', /\bwebflow\b/i],
  ['WordPress', /\bwordpress\b/i],
  ['Vercel', /\bvercel\b/i],
  ['Twilio', /\btwilio\b/i],
  ['Substack', /\bsubstack\b/i],
  ['Beehiiv', /\bbeehiiv\b/i]
];

const SENTENCE_END = /[.!?]$/;
const DEFAULT_MAX_UTTERANCE_WORDS = 32;
const DEFAULT_GAP_SECONDS = 2.5;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function contentWords(text) {
  return tokenize(text).filter(
    // Bare numerals rank as topics far above their worth ("12000" is not a
    // subject); they already appear in the metrics section with their units.
    (word) => word.length > 2 && !STOPWORDS.has(word) && !/^\d+$/.test(word)
  );
}

/**
 * Rebuild sentence-like utterances from caption segments.
 *
 * Auto-generated captions arrive as 2-5 word fragments with no punctuation,
 * so splitting on sentence boundaries alone produces either one giant blob or
 * nothing. Utterances close on punctuation, on a length cap, or on a pause in
 * the audio — whichever comes first — which works for both machine captions
 * and properly punctuated transcripts.
 */
function buildUtterances(segments, {
  maxWords = DEFAULT_MAX_UTTERANCE_WORDS,
  gapSeconds = DEFAULT_GAP_SECONDS
} = {}) {
  if (!Array.isArray(segments) || segments.length === 0) return [];

  const utterances = [];
  let words = [];
  let start = null;
  let previousEnd = null;

  const flush = () => {
    if (words.length === 0) return;
    const text = words.join(' ').replace(/\s+/g, ' ').trim();
    if (text) utterances.push({ text, start });
    words = [];
    start = null;
  };

  for (const segment of segments) {
    const segmentStart = Number.isFinite(segment.start) ? segment.start : null;
    if (
      words.length > 0 &&
      segmentStart !== null &&
      previousEnd !== null &&
      segmentStart - previousEnd > gapSeconds
    ) {
      flush();
    }

    for (const word of String(segment.text || '').split(/\s+/).filter(Boolean)) {
      if (words.length === 0) start = segmentStart;
      words.push(word);
      if (SENTENCE_END.test(word) && words.length >= 4) flush();
      else if (words.length >= maxWords) flush();
    }

    if (segmentStart !== null) {
      previousEnd = segmentStart + (Number.isFinite(segment.duration) ? segment.duration : 0);
    }
  }
  flush();
  return utterances;
}

/** Word-frequency table over content words, used for ranking and titling. */
function keywordCounts(utterances) {
  const counts = new Map();
  for (const utterance of utterances) {
    for (const word of contentWords(utterance.text)) {
      counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return counts;
}

function topKeywords(counts, limit = 12) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

/**
 * Extractive summary: score each utterance by the frequency of the content
 * words it contains, normalized for length so long rambles do not win by
 * default, then return the highest scorers in their original order.
 */
function selectSummary(utterances, counts, limit = 6) {
  const scored = utterances
    .map((utterance, index) => {
      const unique = new Set(contentWords(utterance.text));
      if (unique.size < 3) return null;
      let score = 0;
      for (const word of unique) score += counts.get(word) || 0;
      return { index, utterance, score: score / Math.sqrt(unique.size) };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index);

  return scored.map(({ utterance }) => ({ text: utterance.text, start: utterance.start }));
}

/** Utterances that state a method, rule, step, or mistake. */
function selectActions(utterances, limit = 15) {
  const actions = [];
  const seen = new Set();
  for (const utterance of utterances) {
    const cue = ACTION_CUES.find(({ pattern }) => pattern.test(utterance.text));
    if (!cue) continue;
    if (contentWords(utterance.text).length < 3) continue;
    const fingerprint = utterance.text.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    actions.push({ text: utterance.text, start: utterance.start, cue: cue.code });
    if (actions.length >= limit) break;
  }
  return actions;
}

/**
 * Utterances carrying concrete numbers. A single sentence often states several
 * ("3x return in 90 days"), so every match is kept rather than just the first.
 */
function selectMetrics(utterances, limit = 10) {
  const globalPattern = new RegExp(METRIC_PATTERN.source, 'gi');
  const metrics = [];
  const seen = new Set();
  for (const utterance of utterances) {
    const values = [...utterance.text.matchAll(globalPattern)].map((match) => match[0].trim());
    if (values.length === 0) continue;
    const fingerprint = utterance.text.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    metrics.push({ text: utterance.text, start: utterance.start, values });
    if (metrics.length >= limit) break;
  }
  return metrics;
}

function detectTools(text) {
  const found = [];
  for (const [name, pattern] of TOOL_CATALOG) {
    const matches = String(text || '').match(new RegExp(pattern.source, 'gi'));
    if (matches && matches.length > 0) found.push({ name, mentions: matches.length });
  }
  return found.sort((a, b) => b.mentions - a.mentions);
}

/**
 * Split the transcript into time-coded chapters so a human can jump straight
 * to the part of the video a claim came from.
 */
function buildChapters(utterances, { target = 6 } = {}) {
  const timed = utterances.filter((utterance) => Number.isFinite(utterance.start));
  if (timed.length < target * 2) return [];

  const perChapter = Math.ceil(timed.length / target);
  const chapters = [];
  for (let i = 0; i < timed.length; i += perChapter) {
    const slice = timed.slice(i, i + perChapter);
    if (slice.length === 0) continue;
    const counts = keywordCounts(slice);
    const title = topKeywords(counts, 4)
      .map(({ term }) => term)
      .join(', ');
    chapters.push({
      start: slice[0].start,
      end: slice[slice.length - 1].start,
      title: title || 'untitled section',
      lineCount: slice.length
    });
  }
  return chapters;
}

/**
 * Decide whether this material can ever be reused in customer-facing copy.
 *
 * The transcript is checked against both brand rule sets. The research
 * disclaimer is NOT required here — a third party's transcript is source
 * material, not published copy, so demanding a disclaimer would block every
 * video. What we do care about is whether the language itself would violate
 * RUO or brand separation if it were reused.
 */
function evaluateReuse(text) {
  const wellness = validateContent({
    text,
    complianceMode: 'research-only',
    requireDisclaimer: false
  });
  const beauty = validateContent({ text, complianceMode: 'coaching' });
  return {
    wellnessSafe: wellness.approved,
    wellnessBlockers: wellness.blockers,
    beautySafe: beauty.approved,
    beautyBlockers: beauty.blockers,
    // Internal-only means: learn the tactic, never paste the words.
    internalOnly: !wellness.approved || !beauty.approved
  };
}

function totalDuration(segments, metadata) {
  if (Number.isFinite(metadata?.durationSeconds) && metadata.durationSeconds > 0) {
    return metadata.durationSeconds;
  }
  if (!Array.isArray(segments) || segments.length === 0) return null;
  const last = segments[segments.length - 1];
  if (!Number.isFinite(last.start)) return null;
  return last.start + (Number.isFinite(last.duration) ? last.duration : 0);
}

/**
 * Build a structured lesson from a fetched transcript.
 *
 * @param {object} input
 * @param {object} input.source - parsed video source
 * @param {object} input.transcript - { text, segments, ... }
 * @param {object} [input.metadata] - title/author/duration if known
 * @param {string} [input.strategy] - how the transcript was obtained
 * @param {string} [input.task] - what the owner asked to be done with it
 * @param {string} [input.generatedAt] - ISO timestamp, injectable for tests
 * @returns {object} lesson
 */
function buildLesson({
  source,
  transcript,
  metadata = {},
  strategy = 'unknown',
  task = null,
  generatedAt = new Date().toISOString()
} = {}) {
  if (!source) throw new TypeError('buildLesson requires a parsed video source');
  if (!transcript || typeof transcript.text !== 'string' || !transcript.text.trim()) {
    throw new TypeError('buildLesson requires a transcript with text');
  }

  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  const utterances = buildUtterances(segments);
  const counts = keywordCounts(utterances);
  const wordCount = tokenize(transcript.text).length;

  return {
    source,
    metadata,
    task: task || null,
    generatedAt,
    transcript: {
      strategy,
      language: transcript.language || 'unknown',
      autoGenerated: Boolean(transcript.autoGenerated),
      wordCount,
      segmentCount: segments.length,
      durationSeconds: totalDuration(segments, metadata),
      // Short-form is the main diet here — a 30-second reel runs ~75 words, so
      // the bar sits below that and only catches transcripts too sparse to
      // support any conclusion. The flag travels with the lesson so downstream
      // readers know not to over-trust it.
      thin: wordCount < 60
    },
    topics: topKeywords(counts, 12),
    summary: selectSummary(utterances, counts),
    actions: selectActions(utterances),
    metrics: selectMetrics(utterances),
    tools: detectTools(transcript.text),
    chapters: buildChapters(utterances),
    reuse: evaluateReuse(transcript.text)
  };
}

/** Render a citation link for one extracted line. */
function citationFor(source, start) {
  const label = formatTimestamp(start);
  if (!label) return null;
  return { label, url: timestampedUrl(source, start) };
}

module.exports = {
  buildLesson,
  buildUtterances,
  keywordCounts,
  topKeywords,
  selectSummary,
  selectActions,
  selectMetrics,
  detectTools,
  buildChapters,
  evaluateReuse,
  citationFor,
  contentWords,
  ACTION_CUES,
  TOOL_CATALOG
};
