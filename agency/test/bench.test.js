const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planEngagement } = require('../src/engagement');
const L = require('../src/ledger');
const B = require('../src/bench');

const EXAMPLES = path.join(__dirname, '..', 'examples');
const CEDAR = planEngagement(JSON.parse(fs.readFileSync(path.join(EXAMPLES, 'cedar-roofing.json'), 'utf8')));
const BASE = ['nda', 'ip-assignment', 'non-solicit', 'independent-contractor'];

function signed(ids = BASE) {
  return Object.fromEntries(ids.map((i) => [i, { signedAt: '2026-01-10T00:00:00Z' }]));
}

function ticket(milestoneId) {
  const t = CEDAR.deliveryPlan.tickets.find((x) => x.milestoneId === milestoneId);
  assert.ok(t, `fixture must contain a ${milestoneId} ticket`);
  return t;
}

function benchWith(...contractors) {
  const b = B.newBench();
  for (const c of contractors) B.upsertContractor(b, c);
  return b;
}

const MIRA = { id: 'dev-mira', name: 'Mira K.', capabilities: ['lead-capture', 'follow-up', 'qualification'], maxConcurrent: 3, agreements: signed() };
const TOMAS = { id: 'dev-tomas', name: 'Tomas R.', capabilities: ['reporting', 'scheduling'], maxConcurrent: 2, agreements: signed() };
const UNPAPERED = { id: 'dev-priya', name: 'Priya S.', capabilities: ['follow-up'], maxConcurrent: 2, agreements: signed(['nda']) };

function ledgerHolding(assignments = []) {
  const l = L.openLedger(CEDAR);
  l.assignments = assignments;
  return l;
}

function held(contractorId, ticketId, extra = {}) {
  return { ticketId, milestoneId: 'follow-up', contractorId, fixedPrice: 775, accessTier: 'sandbox', assignedAt: '2026-02-01T00:00:00Z', releasedAt: null, outcome: null, ...extra };
}

test('a contractor cleared for nothing is not assignable to anything', () => {
  const b = benchWith({ id: 'new', name: 'New', agreements: signed() });
  const result = B.eligibilityFor(b, 'new', ticket('lead-capture'), []);
  assert.equal(result.assignable, false);
  assert.ok(result.blockers.some((x) => /Not cleared for lead-capture/.test(x)));
});

test('an unknown capability id is rejected at the bench, not silently stored', () => {
  assert.throws(
    () => B.upsertContractor(B.newBench(), { id: 'x', capabilities: ['reporting-dashboard'] }),
    /Unknown capability id/,
  );
});

test('every offer capability plus launch-hardening is assignable', () => {
  const b = benchWith({ id: 'all', capabilities: [...B.ASSIGNABLE_CAPABILITIES], agreements: signed() });
  assert.equal(B.getContractor(b, 'all').capabilities.length, B.ASSIGNABLE_CAPABILITIES.length);
  for (const t of CEDAR.deliveryPlan.tickets) {
    assert.ok(B.ASSIGNABLE_CAPABILITIES.includes(t.milestoneId), `${t.milestoneId} must be clearable`);
  }
});

test('unsigned paperwork blocks assignment, delegating to the one existing gate', () => {
  const b = benchWith(UNPAPERED);
  const result = B.eligibilityFor(b, 'dev-priya', ticket('follow-up'), []);
  assert.equal(result.assignable, false);
  assert.ok(result.blockers.some((x) => /ip-assignment/.test(x)));
});

test('a capability mismatch blocks assignment even with clean paperwork', () => {
  const b = benchWith(TOMAS);
  assert.equal(B.eligibilityFor(b, 'dev-tomas', ticket('follow-up'), []).assignable, false);
  assert.equal(B.eligibilityFor(b, 'dev-tomas', ticket('reporting'), []).assignable, true);
});

test('a contractor at capacity is not assignable', () => {
  const b = benchWith(MIRA);
  const ledgers = [ledgerHolding([held('dev-mira', 't1'), held('dev-mira', 't2'), held('dev-mira', 't3')])];
  const result = B.eligibilityFor(b, 'dev-mira', ticket('follow-up'), ledgers);
  assert.equal(result.assignable, false);
  assert.ok(result.blockers.some((x) => /At capacity: holding 3 of a maximum 3/.test(x)));
  assert.equal(result.headroom, 0);
});

test('released tickets free the slot again', () => {
  const b = benchWith(MIRA);
  const ledgers = [ledgerHolding([
    held('dev-mira', 't1', { releasedAt: '2026-03-01T00:00:00Z', outcome: 'completed' }),
    held('dev-mira', 't2'),
  ])];
  const result = B.eligibilityFor(b, 'dev-mira', ticket('follow-up'), ledgers);
  assert.equal(result.load, 1);
  assert.equal(result.assignable, true);
});

test('load counts across every engagement, not just one', () => {
  const b = benchWith(MIRA);
  const a = ledgerHolding([held('dev-mira', 't1')]);
  const c = ledgerHolding([held('dev-mira', 't2'), held('dev-mira', 't3')]);
  c.clientRef = 'other-client';
  assert.equal(B.currentLoad('dev-mira', [a, c]).length, 3);
  assert.equal(B.eligibilityFor(b, 'dev-mira', ticket('follow-up'), [a, c]).assignable, false);
});

test('someone already holding the ticket is not assigned it twice', () => {
  const b = benchWith(MIRA);
  const t = ticket('follow-up');
  const ledgers = [ledgerHolding([held('dev-mira', t.id)])];
  const result = B.eligibilityFor(b, 'dev-mira', t, ledgers);
  assert.ok(result.blockers.some((x) => /Already holding/.test(x)));
});

test('someone not on the bench is refused by name', () => {
  const result = B.eligibilityFor(benchWith(MIRA), 'ghost', ticket('follow-up'), []);
  assert.equal(result.assignable, false);
  assert.match(result.blockers[0], /not on the bench/);
});

test('eligibility requires a ticket carrying an access plan', () => {
  assert.throws(() => B.eligibilityFor(benchWith(MIRA), 'dev-mira', { id: 'raw' }, []), /buildDeliveryPlan/);
});

test('track record counts first-pass work separately from rework', () => {
  const ledgers = [ledgerHolding([
    held('dev-mira', 't1', { releasedAt: '2026-03-01T00:00:00Z', outcome: 'completed' }),
    held('dev-mira', 't2', { releasedAt: '2026-03-02T00:00:00Z', outcome: 'completed-after-rework' }),
    held('dev-mira', 't3', { releasedAt: '2026-03-03T00:00:00Z', outcome: 'completed' }),
    held('dev-mira', 't4', { releasedAt: '2026-03-04T00:00:00Z', outcome: 'abandoned' }),
  ])];
  const perf = B.performanceOf('dev-mira', ledgers);
  assert.equal(perf.ticketsClosed, 4);
  assert.equal(perf.completedFirstPass, 2);
  assert.equal(perf.neededRework, 1);
  assert.equal(perf.failedOrReassigned, 1);
  assert.equal(perf.firstPassRate, 0.5);
  assert.equal(perf.proven, true);
});

test('an open assignment does not count toward the track record', () => {
  const ledgers = [ledgerHolding([held('dev-mira', 't1'), held('dev-mira', 't2', { releasedAt: '2026-03-01T00:00:00Z', outcome: 'completed' })])];
  assert.equal(B.performanceOf('dev-mira', ledgers).ticketsClosed, 1);
});

test('nobody is proven until three tickets are closed', () => {
  const two = [ledgerHolding([
    held('dev-mira', 't1', { releasedAt: '2026-03-01T00:00:00Z', outcome: 'completed' }),
    held('dev-mira', 't2', { releasedAt: '2026-03-02T00:00:00Z', outcome: 'completed' }),
  ])];
  assert.equal(B.performanceOf('dev-mira', two).proven, false);
  assert.equal(B.performanceOf('nobody', []).firstPassRate, null);
});

test('cost variance is summed from payments actually made to that contractor', () => {
  const l = ledgerHolding([]);
  l.payments = [
    { milestoneId: 'm1', contractorId: 'dev-mira', amount: 800, planned: 775, variance: 25 },
    { milestoneId: 'm2', contractorId: 'dev-tomas', amount: 700, planned: 700, variance: 0 },
    { milestoneId: 'm3', contractorId: 'dev-mira', amount: 900, planned: 800, variance: 100 },
  ];
  assert.equal(B.performanceOf('dev-mira', [l]).costVariance, 125);
  assert.equal(B.performanceOf('dev-tomas', [l]).costVariance, 0);
});

test('the recommendation ranks proven reliability above an empty record', () => {
  const b = benchWith(MIRA, { ...TOMAS, capabilities: ['lead-capture'] });
  const ledgers = [ledgerHolding([
    held('dev-mira', 't1', { releasedAt: '2026-03-01T00:00:00Z', outcome: 'completed' }),
    held('dev-mira', 't2', { releasedAt: '2026-03-02T00:00:00Z', outcome: 'completed' }),
    held('dev-mira', 't3', { releasedAt: '2026-03-03T00:00:00Z', outcome: 'completed' }),
  ])];
  const result = B.recommendAssignee(b, ticket('lead-capture'), ledgers);
  assert.equal(result.recommended.contractorId, 'dev-mira');
  assert.match(result.reason, /100% first-pass/);
});

test('an unproven contractor still outranks one with a bad record', () => {
  const b = benchWith({ ...MIRA, capabilities: ['lead-capture'] }, { ...TOMAS, capabilities: ['lead-capture'] });
  const ledgers = [ledgerHolding([
    held('dev-mira', 't1', { releasedAt: '2026-03-01T00:00:00Z', outcome: 'abandoned' }),
    held('dev-mira', 't2', { releasedAt: '2026-03-02T00:00:00Z', outcome: 'completed-after-rework' }),
    held('dev-mira', 't3', { releasedAt: '2026-03-03T00:00:00Z', outcome: 'abandoned' }),
  ])];
  const result = B.recommendAssignee(b, ticket('lead-capture'), ledgers);
  assert.equal(result.recommended.contractorId, 'dev-tomas', 'a 0% first-pass record must rank below no record');
});

test('cheapness never outranks reliability', () => {
  const b = benchWith({ ...MIRA, capabilities: ['lead-capture'] }, { ...TOMAS, capabilities: ['lead-capture'], maxConcurrent: 3 });
  const l = ledgerHolding([
    held('dev-mira', 't1', { releasedAt: '2026-03-01T00:00:00Z', outcome: 'completed' }),
    held('dev-mira', 't2', { releasedAt: '2026-03-02T00:00:00Z', outcome: 'completed' }),
    held('dev-mira', 't3', { releasedAt: '2026-03-03T00:00:00Z', outcome: 'completed' }),
    held('dev-tomas', 't4', { releasedAt: '2026-03-04T00:00:00Z', outcome: 'completed-after-rework' }),
    held('dev-tomas', 't5', { releasedAt: '2026-03-05T00:00:00Z', outcome: 'completed-after-rework' }),
    held('dev-tomas', 't6', { releasedAt: '2026-03-06T00:00:00Z', outcome: 'completed' }),
  ]);
  // Tomas came in under budget every time; Mira was exactly on plan.
  l.payments = [
    { contractorId: 'dev-tomas', variance: -300 }, { contractorId: 'dev-tomas', variance: -200 },
    { contractorId: 'dev-mira', variance: 0 },
  ];
  const result = B.recommendAssignee(b, ticket('lead-capture'), [l]);
  assert.equal(result.recommended.contractorId, 'dev-mira', 'rework costs more than the fixed price saved');
});

test('nobody available is reported as a fact, with every exclusion explained', () => {
  const b = benchWith(TOMAS, UNPAPERED);
  const result = B.recommendAssignee(b, ticket('follow-up'), []);
  assert.equal(result.recommended, null);
  assert.equal(result.ranked.length, 0);
  assert.equal(result.excluded.length, 2);
  assert.match(result.reason, /Nobody on the bench can take/);
  for (const e of result.excluded) assert.ok(e.blockers.length > 0);
});

test('capacity excludes suspended and unpapered contractors from usable slots', () => {
  const b = benchWith(MIRA, { ...TOMAS, suspended: true }, UNPAPERED);
  const cap = B.capacity(b, []);
  assert.equal(cap.contractors, 2, 'suspended is not active');
  assert.equal(cap.assignableContractors, 1, 'only Mira is papered and active');
  assert.equal(cap.totalCapacity, MIRA.maxConcurrent, 'an unpapered contractor contributes no usable capacity');
});

test('a single-contractor bench is flagged as a single point of failure', () => {
  assert.ok(B.capacity(benchWith(MIRA), []).warnings.some((w) => /single point of failure/.test(w)));
});

test('a bench with nobody papered says so specifically', () => {
  const warnings = B.capacity(benchWith(UNPAPERED), []).warnings;
  assert.ok(warnings.some((w) => /No contractor on the bench has complete paperwork/.test(w)));
});

test('concentration in one pair of hands is flagged', () => {
  const b = benchWith(MIRA, TOMAS);
  const ledgers = [ledgerHolding([held('dev-mira', 't1'), held('dev-mira', 't2'), held('dev-tomas', 't3')])];
  assert.ok(B.capacity(b, ledgers).warnings.some((w) => /stalls the book/.test(w)));
});

test('concentration is not flagged on a first assignment — 1 of 1 is noise', () => {
  const b = benchWith(MIRA, TOMAS);
  const ledgers = [ledgerHolding([held('dev-mira', 't1')])];
  assert.ok(!B.capacity(b, ledgers).warnings.some((w) => /stalls the book/.test(w)));
  const two = [ledgerHolding([held('dev-mira', 't1'), held('dev-mira', 't2')])];
  assert.ok(!B.capacity(b, two).warnings.some((w) => /stalls the book/.test(w)));
});

test('a nearly committed bench warns before another deal is sold', () => {
  const b = benchWith({ ...MIRA, maxConcurrent: 2 }, { ...TOMAS, maxConcurrent: 2 });
  const ledgers = [ledgerHolding([held('dev-mira', 't1'), held('dev-mira', 't2'), held('dev-tomas', 't3'), held('dev-tomas', 't4')])];
  assert.ok(B.capacity(b, ledgers).warnings.some((w) => /recruit before selling/.test(w)));
});

test('work held by someone who left the bench is surfaced for reassignment', () => {
  const b = benchWith(MIRA);
  const ledgers = [ledgerHolding([held('dev-departed', 't9')])];
  const cap = B.capacity(b, ledgers);
  assert.equal(cap.orphanedAssignments.length, 1);
  assert.ok(cap.warnings.some((w) => /off the bench. Reassign it/.test(w)));
});

test('the bench report is internal and never shows free slots for a blocked contractor', () => {
  const md = B.renderBench(benchWith(MIRA, UNPAPERED), []);
  assert.match(md, /INTERNAL/);
  assert.match(md, /Cannot be assigned — paperwork outstanding/);
  assert.match(md, /Priya S\. — Unsigned/);
  assert.match(md, /\| blocked \|/);
});

test('an empty bench renders a usable next step', () => {
  assert.match(B.renderBench(B.newBench(), []), /Nobody on the bench yet/);
});

test('upsert replaces rather than duplicating', () => {
  const b = benchWith(MIRA);
  B.upsertContractor(b, { ...MIRA, name: 'Mira Kowalski', maxConcurrent: 5 });
  assert.equal(b.contractors.length, 1);
  assert.equal(B.getContractor(b, 'dev-mira').name, 'Mira Kowalski');
  assert.equal(B.getContractor(b, 'dev-mira').maxConcurrent, 5);
});

test('a contractor needs an id', () => {
  assert.throws(() => B.upsertContractor(B.newBench(), { name: 'No Id' }), TypeError);
});

test('an invalid max concurrent falls back to the default rather than zero', () => {
  const b = benchWith({ id: 'x', agreements: signed(), maxConcurrent: 0 });
  assert.equal(B.getContractor(b, 'x').maxConcurrent, B.DEFAULT_MAX_CONCURRENT);
});
