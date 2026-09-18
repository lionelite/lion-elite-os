'use strict';

// The coordination loop (Issue #73).
//
// #73's definition of done is specific: "The daily executive brief does not
// merely say the target. It triggers agent jobs, records their actions and
// outcomes, measures the revenue gap during the day, and automatically redirects
// agent effort toward the highest-impact eligible opportunities until the target
// is met or available opportunities are exhausted."
//
// So this module produces ASSIGNMENTS, not prose. Each assignment names the
// agent, the action it should dispatch, why it was chosen, and the gate that
// would stop it. The executive re-plans at each checkpoint against the real gap.
//
// THE HONEST PART, and the reason this is useful rather than theatre: most of
// what these agents would most like to do is gated off. Sending e-mail needs
// `OUTREACH_SEND_ENABLED`. Publishing needs `SOCIAL_PUBLISH_ENABLED`. Those
// switches belong to the owner and this module never flips them, never routes
// around them, and never pretends work happened. A blocked assignment is
// returned as `blocked`, naming the control and what a human would have to do.
// An agent roster that reported "outreach sent" while the kill switch was on
// would be worse than no roster at all.
//
// Pure and deterministic: it takes the day's numbers as input and returns a
// plan. Dispatching the plan is the caller's job, through the existing
// allowlisted dispatcher.

const { ROLES, role, CHECKPOINTS, CONTROLS, DAILY_REVENUE_TARGET, DAILY_REVENUE_STRETCH } = require('./roles');
const { ALLOWED_QUEUE_ACTIONS } = require('../action-catalog');

// Which env var actually governs each control, so a blocked assignment can tell
// a human precisely what is off. `HUMAN_APPROVAL` has no variable by design.
const CONTROL_ENV = Object.freeze({
  OUTREACH_SEND_ENABLED: 'OUTREACH_SEND_ENABLED',
  SMS_SEND_ENABLED: 'SMS_SEND_ENABLED',
  SOCIAL_PUBLISH_ENABLED: 'SOCIAL_PUBLISH_ENABLED',
  BLUESKY_OUTREACH_ENABLED: 'BLUESKY_OUTREACH_ENABLED',
  AD_SPEND_CAP: 'AD_DAILY_SPEND_CAP',
  HUMAN_APPROVAL: null,
});

// Expected revenue impact per action, used only to order the work. Rough by
// necessity — the point is that assignment is driven by expected impact rather
// than by which agent is easiest to run, and these weights get corrected by
// recorded outcomes over time.
const IMPACT_WEIGHTS = Object.freeze({
  'qualify-prospect': 5,
  'draft-outreach': 5,
  'research-prospect': 3,
  'enrich-prospect': 3,
  'discover-prospects': 2,
  'validate-outreach': 2,
  'generate-social-content': 2,
  'midday-revenue-check': 1,
  'business-health-snapshot': 1,
  'morning-brief': 1,
  'evening-review': 1,
  'create-github-issue': 1,
});

function controlEnabled(control, env = process.env) {
  const variable = CONTROL_ENV[control];
  // A control with no env var is a human decision, never auto-satisfied.
  if (!variable) return false;
  if (control === 'AD_SPEND_CAP') {
    const cap = Number(env[variable]);
    return Number.isFinite(cap) && cap > 0;
  }
  return String(env[variable] || '').toLowerCase() === 'true';
}

function round(n, places = 2) {
  const f = 10 ** places;
  return Math.round((Number(n) || 0) * f) / f;
}

/**
 * Where we stand against today's number.
 *
 * `pace` compares collected revenue to where we should be by this hour of the
 * working day, because "we are at 40% of target" means something very different
 * at 10am than at 5pm.
 */
function revenueGap({ collectedToday = 0, target = DAILY_REVENUE_TARGET, stretch = DAILY_REVENUE_STRETCH, hour = new Date().getHours() } = {}) {
  const collected = Number(collectedToday) || 0;
  const gap = Math.max(round(target - collected), 0);

  // Working day 8am–8pm; outside it, expected progress clamps to the ends.
  const dayStart = 8;
  const dayEnd = 20;
  const elapsed = Math.min(Math.max(hour - dayStart, 0), dayEnd - dayStart);
  const expectedFraction = (dayEnd - dayStart) > 0 ? elapsed / (dayEnd - dayStart) : 1;
  const expectedByNow = round(target * expectedFraction);
  const behindBy = round(Math.max(expectedByNow - collected, 0));

  return {
    target,
    stretch,
    collectedToday: round(collected),
    gap,
    attainmentPct: target > 0 ? round((collected / target) * 100, 1) : 0,
    expectedByNow,
    behindBy,
    behindPace: behindBy > 0,
    targetMet: collected >= target,
    stretchMet: collected >= stretch,
    hour,
  };
}

/**
 * Build one agent's assignment for an action.
 *
 * Every assignment records the gate. If the gate is closed the assignment comes
 * back `blocked` with the remedy, and it is never silently dropped — a plan that
 * hides its blocked work is a plan that looks like progress.
 */
function assignmentFor(roleId, action, { reason, env = process.env } = {}) {
  const definition = role(roleId);
  if (!definition) throw new Error(`Unknown role "${roleId}".`);
  if (!definition.actions.includes(action)) {
    throw new Error(`Role ${roleId} may not perform "${action}". Add it to the registry if that is intended.`);
  }

  // A role's gates apply to its outward-facing follow-through, not to the
  // allowlisted queue job itself — drafting is always safe, sending is not.
  // The assignment carries them so the executive can see where the day's work
  // stops being autonomous.
  const closedGates = definition.gates.filter((g) => !controlEnabled(g, env));

  return {
    roleId,
    title: definition.title,
    action,
    queue: ALLOWED_QUEUE_ACTIONS[action].queue,
    job: ALLOWED_QUEUE_ACTIONS[action].job,
    impact: IMPACT_WEIGHTS[action] || 1,
    reason,
    // The queue job may run; the downstream send may not.
    dispatchable: true,
    blockedFollowThrough: closedGates.map((g) => ({
      control: g,
      envVar: CONTROL_ENV[g],
      meaning: CONTROLS[g],
      remedy: CONTROL_ENV[g]
        ? `A human sets ${CONTROL_ENV[g]} in the Render dashboard. Claude does not flip it.`
        : 'A person makes this call.',
    })),
    status: 'planned',
  };
}

/**
 * Plan a checkpoint.
 *
 * Returns the checkpoint's own executive action plus the downstream agent work,
 * ordered by expected impact. When behind pace, revenue-moving roles are
 * prioritised and the plan says so; when the target is met, it stops assigning
 * new revenue work rather than manufacturing busywork.
 */
function planCheckpoint(checkpointId, { collectedToday = 0, hour, env = process.env, target, stretch } = {}) {
  const checkpoint = CHECKPOINTS.find((c) => c.id === checkpointId);
  if (!checkpoint) throw new Error(`Unknown checkpoint "${checkpointId}". Expected one of ${CHECKPOINTS.map((c) => c.id).join(', ')}.`);

  const gap = revenueGap({ collectedToday, hour: hour === undefined ? undefined : hour, target, stretch });
  const assignments = [];

  // The executive's own checkpoint job always runs — it is how the numbers get
  // refreshed, so skipping it when behind would be self-defeating.
  assignments.push(assignmentFor('executive', checkpoint.action, {
    reason: checkpoint.establishes,
    env,
  }));

  const revenueRoles = ['sales', 'client-success'];
  const supportRoles = ['marketing', 'finance-kpi', 'operations'];

  if (gap.targetMet) {
    // Target met: verify and protect, do not push more outreach. Pushing volume
    // after the number is hit is how a good day becomes a compliance incident.
    for (const id of ['finance-kpi', 'operations']) {
      const r = role(id);
      assignments.push(assignmentFor(id, r.actions[0], {
        reason: `Target met ($${gap.collectedToday} of $${gap.target}). Confirm the number is real and nothing is stuck.`,
        env,
      }));
    }
  } else {
    const urgency = gap.behindPace
      ? `Behind pace by $${gap.behindBy} at ${gap.hour}:00 — $${gap.gap} still needed.`
      : `On pace; $${gap.gap} remaining to target.`;

    for (const id of revenueRoles) {
      const r = role(id);
      for (const action of r.actions) {
        if ((IMPACT_WEIGHTS[action] || 1) < 3) continue; // only the moving work
        assignments.push(assignmentFor(id, action, { reason: urgency, env }));
      }
    }
    for (const id of supportRoles) {
      const r = role(id);
      const action = r.actions.find((a) => (IMPACT_WEIGHTS[a] || 1) >= 2) || r.actions[0];
      assignments.push(assignmentFor(id, action, {
        reason: gap.behindPace ? 'Supporting work — keep it from competing with revenue work today.' : 'Routine cadence.',
        env,
      }));
    }
  }

  // Compliance always gets a slot when any customer-facing copy is in play. It
  // has a veto, so it must run before drafts go anywhere, not after.
  const copyInPlay = assignments.some((a) => a.action === 'draft-outreach' || a.action === 'generate-social-content');
  if (copyInPlay) {
    assignments.push(assignmentFor('research-compliance', 'validate-outreach', {
      reason: 'Customer-facing copy is in today\'s plan. RUO review gates it before anything leaves.',
      env,
    }));
  }

  const ordered = assignments.sort((a, b) => b.impact - a.impact);
  const blocked = ordered.filter((a) => a.blockedFollowThrough.length > 0);

  return {
    checkpoint: checkpoint.id,
    establishes: checkpoint.establishes,
    gap,
    assignments: ordered,
    assignmentCount: ordered.length,
    blockedFollowThrough: blocked.length,
    // Surfaced at the top because it is the difference between "the system is
    // working" and "the system is drafting into a drawer".
    gatesClosed: [...new Set(blocked.flatMap((a) => a.blockedFollowThrough.map((g) => g.control)))],
    summary: gap.targetMet
      ? `${checkpoint.id}: target met ($${gap.collectedToday}/$${gap.target}). ${ordered.length} verification assignment(s).`
      : `${checkpoint.id}: $${gap.gap} to target${gap.behindPace ? `, behind pace by $${gap.behindBy}` : ', on pace'}. ${ordered.length} assignment(s), ${blocked.length} with gated follow-through.`,
  };
}

/** Plan the whole day — all four checkpoints against the numbers known so far. */
function planDay({ collectedByCheckpoint = {}, env = process.env, target, stretch } = {}) {
  const hours = { morning: 9, midday: 13, afternoon: 16, evening: 19 };
  return CHECKPOINTS.map((c) => planCheckpoint(c.id, {
    collectedToday: collectedByCheckpoint[c.id] || 0,
    hour: hours[c.id],
    env,
    target,
    stretch,
  }));
}

/**
 * Record what an assignment actually did.
 *
 * `outcome` distinguishes work that ran from work that was blocked, because the
 * IMPACT_WEIGHTS above are only guesses until outcomes correct them — and
 * because an agent roster whose failures are invisible cannot be improved.
 */
function recordOutcome(assignment, { outcome, detail, revenueAttributed = 0, at = new Date() } = {}) {
  if (!['dispatched', 'completed', 'blocked', 'failed', 'skipped'].includes(outcome)) {
    throw new Error(`Unknown assignment outcome "${outcome}".`);
  }
  return {
    ...assignment,
    status: outcome,
    detail: detail || null,
    revenueAttributed: round(revenueAttributed),
    recordedAt: (at instanceof Date ? at : new Date(at)).toISOString(),
  };
}

/** Roll up a day's recorded outcomes. */
function dayReport(outcomes = [], { target = DAILY_REVENUE_TARGET } = {}) {
  const byStatus = outcomes.reduce((acc, o) => {
    acc[o.status] = (acc[o.status] || 0) + 1;
    return acc;
  }, {});
  const attributed = round(outcomes.reduce((sum, o) => sum + (o.revenueAttributed || 0), 0));
  const blockedControls = [...new Set(outcomes
    .filter((o) => o.status === 'blocked')
    .flatMap((o) => (o.blockedFollowThrough || []).map((g) => g.control)))];

  return {
    assignments: outcomes.length,
    byStatus,
    revenueAttributed: attributed,
    target,
    attainmentPct: target > 0 ? round((attributed / target) * 100, 1) : 0,
    blockedControls,
    // The honest headline. If every assignment was blocked, say that plainly.
    verdict: outcomes.length === 0
      ? 'No assignments recorded — the loop did not run.'
      : (byStatus.blocked === outcomes.length
        ? `Every assignment was blocked (${blockedControls.join(', ')}). The agents produced no outward effect today; a human has to open a gate.`
        : `${byStatus.completed || 0} completed, ${byStatus.blocked || 0} blocked, $${attributed} attributed against a $${target} target.`),
  };
}

module.exports = {
  CONTROL_ENV,
  IMPACT_WEIGHTS,
  controlEnabled,
  revenueGap,
  assignmentFor,
  planCheckpoint,
  planDay,
  recordOutcome,
  dayReport,
  ROLES,
};
