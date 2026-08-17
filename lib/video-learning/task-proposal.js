'use strict';

// Turn an extracted lesson into proposed Lion Elite work.
//
// Two rules shape this module:
//
// 1. A proposal is a proposal. Nothing here executes anything. Anything a
//    tactic implies that would cross a CLAUDE.md hard limit — sending outreach,
//    publishing to a social account, texting a customer, spending ad budget —
//    is flagged with the specific control that gates it, so the proposal
//    surfaces the switch rather than routing around it.
//
// 2. A tactic learned from a third party is not Lion Elite copy. When the
//    lesson's language would fail brand compliance, proposals inherit that and
//    are marked internal-only: adopt the mechanism, rewrite the words.

const { citationFor } = require('./lesson-extractor');

// Which part of the business a tactic belongs to. Checked in order, so the
// more specific lanes are listed before the general ones.
const LANES = [
  {
    id: 'paid-ads',
    label: 'Paid advertising',
    pattern: /\bads?\b|\bad\s+(?:spend|account|set|creative|copy)\b|\bcampaign\b|\bcpm\b|\bcpc\b|\broas\b|\bctr\b|\btargeting\b|\bretarget\w*\b|\bbudget\b|\bbid(?:ding)?\b|\bpixel\b/i
  },
  {
    id: 'real-estate',
    label: 'Real estate acquisition',
    pattern: /\bproperty\b|\bproperties\b|\brental\b|\blandlord\b|\bcap\s+rate\b|\bmortgage\b|\bduplex\b|\bfha\b|\bnoi\b|\bdscr\b|\bclosing\s+costs?\b|\btenants?\b/i
  },
  {
    id: 'outreach',
    label: 'Email & SMS outreach',
    pattern: /\bcold\s+(?:email|outreach|dm)\b|\bemail\s+(?:list|sequence|campaign|copy|subject)\b|\bsubject\s+line\b|\bfollow[-\s]?ups?\b|\bnewsletter\b|\bsms\b|\btext\s+message\b|\bdrip\b/i
  },
  {
    id: 'offer-sales',
    label: 'Offer & sales',
    pattern: /\boffer\b|\bpricing\b|\bprice\s+point\b|\bupsell\b|\bclose\s+(?:the\s+)?(?:sale|deal)\b|\bobjections?\b|\bfunnel\b|\bsales\s+(?:call|page|process)\b|\bconversion\s+rate\b|\bcheckout\b/i
  },
  {
    id: 'content',
    label: 'Organic content',
    pattern: /\b(?:hook|hooks)\b|\bcaption\b|\bthumbnail\b|\bposting\b|\bpost(?:s|ed|ing)?\s+(?:daily|more|consistently)\b|\breels?\b|\bshorts?\b|\bstory|stories\b|\balgorithm\b|\bengagement\b|\bviral\b|\bwatch\s+time\b|\bretention\b/i
  },
  {
    id: 'website',
    label: 'Website & storefront',
    pattern: /\blanding\s+page\b|\bwebsite\b|\bhomepage\b|\bproduct\s+page\b|\bstorefront\b|\bcart\b|\bseo\b|\bpage\s+speed\b/i
  },
  {
    id: 'operations',
    label: 'Systems & automation',
    pattern: /\bautomat(?:e|ed|ion)\b|\bworkflow\b|\bsystem\b|\bprocess\b|\bsop\b|\bdelegat\w+\b|\bhir(?:e|ing)\b|\btrack(?:ing)?\s+(?:metrics|numbers|kpis?)\b/i
  }
];

// Actions that cannot be taken autonomously, mapped to the control that gates
// them. These strings name the real switches documented in CLAUDE.md.
const OWNER_GATES = [
  {
    pattern: /\bsend\b|\bblast\b|\bcold\s+email\b|\bemail\s+(?:them|list|everyone)\b|\bdm\s+(?:them|people)\b/i,
    reason: 'implies sending outreach — gated by OUTREACH_SEND_ENABLED and the outreach kill switch'
  },
  {
    pattern: /\btext\s+(?:them|customers|your\s+list)\b|\bsms\b/i,
    reason: 'implies sending SMS — gated by SMS_SEND_ENABLED plus prior express written consent (TCPA)'
  },
  {
    pattern: /\bpost\s+(?:this|it|daily|to)\b|\bpublish\b|\bschedule\s+(?:posts?|content)\b|\bgo\s+live\b/i,
    reason: 'implies publishing to a brand account — gated by SOCIAL_PUBLISH_ENABLED'
  },
  {
    pattern: /\bspend\b|\bbudget\b|\bscale\s+(?:up|to|the\s+budget)\b|\bincrease\s+(?:the\s+)?(?:budget|spend)\b|\bput\s+\$?\d+/i,
    reason: 'implies ad spend — allowed only inside the owner-approved spend cap'
  },
  {
    pattern: /\b(?:buy|purchase|subscribe\s+to|upgrade\s+to)\b/i,
    reason: 'implies a paid purchase or plan upgrade — needs explicit owner authorization'
  }
];

// How each cue type reads as a piece of work.
const CUE_VERBS = {
  rule: 'Adopt',
  directive: 'Adopt',
  mistake: 'Audit for',
  step: 'Trial',
  method: 'Trial',
  recommendation: 'Evaluate'
};

function classifyLane(text) {
  const lane = LANES.find(({ pattern }) => pattern.test(text));
  return lane ? { id: lane.id, label: lane.label } : { id: 'general', label: 'General business' };
}

function ownerGateFor(text) {
  const gate = OWNER_GATES.find(({ pattern }) => pattern.test(text));
  return gate ? gate.reason : null;
}

/**
 * Condense an extracted line into a task title. The quote is preserved in
 * full on the proposal, so this only has to be readable, not complete.
 */
function condense(text, maxLength = 96) {
  const cleaned = String(text || '')
    .replace(/^(?:and|so|but|then|now|okay|ok|alright|um|uh)\b[\s,]*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLength) return cleaned.replace(/[.,;:]$/, '');
  const cut = cleaned.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:]$/, '')}…`;
}

// A metric stated within ~15 seconds of an instruction is almost always the
// number that instruction is about.
function hasNearbyMetric(action, metricTimestamps) {
  if (!Number.isFinite(action.start)) return false;
  for (const start of metricTimestamps) {
    if (Math.abs(start - action.start) <= 15) return true;
  }
  return false;
}

/**
 * Propose tasks from a lesson's extracted actions.
 *
 * @param {object} lesson - output of buildLesson()
 * @param {object} [options]
 * @param {number} [options.limit] - maximum proposals to return
 * @returns {Array<object>} proposals, highest-signal first
 */
function proposeTasks(lesson, { limit = 8 } = {}) {
  if (!lesson || !Array.isArray(lesson.actions)) return [];

  const internalOnly = Boolean(lesson.reuse?.internalOnly);
  const metricTimestamps = new Set(
    (lesson.metrics || []).map((metric) => metric.start).filter((start) => Number.isFinite(start))
  );

  const proposals = lesson.actions.map((action) => {
    const lane = classifyLane(action.text);
    const ownerAction = ownerGateFor(action.text);
    // An instruction that came with a number attached is more actionable than
    // one that did not, so it sorts higher.
    const hasMetric = hasNearbyMetric(action, metricTimestamps);

    return {
      title: `${CUE_VERBS[action.cue] || 'Review'}: ${condense(action.text)}`,
      lane: lane.id,
      laneLabel: lane.label,
      cue: action.cue,
      quote: action.text,
      citation: citationFor(lesson.source, action.start),
      requiresOwnerAction: Boolean(ownerAction),
      ownerActionReason: ownerAction,
      // Inherited from the lesson: if the source language fails brand
      // compliance, the tactic may be adopted but the wording may not ship.
      customerFacingSafe: !internalOnly,
      score: (hasMetric ? 2 : 0) + (action.cue === 'rule' || action.cue === 'mistake' ? 1 : 0)
    };
  });

  return proposals
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...proposal }) => proposal);
}

/** Count proposals per lane, for the lesson header and the index. */
function summarizeLanes(proposals) {
  const counts = new Map();
  for (const proposal of proposals || []) {
    counts.set(proposal.lane, (counts.get(proposal.lane) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([lane, count]) => ({ lane, count }));
}

module.exports = {
  proposeTasks,
  summarizeLanes,
  classifyLane,
  ownerGateFor,
  condense,
  LANES,
  OWNER_GATES
};
