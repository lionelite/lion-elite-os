'use strict';

/**
 * Copy discipline for outbound e-mail and SMS, as enforced checks.
 *
 * Researched 2026-11-03 across the public cold-outreach benchmark literature
 * (Belkins' 7.5M-email study, Instantly, Lemlist, Snov.io, Klaviyo and
 * Omnisend SMS benchmarks). Two findings shaped what is and is not encoded
 * here:
 *
 * 1. **The structural advice is consistent across every source**: short,
 *    plain text, one specific low-friction ask, personalisation anchored to a
 *    real fact, almost no links. That consensus is worth enforcing.
 *
 * 2. **The lift percentages are not trustworthy.** Nearly every figure comes
 *    from a tool vendor benchmarking its own customers, several republish a
 *    2024 study as 2026 data, and the same vendor's "average open rate"
 *    appears as both 27.7% and 44% depending on the page. One widely-quoted
 *    claim — a single CTA lifting clicks 371% — has no published methodology.
 *
 * So no benchmark number is hardcoded anywhere in this file. Baking
 * "expect a 5.1% reply rate" into the system would be inventing a target out
 * of someone else's marketing, and every downstream report would inherit it.
 * What is encoded is the shape of the message. What a good rate looks like
 * HERE is something only our own sends can answer — see `comparison()`.
 *
 * Word counts are bands rather than hard gates because they are judgement,
 * not law. The compliance rules in `lib/social/social-compliance.js` and the
 * CAN-SPAM requirements remain separate and absolute; nothing here relaxes
 * them.
 */

// A cold first touch that gets read is short. Sources differ on the exact
// band; they agree the failure mode is length. Below the floor there is not
// enough to establish why this business was contacted, which reads as a blast.
const EMAIL_WORDS = Object.freeze({ min: 50, ideal: 125, max: 160 });

// Subject lines are truncated by mobile clients around 40 characters. Longer
// is not refused — it is flagged, because the tail is what gets cut.
const SUBJECT_CHARS = Object.freeze({ ideal: 40, max: 60 });

// An ask short enough to answer without scheduling anything.
const CTA_WORDS = Object.freeze({ min: 4, max: 12 });

// Links hurt deliverability on a cold send and give a filter something to
// score. One is a booking link or nothing.
const MAX_LINKS = 1;

// Spam-filter triggers in a subject. Deliberately short: a long list starts
// refusing ordinary words and the builder becomes unusable.
const SUBJECT_RED_FLAGS = Object.freeze([
  'free', 'guarantee', 'guaranteed', 'act now', 'limited time', 'urgent',
  'risk free', 'no obligation', 'cash', 'cheap', 'discount', 'winner', '100%'
]);

// A hard ask presumes a decision the reader has not made yet. Cold contexts
// consistently favour the softer version; both appear in the sources, and the
// gap varies by audience, so this is a warning rather than a blocker.
const HARD_ASK = Object.freeze([
  'book a time', 'book a call', 'schedule a demo', 'buy now',
  'sign up today', 'let me know a time that works'
]);

function words(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

function countLinks(text) {
  return (String(text || '').match(/https?:\/\/\S+/gi) || []).length;
}

/**
 * The asks in a body. Counted because a second ask splits the reader's
 * attention — the one structural claim every source agrees on, even though
 * the headline lift figure attached to it is unsupported.
 */
function findAsks(body) {
  return String(body || '')
    .split(/(?<=[.?!])\s+/)
    .map(s => s.trim())
    .filter(s => s.endsWith('?') || /^(could|can|would|are you|is there|open to|worth)\b/i.test(s));
}

/**
 * Review an e-mail's structure. Returns findings, never a verdict on whether
 * to send — `lib/outreach-validation.js` owns that, and compliance owns
 * content. Severity is `blocker` only where the issue would damage
 * deliverability or misrepresent us; everything else is `warning`.
 */
function reviewEmail({ subject = '', body = '' } = {}) {
  const findings = [];
  const bodyWords = words(body);
  const subjectText = String(subject || '').trim();
  const asks = findAsks(body);
  const links = countLinks(body);

  if (bodyWords.length > EMAIL_WORDS.max) {
    findings.push({
      code: 'body_too_long', severity: 'warning',
      detail: `${bodyWords.length} words; cold first touches read best under ${EMAIL_WORDS.ideal}.`
    });
  }
  if (bodyWords.length < EMAIL_WORDS.min) {
    findings.push({
      code: 'body_too_short', severity: 'warning',
      detail: `${bodyWords.length} words; too short to say why this business specifically.`
    });
  }
  if (!subjectText) {
    findings.push({ code: 'subject_missing', severity: 'blocker', detail: 'No subject line.' });
  } else {
    if (subjectText.length > SUBJECT_CHARS.max) {
      findings.push({
        code: 'subject_too_long', severity: 'warning',
        detail: `${subjectText.length} chars; mobile clients cut around ${SUBJECT_CHARS.ideal}.`
      });
    }
    if (subjectText === subjectText.toUpperCase() && /[A-Z]{4,}/.test(subjectText)) {
      findings.push({ code: 'subject_shouting', severity: 'blocker', detail: 'Subject is all caps.' });
    }
    if (/[!]{1,}|\?{2,}/.test(subjectText)) {
      findings.push({ code: 'subject_punctuation', severity: 'warning', detail: 'Exclamation or repeated question marks in the subject.' });
    }
    const flagged = SUBJECT_RED_FLAGS.filter(term =>
      new RegExp(`(^|\\W)${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\W|$)`, 'i').test(subjectText));
    if (flagged.length) {
      findings.push({ code: 'subject_spam_terms', severity: 'warning', detail: `Filter-bait in the subject: ${flagged.join(', ')}.` });
    }
  }

  if (!asks.length) {
    findings.push({ code: 'no_ask', severity: 'blocker', detail: 'No question or ask; nothing for the reader to reply to.' });
  } else if (asks.length > 1) {
    findings.push({
      code: 'competing_asks', severity: 'warning',
      detail: `${asks.length} asks. A second ask splits the decision: ${asks.map(a => `"${a}"`).join(' ')}`
    });
  } else {
    const askWords = words(asks[0]).length;
    if (askWords > CTA_WORDS.max) {
      findings.push({ code: 'ask_too_long', severity: 'warning', detail: `The ask runs ${askWords} words.` });
    }
    if (HARD_ASK.some(phrase => asks[0].toLowerCase().includes(phrase))) {
      findings.push({
        code: 'hard_ask', severity: 'warning',
        detail: 'A hard ask presumes a decision not yet made; a softer one usually answers better cold.'
      });
    }
  }

  if (links > MAX_LINKS) {
    findings.push({ code: 'too_many_links', severity: 'warning', detail: `${links} links; each one gives a filter something to score.` });
  }
  if (/<\/?[a-z][\s\S]*>/i.test(body)) {
    findings.push({ code: 'html_in_body', severity: 'warning', detail: 'HTML markup in a cold send; plain text is read as a person writing.' });
  }

  return {
    findings,
    blockers: findings.filter(f => f.severity === 'blocker').map(f => f.code),
    stats: { words: bodyWords.length, subjectChars: subjectText.length, asks: asks.length, links }
  };
}

/**
 * Whether an A/B result means anything yet.
 *
 * Included because the most commonly reported mistake in the literature is
 * calling a winner before the sample supports it — and that error is
 * self-reinforcing: a false winner becomes the control, and the next test is
 * run against noise. A two-proportion z-test at 95% is not sophisticated, but
 * it is the difference between a measured decision and a hunch.
 *
 * It returns `inconclusive` rather than a winner whenever the evidence is
 * thin. That is the useful answer far more often than people expect.
 */
function comparison(a = {}, b = {}, { confidence = 1.96, minPerVariant = 100 } = {}) {
  const sent = { a: Number(a.sent) || 0, b: Number(b.sent) || 0 };
  const replies = { a: Number(a.replies) || 0, b: Number(b.replies) || 0 };

  if (sent.a < minPerVariant || sent.b < minPerVariant) {
    return {
      verdict: 'inconclusive',
      reason: `Needs at least ${minPerVariant} per variant; have ${sent.a} and ${sent.b}.`,
      rateA: sent.a ? replies.a / sent.a : null,
      rateB: sent.b ? replies.b / sent.b : null
    };
  }

  const pA = replies.a / sent.a;
  const pB = replies.b / sent.b;
  const pooled = (replies.a + replies.b) / (sent.a + sent.b);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / sent.a + 1 / sent.b));
  if (!se) {
    return { verdict: 'inconclusive', reason: 'No replies on either variant yet.', rateA: pA, rateB: pB };
  }

  const z = (pB - pA) / se;
  if (Math.abs(z) < confidence) {
    return {
      verdict: 'inconclusive',
      reason: `Difference is within noise (z=${z.toFixed(2)}). Keep both running.`,
      rateA: pA, rateB: pB, z
    };
  }

  return {
    verdict: z > 0 ? 'b' : 'a',
    reason: `Significant at 95% (z=${z.toFixed(2)}).`,
    rateA: pA, rateB: pB, z
  };
}

module.exports = {
  EMAIL_WORDS, SUBJECT_CHARS, CTA_WORDS, MAX_LINKS,
  SUBJECT_RED_FLAGS, HARD_ASK,
  reviewEmail, comparison, findAsks
};
