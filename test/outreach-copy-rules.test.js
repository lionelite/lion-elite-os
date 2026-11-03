'use strict';

// Copy discipline for outbound.
//
// Researched across the public cold-outreach benchmark literature on
// 2026-11-03. The structural advice is consistent everywhere; the lift
// percentages are vendor marketing, several of them republishing a 2024 study
// as 2026 data. So these tests pin the SHAPE of a message and deliberately
// pin that no benchmark number is hardcoded — a borrowed target silently
// becomes the number every report is judged against.

const test = require('node:test');
const assert = require('node:assert/strict');

const { reviewEmail, comparison, EMAIL_WORDS, CTA_WORDS } = require('../lib/outreach/copy-rules');
const { buildResearchSupplyEmail } = require('../lib/outreach/campaign-emails');
const { buildEmail, scoreEmail } = require('../lib/email-generation');

const codes = result => result.findings.map(f => f.code);

test('a second ask is flagged', () => {
  // The one structural claim every source agrees on. A second ask splits the
  // decision, and the reader answers neither.
  const result = reviewEmail({
    subject: 'Quick question',
    body: 'We supply research-grade peptides. Worth a short call? Could you also forward this to your director?'
  });
  assert.ok(codes(result).includes('competing_asks'));
  assert.equal(result.stats.asks, 2);
});

test('an email with no ask at all is a blocker, not a warning', () => {
  // Nothing for the reader to reply to. That is not a style preference.
  const result = reviewEmail({ subject: 'Hello', body: 'We supply research-grade peptides to clinics.' });
  assert.ok(result.blockers.includes('no_ask'));
});

test('filter-bait and shouting in the subject are caught', () => {
  const spammy = reviewEmail({ subject: 'FREE GUARANTEED RESULTS', body: 'Worth a short call?' });
  assert.ok(spammy.blockers.includes('subject_shouting'));
  assert.ok(codes(spammy).includes('subject_spam_terms'));
});

test('length is judged in words, in both directions', () => {
  const long = reviewEmail({ subject: 'Supply', body: 'word '.repeat(EMAIL_WORDS.max + 20) + 'Worth a short call?' });
  assert.ok(codes(long).includes('body_too_long'));

  // Too short matters too: without a reason this business was picked, the
  // message reads as a blast, which is what earns complaints.
  const short = reviewEmail({ subject: 'Supply', body: 'Worth a short call?' });
  assert.ok(codes(short).includes('body_too_short'));
});

// --- the live copy -------------------------------------------------------

test('the campaigns we actually send pass the structural rules', () => {
  // This caught something real when it was written: both builders ended on an
  // 18-to-21-word ask, well past the band. They were shortened rather than
  // the band widened to fit them.
  const b2b = buildResearchSupplyEmail({ businessName: 'GlowVita', city: 'Miami Beach' });
  const generic = buildEmail({ businessName: 'Tao Wellness Med Spa', city: 'Tampa' });

  for (const [name, email] of [['research supply', b2b], ['generic', generic]]) {
    const result = reviewEmail({ subject: email.subject, body: email.body });
    assert.deepEqual(result.blockers, [], `${name} has structural blockers`);
    assert.equal(result.stats.asks, 1, `${name} must make exactly one ask`);
    assert.ok(result.stats.links <= 1, `${name} carries ${result.stats.links} links`);
    assert.ok(
      result.stats.words <= EMAIL_WORDS.max,
      `${name} runs ${result.stats.words} words`
    );
  }
});

test('scoreEmail no longer passes a 280-word email as readable', () => {
  // The old check was `body.length <= 1700`, so a wall of text scored 95 on
  // readability. Length is graded on words now, and every structural finding
  // costs.
  const bloated = scoreEmail(
    { subject: 'A partnership idea', body: 'word '.repeat(300) + 'Worth a short call?' },
    { businessName: 'Example Clinic' }
  );
  const tight = scoreEmail(
    buildEmail({ businessName: 'Tao Wellness Med Spa', city: 'Tampa' }),
    { businessName: 'Tao Wellness Med Spa' }
  );
  assert.ok(bloated.dimensions.readability < tight.dimensions.readability);
});

// --- measuring our own numbers -------------------------------------------

test('a winner is not called on a thin sample', () => {
  // The most commonly reported mistake in the literature, and a
  // self-reinforcing one: a false winner becomes the control and the next
  // test is run against noise.
  const result = comparison({ sent: 40, replies: 4 }, { sent: 40, replies: 2 });
  assert.equal(result.verdict, 'inconclusive');
  assert.match(result.reason, /at least/);
});

test('a difference within noise is reported as noise', () => {
  const result = comparison({ sent: 500, replies: 25 }, { sent: 500, replies: 28 });
  assert.equal(result.verdict, 'inconclusive');
});

test('a real difference is called', () => {
  const result = comparison({ sent: 1000, replies: 30 }, { sent: 1000, replies: 70 });
  assert.equal(result.verdict, 'b');
  assert.ok(result.rateB > result.rateA);
});

test('no borrowed benchmark is hardcoded anywhere in the rules', () => {
  // The guard that matters most. Every reply-rate figure available publicly
  // comes from a vendor benchmarking its own customers, and the same vendor
  // publishes both 27.7% and 44% as the 2026 average open rate. Writing one
  // into the system would make it the target every report is judged against,
  // and nobody downstream would know where it came from.
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'lib', 'outreach', 'copy-rules.js'),
    'utf8'
  );
  // Comments are stripped first. The file's own documentation quotes several
  // of these figures precisely to explain why they are not trusted, and a
  // check that cannot tell prose from code would force that reasoning to be
  // deleted — losing the explanation to satisfy the guard.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // Targeted at rate CLAIMS, not at every percent sign. Writing this guard
  // broadly first was instructive: it flagged `'100%'` in the spam-trigger
  // word list and the `95%` confidence level of the z-test, neither of which
  // is a borrowed benchmark. A guard that cries wolf gets deleted, so it
  // looks for a percentage tied to a rate, or a constant named like a target.
  const benchmarkish = code.match(
    /\b\d{1,3}(\.\d+)?\s*%\s*(reply|open|click|conversion|response)|\b(reply|open|click|conversion|response)\s*rate[^\n]{0,20}\d{1,3}(\.\d+)?\s*%|\b(EXPECTED|TARGET|AVERAGE|BENCHMARK)_[A-Z_]*RATE\b/gi
  ) || [];
  assert.deepEqual(
    benchmarkish, [],
    `benchmark figures must stay out of the logic: ${benchmarkish.join(', ')}`
  );
});

test('CTA band is a band, not a single magic number', () => {
  assert.ok(CTA_WORDS.min < CTA_WORDS.max);
});
