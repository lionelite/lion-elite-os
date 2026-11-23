'use strict';

// Fail-closed compliance validation for generated social content.
//
// Lion Elite Wellness (research-only mode): research/education language
// only — no dosing, no human-use instructions, no diagnosis or treatment
// claims, no transformation promises, and a mandatory research disclaimer.
// Lion Elite Beauty (coaching mode): transformation/coaching language is
// allowed, but no medical claims, no guarantees, no specific-outcome
// promises, and no research-product language (brand separation).

const RESEARCH_DISCLAIMER_PHRASE = 'laboratory research purposes only';

// Rules that apply to every brand.
const SHARED_RULES = [
  {
    code: 'guarantee_claim',
    pattern: /\bguarantee[ds]?\b|\bpromise[sd]?\s+(results|you)\b|\bresults?\s+(are\s+)?guaranteed\b/i
  },
  {
    code: 'medical_claim',
    pattern: /\btreat(s|ing|ed)?\s+(disease|illness|conditions?|patients?|symptoms?)\b|\btreatment\b|\bcure[sd]?\b|\bheal(s|ed)?\s+(your|the)\b|\bdiagnos(e|es|is|ed|ing)\b|\bprescri(be|bed|ption)\b|\bclinically\s+proven\b|\bfda[-\s]approved\b|\bprevent(s|ing)?\s+(disease|illness|cancer|aging)\b/i
  },
  {
    code: 'specific_outcome_promise',
    pattern: /\b(lose|drop|shed|gain)\s+\d+\s*(lbs?|pounds|kilos?|kg)\b|\bin\s+(just\s+)?\d+\s+(days|weeks)\s+or\s+less\b/i
  },
  {
    code: 'hype_language',
    pattern: /\bmiracle\b|\bmagic\s+(pill|fix|solution)\b|\binsane\s+results\b|\bovernight\s+(results|transformation)\b/i
  }
];

// Rules that apply only to research-only brands (Lion Elite Wellness).
const RESEARCH_ONLY_RULES = [
  {
    code: 'dosing_language',
    pattern: /\bdos(e|es|ed|ing|age|ages)\b|\b\d+(\.\d+)?\s*(mg|mcg|iu|ml|cc)\b/i
  },
  {
    code: 'human_use_language',
    pattern: /\binject(s|ed|ing|ions?|able)?\b|\byour\s+(protocol|cycle|stack|regimen)\b|\btake\s+(it|this|one|two|daily|nightly|before|after|with)\b|\bhow\s+to\s+(use|take)\b|\bstart\s+(using|taking)\b|\breconstitut(e|ed|ing|ion)\b|\bsubcutaneous\b|\bintramuscular\b/i
  },
  {
    code: 'transformation_promise',
    pattern: /\b(fat|weight)\s+loss\b|\bmuscle\s+(growth|gain|building)\b|\banti[-\s]aging\s+(benefits?|effects?|results?)\b|\bboost(s|ed|ing)?\s+(your|energy|metabolism|testosterone|immunity)\b|\bimprove(s|d)?\s+(your\s+)?(sleep|skin|recovery|energy|mood|focus)\b|\bhelps?\s+you\b|\byou\s+will\s+(feel|see|notice)\b/i
  }
];

// Rules that apply only to coaching brands (Lion Elite Beauty): research
// compounds stay on the Wellness side of the brand line.
const COACHING_ONLY_RULES = [
  {
    code: 'brand_separation',
    pattern: /\bpeptides?\b|\bretatrutide\b|\bsemaglutide\b|\btirzepatide\b|\bnad\+\b|\bbpc[-\s]?157\b|\btb[-\s]?500\b|\bghk[-\s]?cu\b|\bresearch\s+(catalog|product|compound|chemical)s?\b/i
  }
];

function findMatches(text, rules) {
  const blockers = [];
  for (const rule of rules) {
    const match = text.match(rule.pattern);
    if (match) {
      blockers.push({ code: rule.code, match: match[0] });
    }
  }
  return blockers;
}

/**
 * Validate one piece of generated text for one brand.
 *
 * @param {object} input
 * @param {string} input.text - the caption/script text to validate
 * @param {string} input.complianceMode - 'research-only' | 'coaching'
 * @param {boolean} [input.requireDisclaimer] - require the full research
 *   disclaimer phrase (defaults to true for research-only mode)
 * @returns {{ approved: boolean, blockers: Array<{code: string, match?: string}> }}
 */
function validateContent({ text, complianceMode, requireDisclaimer } = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { approved: false, blockers: [{ code: 'empty_content' }] };
  }

  const blockers = findMatches(text, SHARED_RULES);

  if (complianceMode === 'research-only') {
    blockers.push(...findMatches(text, RESEARCH_ONLY_RULES));
    const mustCarryDisclaimer = requireDisclaimer !== false;
    if (mustCarryDisclaimer && !text.toLowerCase().includes(RESEARCH_DISCLAIMER_PHRASE)) {
      blockers.push({ code: 'missing_research_disclaimer' });
    }
  } else if (complianceMode === 'coaching') {
    blockers.push(...findMatches(text, COACHING_ONLY_RULES));
  } else {
    // Unknown mode: fail closed rather than silently skipping brand rules.
    blockers.push({ code: 'unknown_compliance_mode' });
  }

  return { approved: blockers.length === 0, blockers };
}

/**
 * Validate every platform variant of a generated piece. Returns per-platform
 * results plus an overall approved flag (all variants must pass).
 */
function validatePiece(piece, profile) {
  const results = {};
  let approved = true;
  for (const [platform, variant] of Object.entries(piece.platforms || {})) {
    const result = validateContent({
      text: variant.text,
      complianceMode: profile.complianceMode,
      // Stories are short overlays; the disclaimer is still generated into
      // them, but only feed and reel captions hard-require the full phrase.
      requireDisclaimer: piece.slot === 'feed' || piece.slot === 'reel'
        ? true
        : profile.complianceMode === 'research-only'
    });
    results[platform] = result;
    if (!result.approved) approved = false;
  }
  return { approved, platforms: results };
}

module.exports = {
  RESEARCH_DISCLAIMER_PHRASE,
  validateContent,
  validatePiece
};
