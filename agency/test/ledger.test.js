const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { planEngagement } = require('../src/engagement');
const qc = require('../src/qc');
const L = require('../src/ledger');

const EXAMPLES = path.join(__dirname, '..', 'examples');
function example(name) {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLES, `${name}.json`), 'utf8'));
}
const CEDAR = planEngagement(example('cedar-roofing'));

function passAll(milestone) {
  const c = qc.newChecklist(milestone.id);
  for (const item of qc.BLOCKING_ITEMS) {
    if (item.id === 'acceptance-tests') continue;
    qc.record(c, item.id, true);
  }
  c.reviewedBy = 'owner';
  const results = {};
  for (const t of milestone.acceptanceTests) results[t.id] = true;
  return qc.evaluateMilestone(milestone, c, results);
}

function wonLedger(engagement = CEDAR) {
  const l = L.openLedger(engagement);
  L.recordProposalSent(l);
  L.recordReceipt(l, { amount: engagement.economics.depositAmount, kind: 'deposit' });
  L.transition(l, 'won');
  return l;
}

function deliveringLedger(engagement = CEDAR) {
  const l = wonLedger(engagement);
  L.transition(l, 'in_delivery');
  return l;
}

test('a ledger opens from a planned engagement and freezes the quote', () => {
  const l = L.openLedger(CEDAR);
  assert.equal(l.state, 'qualified');
  assert.equal(l.clientRef, 'cedar-roofing');
  assert.equal(l.planned.projectPrice, CEDAR.economics.projectPrice);
  assert.equal(l.planned.developerCost, CEDAR.economics.developerCost);
  assert.equal(l.milestones.length, CEDAR.deliveryPlan.milestones.length);
  assert.ok(l.milestones.every((m) => m.accepted === false && m.paid === false));
});

test('a disqualified engagement opens as a terminal record, not a live deal', () => {
  const l = L.openLedger(planEngagement(example('corner-cafe')));
  assert.equal(l.state, 'disqualified');
  assert.equal(l.planned, null);
  assert.deepEqual(l.milestones, []);
});

test('opening requires a planned engagement', () => {
  assert.throws(() => L.openLedger(null), TypeError);
  assert.throws(() => L.openLedger({}), TypeError);
});

test('an illegal transition is refused', () => {
  const l = L.openLedger(CEDAR);
  assert.throws(() => L.transition(l, 'delivered'), /Illegal transition qualified → delivered/);
  assert.throws(() => L.transition(l, 'in_delivery'), /Illegal transition/);
  assert.throws(() => L.transition(l, 'nonsense'), /Unknown state/);
});

test('a dead engagement cannot be revived', () => {
  const l = L.openLedger(CEDAR);
  L.transition(l, 'lost');
  assert.throws(() => L.transition(l, 'proposed'), /terminal/);
  assert.throws(() => L.recordReceipt(l, { amount: 100 }), /is lost/);
  assert.throws(() => L.recordReceipt(l, { amount: 100, kind: 'retainer' }), /is lost/);
  assert.throws(() => L.recordOpsSpend(l, { amount: 100 }), /is lost/);
});

test('a closed engagement still accepts retainer money — that is the point of a retainer', () => {
  const l = L.openLedger(CEDAR);
  L.recordProposalSent(l);
  L.recordReceipt(l, { amount: CEDAR.economics.depositAmount, kind: 'deposit' });
  L.transition(l, 'won');
  L.transition(l, 'in_delivery');
  for (const m of CEDAR.deliveryPlan.milestones) {
    L.acceptMilestone(l, passAll(m));
    if (m.developerPayout > 0) L.releasePayment(l, { milestoneId: m.id });
    if (m.triggersClientBalance) L.recordReceipt(l, { amount: CEDAR.economics.balanceAmount, kind: 'balance' });
  }
  L.transition(l, 'delivered');
  L.transition(l, 'closed');

  // Months of retainer keep arriving after the build is settled.
  assert.doesNotThrow(() => L.recordReceipt(l, { amount: 2000, kind: 'retainer' }));
  assert.doesNotThrow(() => L.recordReceipt(l, { amount: 2000, kind: 'retainer' }));
  assert.equal(L.economics(l).retainerReceived, 4000);
  // Ongoing hosting still costs money.
  assert.doesNotThrow(() => L.recordOpsSpend(l, { amount: 80, description: 'hosting' }));
  // But the build is settled — a late deposit is a bookkeeping error.
  assert.throws(() => L.recordReceipt(l, { amount: 500, kind: 'deposit' }), /build is settled/);
});

test('won is refused until the full deposit is recorded', () => {
  const l = L.openLedger(CEDAR);
  L.recordProposalSent(l);
  assert.throws(() => L.transition(l, 'won'), /Record the full deposit first/);
  L.recordReceipt(l, { amount: CEDAR.economics.depositAmount - 100, kind: 'deposit' });
  assert.throws(() => L.transition(l, 'won'), /Record the full deposit first/);
  L.recordReceipt(l, { amount: 100, kind: 'deposit' });
  assert.doesNotThrow(() => L.transition(l, 'won'));
});

test('a receipt must be a positive amount of a known kind', () => {
  const l = L.openLedger(CEDAR);
  assert.throws(() => L.recordReceipt(l, { amount: 0 }), TypeError);
  assert.throws(() => L.recordReceipt(l, { amount: -500 }), TypeError);
  assert.throws(() => L.recordReceipt(l, { amount: 100, kind: 'cash-in-hand' }), /Unknown receipt kind/);
});

test('a milestone cannot be accepted outside delivery', () => {
  const l = wonLedger();
  assert.throws(() => L.acceptMilestone(l, passAll(CEDAR.deliveryPlan.milestones[0])), /Move to in_delivery first/);
});

test('a milestone with quality control open cannot be accepted', () => {
  const l = deliveringLedger();
  const milestone = CEDAR.deliveryPlan.milestones[1];
  const failing = qc.evaluateMilestone(milestone, qc.newChecklist(milestone.id), {});
  assert.throws(() => L.acceptMilestone(l, failing), /blocking item/);
  assert.equal(l.milestones.find((m) => m.id === milestone.id).accepted, false);
});

test('acceptance requires a real QC evaluation, not a hand-written flag', () => {
  const l = deliveringLedger();
  // The exact bypass this guards: a valid milestone id plus accepted: true.
  assert.throws(
    () => L.acceptMilestone(l, { milestoneId: 'lead-capture', accepted: true }),
    /must come from qc.evaluateMilestone/,
  );
  // A stamped-but-inconsistent evaluation is also refused.
  assert.throws(
    () => L.acceptMilestone(l, { gate: 'qc.evaluateMilestone', milestoneId: 'lead-capture', accepted: true, openItems: [{ id: 'code-review' }] }),
    /blocking item/,
  );
  // A passing evaluation with nobody signing it off is refused.
  assert.throws(
    () => L.acceptMilestone(l, { gate: 'qc.evaluateMilestone', milestoneId: 'lead-capture', accepted: true, openItems: [], reviewedBy: null }),
    /no reviewer named/,
  );
  assert.throws(() => L.acceptMilestone(l, null), TypeError);
  assert.equal(l.milestones.find((m) => m.id === 'lead-capture').accepted, false);
});

test('a milestone cannot be accepted twice', () => {
  const l = deliveringLedger();
  const evaluation = passAll(CEDAR.deliveryPlan.milestones[1]);
  L.acceptMilestone(l, evaluation);
  assert.throws(() => L.acceptMilestone(l, evaluation), /already accepted/);
});

test('a genuinely accepted milestone from another engagement is still refused', () => {
  const l = deliveringLedger();
  // A real, fully-passing QC evaluation — for a milestone this engagement does
  // not contain. Authenticity is not the same as belonging.
  const foreign = { id: 'not-ours', developerPayout: 100, acceptanceTests: [] };
  const evaluation = passAll(foreign);
  assert.equal(evaluation.accepted, true);
  assert.throws(() => L.acceptMilestone(l, evaluation), /not part of/);
});

test('payment is refused until the milestone is accepted', () => {
  const l = deliveringLedger();
  assert.throws(() => L.releasePayment(l, { milestoneId: 'lead-capture' }), /Quality control gates payment/);
  assert.equal(L.totalPayments(l), 0);
});

test('payment defaults to the planned payout and records variance', () => {
  const l = deliveringLedger();
  const milestone = CEDAR.deliveryPlan.milestones[1];
  L.acceptMilestone(l, passAll(milestone));
  L.releasePayment(l, { milestoneId: milestone.id, contractorId: 'dev-001' });
  const payment = l.payments[0];
  assert.equal(payment.amount, milestone.developerPayout);
  assert.equal(payment.variance, 0);

  const l2 = deliveringLedger();
  L.acceptMilestone(l2, passAll(milestone));
  L.releasePayment(l2, { milestoneId: milestone.id, amount: milestone.developerPayout + 300 });
  assert.equal(l2.payments[0].variance, 300);
});

test('a milestone cannot be paid twice', () => {
  const l = deliveringLedger();
  const milestone = CEDAR.deliveryPlan.milestones[1];
  L.acceptMilestone(l, passAll(milestone));
  L.releasePayment(l, { milestoneId: milestone.id });
  assert.throws(() => L.releasePayment(l, { milestoneId: milestone.id }), /already paid/);
});

test('delivery is refused while any milestone is open', () => {
  const l = deliveringLedger();
  L.acceptMilestone(l, passAll(CEDAR.deliveryPlan.milestones[0]));
  assert.throws(() => L.transition(l, 'delivered'), /not accepted/);
});

test('delivery is refused while the client still owes money', () => {
  const l = deliveringLedger();
  for (const m of CEDAR.deliveryPlan.milestones) L.acceptMilestone(l, passAll(m));
  assert.throws(() => L.transition(l, 'delivered'), /still outstanding/);
  L.recordReceipt(l, { amount: CEDAR.economics.balanceAmount, kind: 'balance' });
  assert.doesNotThrow(() => L.transition(l, 'delivered'));
});

test('our own zero-payout milestone never shows as accepted-but-unpaid', () => {
  const l = deliveringLedger();
  const discovery = CEDAR.deliveryPlan.milestones.find((m) => m.developerPayout === 0);
  assert.ok(discovery, 'fixture must contain an agency-owned milestone');
  L.acceptMilestone(l, passAll(discovery));
  assert.deepEqual(L.economics(l).unpaidAcceptedMilestones, []);
});

test('an accepted contractor milestone does show as unpaid until settled', () => {
  const l = deliveringLedger();
  const milestone = CEDAR.deliveryPlan.milestones[1];
  L.acceptMilestone(l, passAll(milestone));
  assert.deepEqual(L.economics(l).unpaidAcceptedMilestones, [milestone.id]);
  L.releasePayment(l, { milestoneId: milestone.id });
  assert.deepEqual(L.economics(l).unpaidAcceptedMilestones, []);
});

test('profit is not reported as final mid-build', () => {
  const l = wonLedger();
  const e = L.economics(l);
  assert.equal(e.profitIsFinal, false);
  // The deposit alone reads as a 100% margin, which is why the flag exists.
  assert.equal(e.grossMarginPct, 100);
  assert.equal(e.cashPosition, CEDAR.economics.depositAmount);
});

test('a full lifecycle reconciles cash, profit and variance', () => {
  const l = deliveringLedger();
  for (const m of CEDAR.deliveryPlan.milestones) {
    L.acceptMilestone(l, passAll(m));
    if (m.developerPayout > 0) {
      const actual = m.id === 'follow-up' ? m.developerPayout + 250 : m.developerPayout;
      L.releasePayment(l, { milestoneId: m.id, amount: actual });
    }
    if (m.triggersClientBalance) L.recordReceipt(l, { amount: CEDAR.economics.balanceAmount, kind: 'balance' });
  }
  L.recordOpsSpend(l, { amount: 1540, description: 'hosting' });
  L.transition(l, 'delivered');

  const e = L.economics(l);
  assert.equal(e.profitIsFinal, true);
  assert.equal(e.buildReceived, CEDAR.economics.projectPrice);
  assert.equal(e.developerPaid, CEDAR.economics.developerCost + 250);
  assert.equal(e.grossProfit, CEDAR.economics.projectPrice - (CEDAR.economics.developerCost + 250) - 1540);
  assert.equal(e.cashPosition, e.received - e.developerPaid - e.opsSpent);
  assert.equal(e.variance.developerCost, 250);
  assert.equal(e.variance.final, true);
  assert.equal(e.outstandingFromClient, 0);
});

test('retainer receipts are excluded from build margin', () => {
  const l = deliveringLedger();
  L.recordReceipt(l, { amount: 2000, kind: 'retainer' });
  const e = L.economics(l);
  assert.equal(e.retainerReceived, 2000);
  assert.equal(e.buildReceived, CEDAR.economics.depositAmount);
  assert.equal(e.received, CEDAR.economics.depositAmount + 2000);
});

test('ops spend must be positive', () => {
  const l = L.openLedger(CEDAR);
  assert.throws(() => L.recordOpsSpend(l, { amount: 0 }), TypeError);
});

test('history records every transition in order', () => {
  const l = deliveringLedger();
  const states = l.history.map((h) => h.to);
  assert.deepEqual(states, ['qualified', 'proposed', 'won', 'in_delivery']);
});

test('nextAction names a concrete next step in every state', () => {
  const l = L.openLedger(CEDAR);
  assert.match(L.nextAction(l), /Send the proposal/);
  L.recordProposalSent(l);
  assert.match(L.nextAction(l), /deposit/);
  L.recordReceipt(l, { amount: CEDAR.economics.depositAmount, kind: 'deposit' });
  L.transition(l, 'won');
  assert.match(L.nextAction(l), /papered contractors/);
  L.transition(l, 'in_delivery');
  assert.match(L.nextAction(l), /quality control/);
  const milestone = CEDAR.deliveryPlan.milestones[1];
  L.acceptMilestone(l, passAll(milestone));
  assert.match(L.nextAction(l), /Release payment/);
});

test('an invalid timestamp is rejected rather than silently becoming now', () => {
  assert.throws(() => L.openLedger(CEDAR, { at: 'not-a-date' }), TypeError);
});

// ---- assignments ----

const { assignTicket } = require('../src/contractor');

const PAPERED = {
  id: 'dev-001',
  agreements: Object.fromEntries(
    ['nda', 'ip-assignment', 'non-solicit', 'independent-contractor'].map((i) => [i, { signedAt: '2026-01-10T00:00:00Z' }]),
  ),
  paymentDetailsOnFile: true,
};

function realAssignment(ticket = CEDAR.deliveryPlan.tickets[0], contractor = PAPERED) {
  const a = assignTicket(ticket, contractor);
  a.milestoneId = ticket.milestoneId;
  return a;
}

test('an assignment from the real gate is recorded', () => {
  const l = deliveringLedger();
  const ticket = CEDAR.deliveryPlan.tickets[0];
  L.recordAssignment(l, realAssignment(ticket));
  assert.equal(l.assignments.length, 1);
  assert.equal(l.assignments[0].ticketId, ticket.id);
  assert.equal(l.assignments[0].contractorId, 'dev-001');
  assert.equal(l.assignments[0].releasedAt, null);
});

test('a hand-built assignment that skipped the paperwork gate is refused', () => {
  const l = deliveringLedger();
  assert.throws(
    () => L.recordAssignment(l, { ticketId: 't1', contractorId: 'dev-001', fixedPrice: 500 }),
    /did not come from contractor.assignTicket/,
  );
  assert.throws(() => L.recordAssignment(l, { ticketId: 't1' }), TypeError);
  assert.equal(l.assignments.length, 0);
});

test('an unpapered contractor cannot produce an assignment at all', () => {
  const ticket = CEDAR.deliveryPlan.tickets[0];
  assert.throws(() => assignTicket(ticket, { id: 'dev-nope' }), /Cannot assign/);
});

test('a ticket cannot be held by two contractors at once', () => {
  const l = deliveringLedger();
  const ticket = CEDAR.deliveryPlan.tickets[0];
  L.recordAssignment(l, realAssignment(ticket));
  assert.throws(() => L.recordAssignment(l, realAssignment(ticket, { ...PAPERED, id: 'dev-002' })), /already assigned to dev-001/);
});

test('a released ticket can be reassigned', () => {
  const l = deliveringLedger();
  const ticket = CEDAR.deliveryPlan.tickets[0];
  L.recordAssignment(l, realAssignment(ticket));
  L.releaseAssignment(l, { ticketId: ticket.id, outcome: 'reassigned' });
  assert.doesNotThrow(() => L.recordAssignment(l, realAssignment(ticket, { ...PAPERED, id: 'dev-002' })));
  assert.equal(L.openAssignments(l).length, 1);
  assert.equal(L.openAssignments(l)[0].contractorId, 'dev-002');
});

test('releasing an unknown or already-released ticket is refused', () => {
  const l = deliveringLedger();
  const ticket = CEDAR.deliveryPlan.tickets[0];
  assert.throws(() => L.releaseAssignment(l, { ticketId: ticket.id }), /No open assignment/);
  L.recordAssignment(l, realAssignment(ticket));
  L.releaseAssignment(l, { ticketId: ticket.id });
  assert.throws(() => L.releaseAssignment(l, { ticketId: ticket.id }), /No open assignment/);
});

test('an unknown outcome is refused rather than recorded as a mystery', () => {
  const l = deliveringLedger();
  const ticket = CEDAR.deliveryPlan.tickets[0];
  L.recordAssignment(l, realAssignment(ticket));
  assert.throws(() => L.releaseAssignment(l, { ticketId: ticket.id, outcome: 'fine-i-guess' }), /Unknown assignment outcome/);
});

test('openAssignments filters to one contractor', () => {
  const l = deliveringLedger();
  L.recordAssignment(l, realAssignment(CEDAR.deliveryPlan.tickets[0]));
  L.recordAssignment(l, realAssignment(CEDAR.deliveryPlan.tickets[1], { ...PAPERED, id: 'dev-002' }));
  assert.equal(L.openAssignments(l).length, 2);
  assert.equal(L.openAssignments(l, 'dev-001').length, 1);
  assert.equal(L.openAssignments(l, 'nobody').length, 0);
});

test('a final assignment can be released after the build closes', () => {
  const l = deliveringLedger();
  const ticket = CEDAR.deliveryPlan.tickets[0];
  L.recordAssignment(l, realAssignment(ticket));
  for (const m of CEDAR.deliveryPlan.milestones) {
    L.acceptMilestone(l, passAll(m));
    if (m.developerPayout > 0) L.releasePayment(l, { milestoneId: m.id });
    if (m.triggersClientBalance) L.recordReceipt(l, { amount: CEDAR.economics.balanceAmount, kind: 'balance' });
  }
  L.transition(l, 'delivered');
  L.transition(l, 'closed');
  assert.doesNotThrow(() => L.releaseAssignment(l, { ticketId: ticket.id, outcome: 'completed' }));
});

test('a ledger written before assignments existed still works', () => {
  // Exactly what a ledger from an earlier version looks like on disk.
  const legacy = { clientRef: 'old', clientName: 'Old', state: 'in_delivery', planned: null };
  const normalized = L.normalize(legacy);
  assert.deepEqual(normalized.assignments, []);
  assert.deepEqual(normalized.receipts, []);
  assert.deepEqual(normalized.payments, []);
  assert.deepEqual(normalized.opsSpend, []);
  assert.doesNotThrow(() => L.openAssignments(normalized));
});

test('normalize leaves a current ledger untouched', () => {
  const l = deliveringLedger();
  L.recordAssignment(l, realAssignment(CEDAR.deliveryPlan.tickets[0]));
  const before = JSON.stringify(l);
  assert.equal(JSON.stringify(L.normalize(l)), before);
});
