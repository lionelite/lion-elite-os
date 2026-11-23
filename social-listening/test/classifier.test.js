'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyPost } = require('../src/classifier');

test('matches a researcher sourcing post: subject + purchase intent', () => {
  const { relevant, matches } = classifyPost(
    'Any recommendations for a reliable peptide supplier with real COA documentation? Our lab needs a new source for BPC-157 for an in vitro study.'
  );
  assert.equal(relevant, true);
  const match = matches.find((m) => m.audience === 'research-peptides');
  assert.ok(match);
  assert.equal(match.doNotEngage, false);
  assert.ok(match.score >= 60, String(match.score));
  assert.ok(match.matched.subject.includes('peptide') || match.matched.subject.includes('bpc-157'));
  assert.ok(match.matched.intent.length >= 1);
  assert.ok(match.suggestedOpener.includes('lionelitewellness.com'));
  assert.ok(match.suggestedOpener.toLowerCase().includes('laboratory research purposes only'));
});

test('flags human-use intent as do-not-engage with no suggested opener', () => {
  const { matches } = classifyPost(
    'Looking to buy BPC-157 — starting my cycle next week, what dose did you all inject?'
  );
  const match = matches.find((m) => m.audience === 'research-peptides');
  assert.ok(match, 'still surfaced');
  assert.equal(match.doNotEngage, true);
  assert.equal(match.suggestedOpener, null);
  assert.match(match.doNotEngageReason, /research-use-only/i);
  assert.ok(match.doNotEngageMatches.length >= 2);
});

test('ignores peptide mentions with no purchase intent (news, jokes)', () => {
  for (const text of [
    'Interesting new paper on peptide folding published today.',
    'FDA cracks down on gray-market peptides, story at 9.',
    'peptides lol'
  ]) {
    const { matches } = classifyPost(text);
    assert.equal(matches.some((m) => m.audience === 'research-peptides'), false, text);
  }
});

test('ignores purchase intent with no subject (buying anything else)', () => {
  const { relevant } = classifyPost('Looking for recommendations on where to buy a good espresso machine.');
  assert.equal(relevant, false);
});

test('matches someone publicly looking for a personal trainer', () => {
  const { matches } = classifyPost(
    "New year, same me apparently. Seriously thinking about hiring a personal trainer — any recommendations? Total beginner and no idea where to start."
  );
  const match = matches.find((m) => m.audience === 'personal-training');
  assert.ok(match);
  assert.equal(match.doNotEngage, false);
  assert.ok(match.score >= 60, String(match.score));
  assert.ok(match.suggestedOpener.includes('lionelitebeauty.com'));
});

test('flags trainers advertising themselves as peers, not prospects', () => {
  // A pure ad with no seeking language is filtered out entirely.
  const ad = classifyPost("I'm a certified personal trainer accepting new clients. Best training program in Austin!");
  assert.equal(ad.matches.some((m) => m.audience === 'personal-training'), false);

  // A peer post that DOES contain seeking language surfaces but is flagged.
  const { matches } = classifyPost(
    "Looking for new clients! I'm a certified personal trainer — DM me to start your training program!"
  );
  const match = matches.find((m) => m.audience === 'personal-training');
  assert.ok(match, 'still surfaced');
  assert.equal(match.doNotEngage, true);
  assert.equal(match.suggestedOpener, null);
});

test('personal-training subject without seeking intent does not match', () => {
  const { matches } = classifyPost('Crushed my workout routine today. Gym was empty, loved it.');
  assert.equal(matches.some((m) => m.audience === 'personal-training'), false);
});

test('audience filter restricts classification', () => {
  const text = 'Looking for a reliable peptide vendor for our lab.';
  const both = classifyPost(text);
  assert.equal(both.matches.length >= 1, true);
  const filtered = classifyPost(text, { audiences: ['personal-training'] });
  assert.equal(filtered.relevant, false);
  assert.throws(() => classifyPost(text, { audiences: ['nope'] }), /Unknown audience/);
});

test('term matching respects word boundaries', () => {
  // "order" inside "border", "buy" inside "buyer's remorse story"… should not fire alone,
  // and unrelated words containing subject substrings must not match.
  const { relevant } = classifyPost('The border town semaxxxx festival was great.');
  assert.equal(relevant, false);
});

test('handles empty and non-string input', () => {
  assert.equal(classifyPost('').relevant, false);
  assert.equal(classifyPost(null).relevant, false);
});

// The two segments the owner actually wants to find: people who need a coach,
// and coaches who want to grow their own business. The second used to be
// unreachable — personal-training's doNotEngage patterns treat "I'm a personal
// trainer" and "my clients" as peer-not-prospect, which is correct for that
// audience and exactly wrong for this one.
test('finds a trainer trying to scale their own coaching business', () => {
  const text = "I'm a personal trainer with about 12 clients and I'm drowning in admin. "
    + 'Writing programs in spreadsheets and chasing check-ins over text. '
    + 'How do I scale my coaching business without working 70 hours?';
  const best = classifyPost(text).matches[0];
  assert.equal(best.audience, 'coach-scaling');
  assert.equal(best.doNotEngage, false, 'being a trainer must qualify here, not disqualify');
  assert.ok(best.score >= 60, `expected a strong score, got ${best.score}`);
});

test('still finds someone looking for a coach', () => {
  const text = 'Looking for a personal trainer who can actually keep me accountable. '
    + 'No idea where to start and I need a workout plan that fits a busy schedule.';
  const best = classifyPost(text).matches[0];
  assert.equal(best.audience, 'personal-training');
  assert.equal(best.doNotEngage, false);
});

test('does not surface competitors selling growth services to coaches', () => {
  const { matches } = classifyPost('We help coaches scale to 30k months. Book a free call, link in bio.');
  const engageable = matches.filter(match => !match.doNotEngage);
  assert.deepEqual(engageable, [], 'a competitor pitch is never an engageable lead');
});

test('does not surface a trainer broadcasting their own offer', () => {
  const { matches } = classifyPost("I'm a certified personal trainer accepting new clients! DM me to start.");
  const engageable = matches.filter(match => !match.doNotEngage);
  assert.deepEqual(engageable, [], 'someone advertising is not asking for help');
});

// A coach with no platform yet is the clearest fit for the coach portal, but
// every original subject term assumed an existing roster ("my clients", "scale
// my coaching"), so someone just starting out matched nothing.
test('finds a coach starting their online coaching journey', () => {
  const posts = [
    'Just got certified as a personal trainer and I want to start online coaching. What platform does everyone use for programming and check-ins?',
    'I run in person sessions but want to become an online coach. Need software for coaching that handles client check-ins.',
    'Trying to get my first coaching clients online. How do I actually deliver the programs, just spreadsheets?'
  ];
  for (const text of posts) {
    const best = classifyPost(text).matches[0];
    assert.ok(best, `no match for: ${text.slice(0, 40)}`);
    assert.equal(best.audience, 'coach-scaling', `wrong lane for: ${text.slice(0, 40)}`);
    assert.equal(best.doNotEngage, false);
  }
});

test('someone seeking a coach is still not confused with a coach seeking a platform', () => {
  const best = classifyPost('Looking for a personal trainer who can keep me accountable, no idea where to start.').matches[0];
  assert.equal(best.audience, 'personal-training');
});
