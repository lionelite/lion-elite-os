const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planEngagement } = require('../src/engagement');
const qc = require('../src/qc');
const L = require('../src/ledger');
const A = require('../src/arbitration');

const CEDAR = planEngagement(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'cedar-roofing.json'), 'utf8')));
const MILESTONE = CEDAR.deliveryPlan.milestones[1];
const TICKET = CEDAR.deliveryPlan.tickets.find((t) => t.milestoneId === MILESTONE.id);
const POSITION = 'A review was completed and approved on the pull request, so this criterion is met.';

function evaluation({ pass = false, reviewer = 'owner' } = {}) {
  const c = qc.newChecklist(MILESTONE.id);
  for (const item of qc.BLOCKING_ITEMS) {
    if (item.id === 'acceptance-tests') continue;
    qc.record(c, item.id, pass ? true : item.id !== 'code-review');
  }
  c.reviewedBy = reviewer;
  const results = {};
  for (const t of MILESTONE.acceptanceTests) results[t.id] = true;
  return qc.evaluateMilestone(MILESTONE, c, results);
}

function dispute(overrides = {}) {
  return A.openDispute({
    evaluation: evaluation(),
    ticketId: TICKET.id,
    contractorId: 'dev-mira',
    contractorPosition: POSITION,
    ...overrides,
  });
}

function decide(d, overrides = {}) {
  return A.decideDispute(d, {
    outcome: 'upheld',
    decidedBy: 'senior-dev',
    citedItems: ['code-review'],
    rationale: 'Checked the pull request history against the criterion wording.',
    ...overrides,
  });
}

function inDelivery() {
  const l = L.openLedger(CEDAR);
  L.recordProposalSent(l);
  L.recordReceipt(l, { amount: CEDAR.economics.depositAmount, kind: 'deposit' });
  L.transition(l, 'won');
  L.transition(l, 'in_delivery');
  return l;
}

// ---- opening ----

test('a dispute captures the contested items from the real QC rejection', () => {
  const d = dispute();
  assert.equal(d.status, 'open');
  assert.equal(d.milestoneId, MILESTONE.id);
  assert.equal(d.qcReviewedBy, 'owner');
  assert.ok(d.contestedItems.some((i) => i.id === 'code-review'));
});

test('a dispute cannot be opened against an acceptance', () => {
  assert.throws(() => dispute({ evaluation: evaluation({ pass: true }) }), /nothing to dispute/);
});

test('a dispute cannot be opened against a fabricated evaluation', () => {
  assert.throws(() => dispute({ evaluation: { accepted: false, milestoneId: MILESTONE.id } }), /must reference a real/);
  assert.throws(() => dispute({ evaluation: null }), /must reference a real/);
});

test('a dispute needs a stated position long enough to adjudicate', () => {
  assert.throws(() => dispute({ contractorPosition: 'nope' }), /must state which criterion/);
  assert.throws(() => dispute({ contractorPosition: '   ' }), /must state which criterion/);
});

test('a dispute needs a ticket and a contractor', () => {
  assert.throws(() => dispute({ ticketId: null }), TypeError);
  assert.throws(() => dispute({ contractorId: null }), TypeError);
});

test('the decision deadline is business days out, skipping weekends', () => {
  // Friday 2026-09-18 + 5 business days = Friday 2026-09-25.
  const d = dispute({ at: new Date('2026-09-18T12:00:00Z') });
  assert.equal(d.decideBy.slice(0, 10), '2026-09-25');
  const saturday = A.addBusinessDays(new Date('2026-09-19T12:00:00Z'), 1);
  assert.equal(saturday.getUTCDay(), 1, 'a business day after Saturday is Monday');
});

// ---- the fairness rule ----

test('whoever ran the failing review cannot decide the appeal against it', () => {
  assert.throws(() => decide(dispute(), { decidedBy: 'owner' }), /cannot decide the appeal/);
  assert.doesNotThrow(() => decide(dispute(), { decidedBy: 'senior-dev' }));
});

test('a ruling needs a named decider', () => {
  assert.throws(() => decide(dispute(), { decidedBy: null }), TypeError);
});

// ---- the citation rule ----

test('a substantive ruling must cite a contested acceptance item', () => {
  assert.throws(() => decide(dispute(), { citedItems: [] }), /must cite the acceptance item/);
  assert.throws(() => decide(dispute(), { citedItems: undefined }), /must cite the acceptance item/);
});

test('a ruling cannot turn on something quality control never raised', () => {
  assert.throws(() => decide(dispute(), { citedItems: ['docs-updated'] }), /not in dispute/);
});

test('a substantive ruling needs a rationale the contractor can read', () => {
  assert.throws(() => decide(dispute(), { rationale: 'no' }), /needs a stated rationale/);
  assert.throws(() => decide(dispute(), { rationale: null }), /needs a stated rationale/);
});

test('a withdrawal needs no citation, because nobody ruled on anything', () => {
  const d = A.decideDispute(dispute(), { outcome: 'withdrawn', decidedBy: 'senior-dev' });
  assert.equal(d.decision.outcome, 'withdrawn');
  assert.equal(d.decision.paysContractor, false);
});

test('an unknown outcome is refused', () => {
  assert.throws(() => decide(dispute(), { outcome: 'probably fine' }), /Unknown dispute outcome/);
});

// ---- outcomes and who bears the cost ----

test('upheld means rework at no extra cost and says nothing about our process', () => {
  const d = decide(dispute(), { outcome: 'upheld' });
  assert.equal(d.decision.paysContractor, false);
  assert.equal(d.decision.ourSpecDefect, false);
  assert.equal(d.decision.ourQcError, false);
  assert.match(A.requiredActions(d)[0], /rework at no additional cost/);
});

test('overturned pays the contractor and records it as our QC error', () => {
  const d = decide(dispute(), { outcome: 'overturned' });
  assert.equal(d.decision.paysContractor, true);
  assert.equal(d.decision.ourQcError, true);
  assert.equal(d.decision.ourSpecDefect, false);
  assert.ok(A.requiredActions(d).some((a) => /our gate is too harsh/.test(a)));
});

test('an ambiguous criterion is OUR defect — the contractor is paid in full', () => {
  const d = decide(dispute(), { outcome: 'split' });
  assert.equal(d.decision.paysContractor, true);
  assert.equal(d.decision.ourSpecDefect, true);
  assert.match(A.requiredActions(d)[0], /Pay the contractor in full/);
  assert.ok(A.requiredActions(d).some((a) => /delivery-plan\.js/.test(a)));
});

test('a decided dispute cannot be decided again', () => {
  const d = decide(dispute());
  assert.throws(() => decide(d), /already decided/);
});

// ---- the timebox ----

test('an open dispute past its window is overdue', () => {
  const stale = dispute({ at: new Date(Date.now() - 30 * 86400000) });
  assert.equal(A.isOverdue(stale), true);
  assert.equal(A.isOverdue(dispute()), false);
});

test('a decided dispute is never overdue', () => {
  const stale = decide(dispute({ at: new Date(Date.now() - 30 * 86400000) }));
  assert.equal(A.isOverdue(stale), false);
});

test('an overdue dispute escalates with the reason stated', () => {
  const e = A.escalate(dispute({ at: new Date(Date.now() - 30 * 86400000) }), {});
  assert.equal(e.status, 'escalated');
  assert.match(e.escalationReason, /Not decided within 5 business days/);
  assert.ok(A.requiredActions(e).some((a) => /unpaid and unanswered/.test(a)));
});

test('a decided dispute cannot be escalated, and escalation is not repeatable', () => {
  assert.throws(() => A.escalate(decide(dispute()), {}), /already decided/);
  const e = A.escalate(dispute(), {});
  assert.throws(() => A.escalate(e, {}), /already escalated/);
});

test('an open dispute tells us the next action includes a different reviewer', () => {
  const actions = A.requiredActions(dispute());
  assert.ok(actions.some((a) => /not owner/.test(a)));
  assert.ok(actions.some((a) => /Payment on this ticket is held/.test(a)));
});

// ---- ledger integration ----

test('a milestone with an open dispute cannot be accepted', () => {
  const l = inDelivery();
  L.recordDispute(l, dispute());
  assert.throws(() => L.acceptMilestone(l, evaluation({ pass: true })), /open dispute/);
});

test('deciding the dispute unblocks acceptance', () => {
  const l = inDelivery();
  const d = dispute();
  L.recordDispute(l, d);
  L.resolveDispute(l, decide(d, { outcome: 'overturned' }));
  assert.doesNotThrow(() => L.acceptMilestone(l, evaluation({ pass: true })));
});

test('payment is held while a dispute on that milestone is open, even once accepted', () => {
  const l = inDelivery();
  L.acceptMilestone(l, evaluation({ pass: true }));
  L.recordDispute(l, dispute());
  assert.throws(() => L.releasePayment(l, { milestoneId: MILESTONE.id }), /Payment for .* is held/);
  assert.deepEqual(L.disputedTickets(l), [TICKET.id]);
});

test('a hand-built dispute cannot be recorded on the ledger', () => {
  const l = inDelivery();
  assert.throws(() => L.recordDispute(l, { ticketId: 't', milestoneId: MILESTONE.id, status: 'open' }), /did not come from arbitration.openDispute/);
  assert.throws(() => L.recordDispute(l, {}), TypeError);
});

test('a dispute against a milestone from another engagement is refused', () => {
  const l = inDelivery();
  const foreign = { ...dispute(), milestoneId: 'not-ours' };
  assert.throws(() => L.recordDispute(l, foreign), /not part of/);
});

test('a ticket cannot have two open disputes at once', () => {
  const l = inDelivery();
  L.recordDispute(l, dispute());
  assert.throws(() => L.recordDispute(l, dispute()), /already has an open dispute/);
});

test('resolving requires an open dispute to resolve', () => {
  const l = inDelivery();
  assert.throws(() => L.resolveDispute(l, decide(dispute())), /No open dispute/);
});

test('a dispute can be raised and resolved after the build closes', () => {
  const l = inDelivery();
  for (const m of CEDAR.deliveryPlan.milestones) {
    L.acceptMilestone(l, (() => {
      const c = qc.newChecklist(m.id);
      for (const item of qc.BLOCKING_ITEMS) { if (item.id !== 'acceptance-tests') qc.record(c, item.id, true); }
      c.reviewedBy = 'owner';
      const results = {};
      for (const t of m.acceptanceTests) results[t.id] = true;
      return qc.evaluateMilestone(m, c, results);
    })());
    if (m.developerPayout > 0) L.releasePayment(l, { milestoneId: m.id });
    if (m.triggersClientBalance) L.recordReceipt(l, { amount: CEDAR.economics.balanceAmount, kind: 'balance' });
  }
  L.transition(l, 'delivered');
  L.transition(l, 'closed');
  // A late dispute is still a real obligation.
  assert.doesNotThrow(() => L.recordDispute(l, dispute()));
});

test('the ledger history records the dispute and its outcome', () => {
  const l = inDelivery();
  const d = dispute();
  L.recordDispute(l, d);
  L.resolveDispute(l, decide(d, { outcome: 'split' }));
  const notes = l.history.map((h) => h.note).filter(Boolean);
  assert.ok(notes.some((n) => /Dispute opened on/.test(n)));
  assert.ok(notes.some((n) => /split/.test(n)));
});

// ---- statistics read the right way round ----

function ledgerWithOutcomes(outcomes) {
  const l = L.openLedger(CEDAR);
  l.disputes = outcomes.map((outcome, i) => {
    const d = { ...dispute(), ticketId: `${TICKET.id}-${i}` };
    return outcome === 'open' ? d : decide(d, { outcome, citedItems: outcome === 'withdrawn' ? [] : ['code-review'] });
  });
  return l;
}

test('a high overturn rate is reported as a finding about OUR quality control', () => {
  const stats = A.disputeStats([ledgerWithOutcomes(['overturned', 'overturned', 'upheld', 'overturned'])]);
  assert.ok(stats.overturnRate > 0.3);
  assert.ok(stats.findings.some((f) => /about our quality control/.test(f)));
});

test('a high split rate is reported as a finding about OUR specifications', () => {
  const stats = A.disputeStats([ledgerWithOutcomes(['split', 'split', 'upheld', 'split'])]);
  assert.ok(stats.specDefectRate > 0.25);
  assert.ok(stats.findings.some((f) => /Our specifications are the problem/.test(f)));
});

test('rates stay null until there is enough to read', () => {
  const stats = A.disputeStats([ledgerWithOutcomes(['overturned'])]);
  assert.equal(stats.overturnRate, null);
  assert.equal(stats.specDefectRate, null);
  assert.deepEqual(stats.findings, []);
});

test('withdrawals are excluded from the rate denominators', () => {
  const stats = A.disputeStats([ledgerWithOutcomes(['withdrawn', 'withdrawn', 'upheld', 'upheld', 'upheld'])]);
  assert.equal(stats.overturnRate, 0);
  assert.equal(stats.decided, 5);
});

test('an overdue open dispute is surfaced as a finding', () => {
  const l = L.openLedger(CEDAR);
  l.disputes = [dispute({ at: new Date(Date.now() - 30 * 86400000) })];
  const stats = A.disputeStats([l]);
  assert.equal(stats.overdue, 1);
  assert.ok(stats.findings.some((f) => /a refusal to pay/.test(f)));
});

test('an empty set of ledgers produces no findings and no false rates', () => {
  const stats = A.disputeStats([]);
  assert.equal(stats.total, 0);
  assert.equal(stats.overturnRate, null);
  assert.deepEqual(stats.findings, []);
});

test('a contractor who wins disputes is not penalised for raising them', () => {
  const record = A.contractorDisputeRecord('dev-mira', [ledgerWithOutcomes(['overturned', 'overturned', 'split', 'upheld'])]);
  assert.equal(record.disputesRaised, 4);
  assert.equal(record.wonOutright, 2);
  assert.equal(record.ourSpecFault, 1);
  // Only an upheld ruling says anything negative about their work.
  assert.equal(record.substantiveLosses, 1);
});

test('every outcome carries a plain-language meaning', () => {
  for (const [outcome, meaning] of Object.entries(A.OUTCOMES)) {
    assert.ok(meaning.length > 20, `${outcome} needs a usable explanation`);
  }
});
