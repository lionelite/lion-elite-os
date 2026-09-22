const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FUNNEL_STAGES, ALL_EVENT_TYPES, REVENUE_EVENTS, buildEvent, isFunnelStage } = require('../lib/revenue/funnel-events');
const { STAGE_PROBABILITY, toPipelineLeads } = require('../lib/revenue/intelligence-adapter');

const base = { subjectId: 'p1', brand: 'wellness', source: 'outreach_b2b', occurredAt: '2026-09-22T12:00:00.000Z' };

test('a booked meeting is a recordable funnel event', () => {
  // It was not: the prospect store has had a meeting_booked STAGE since it was
  // written, but there was no matching funnel EVENT, so the revenue funnel could
  // not see the milestone at all.
  const event = buildEvent({ type: 'meeting_booked', ...base });
  assert.equal(event.type, 'meeting_booked');
  assert.equal(isFunnelStage('meeting_booked'), true);
});

test('a held meeting is a separate event from a booked one', () => {
  assert.ok(FUNNEL_STAGES.includes('meeting_booked'));
  assert.ok(FUNNEL_STAGES.includes('meeting_held'));
  assert.notEqual(FUNNEL_STAGES.indexOf('meeting_booked'), FUNNEL_STAGES.indexOf('meeting_held'));
});

test('booked sits after qualified and before offer_sent, so the conversion walk is ordered', () => {
  const i = (s) => FUNNEL_STAGES.indexOf(s);
  assert.ok(i('qualified') < i('meeting_booked'), 'a meeting is booked after qualification');
  assert.ok(i('meeting_booked') < i('meeting_held'), 'booked precedes held');
  assert.ok(i('meeting_held') < i('offer_sent'), 'the offer follows the conversation');
});

test('neither meeting event counts as collected revenue', () => {
  // A booked call is not money. Adding it to REVENUE_EVENTS would report
  // calendar entries as income.
  for (const type of ['meeting_booked', 'meeting_held']) {
    assert.ok(!REVENUE_EVENTS.includes(type), `${type} must not be a revenue event`);
  }
});

test('a booked meeting is weighted barely above qualified, because no-shows are routine', () => {
  assert.ok(STAGE_PROBABILITY.meeting_booked > STAGE_PROBABILITY.qualified);
  assert.ok(STAGE_PROBABILITY.meeting_booked < STAGE_PROBABILITY.meeting_held,
    'a call that happened is worth more than one merely on the calendar');
  assert.ok(STAGE_PROBABILITY.meeting_held < STAGE_PROBABILITY.offer_sent);
  // The booked→held gap must be a real jump, or the distinction is decorative.
  assert.ok(STAGE_PROBABILITY.meeting_held - STAGE_PROBABILITY.meeting_booked >= 0.05);
});

test('the pipeline forecast values a booking below a held call', () => {
  const booked = toPipelineLeads([{ type: 'meeting_booked', subjectId: 'a', ...base }], { averageOrderValue: 1000 });
  const held = toPipelineLeads([{ type: 'meeting_held', subjectId: 'b', ...base }], { averageOrderValue: 1000 });
  assert.equal(booked.length, 1);
  assert.equal(held.length, 1);
  assert.ok(booked[0].stageProbability < held[0].stageProbability,
    'a no-show-prone booking must not forecast like a conversation that happened');
  // And therefore the weighted contribution to the forecast is smaller.
  assert.ok(booked[0].value * booked[0].stageProbability < held[0].value * held[0].stageProbability);
});

test('a subject who booked and then held is counted once, at the furthest stage', () => {
  const leads = toPipelineLeads([
    { type: 'meeting_booked', subjectId: 'same', ...base },
    { type: 'meeting_held', subjectId: 'same', ...base },
  ], { averageOrderValue: 1000 });
  assert.equal(leads.length, 1, 'one person is one lead');
  assert.equal(leads[0].stage, 'meeting_held');
});

test('an unknown meeting-ish event is still refused', () => {
  assert.throws(() => buildEvent({ type: 'meeting_maybe', ...base }), /unknown event type/);
  assert.throws(() => buildEvent({ type: 'meeting', ...base }), /unknown event type/);
});

// The drift guard. This gap existed because two vocabularies described the same
// milestone and nothing reconciled them — the same class as the four
// producer/consumer bugs in CLAUDE.md's recent fixes.
test('every prospect-store stage that names a funnel milestone exists as a funnel event', () => {
  const storeSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'postgres-prospect-store.js'), 'utf8');
  const enqueueSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'outreach-enqueue.js'), 'utf8');

  // Stages whose name asserts a funnel milestone the revenue side should see.
  // Pipeline-internal stages (queued, sent, nurture, …) deliberately have no
  // funnel event and are not listed here.
  const MILESTONE_STAGES = ['meeting_booked'];

  for (const stage of MILESTONE_STAGES) {
    assert.ok(storeSource.includes(`'${stage}'`) || enqueueSource.includes(`'${stage}'`),
      `${stage} is no longer a prospect stage — update this reconciliation`);
    assert.ok(ALL_EVENT_TYPES.includes(stage),
      `prospect stage "${stage}" has no matching funnel event, so reaching it is invisible to revenue reporting`);
  }
});

test('the funnel stage list stays ordered and duplicate-free', () => {
  assert.equal(new Set(FUNNEL_STAGES).size, FUNNEL_STAGES.length, 'a duplicated stage would double-count conversion');
  for (const stage of FUNNEL_STAGES) {
    assert.ok(ALL_EVENT_TYPES.includes(stage));
  }
});
