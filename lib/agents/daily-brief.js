'use strict';

// The daily agent brief: turns the real numbers from brief-metrics.js into the
// day's work for all three lanes (Wellness, Beauty & Coaching, BuildPipeline).
//
// Pure and deterministic: no database, no network, no model call. The same
// metrics always give the same brief, so a change in the brief is a change in
// the business, not in a prompt.
//
// Each action names the agent role that owns it (lib/agents/roles.js) and WHO
// has to act:
//   owner  - a decision or a gate only the owner can open (sends, spend, hosting)
//   claude - an engineering fix Claude can make through a PR
//   agent  - the system already does this on its own; listed so progress is visible
//
// Honesty rules, same as the rest of lib/agents/:
//   - a metric whose query failed shows "no data", never 0;
//   - nothing claims a result that the data does not show;
//   - nothing here sends, publishes, spends or flips a control.

const { DAILY_REVENUE_TARGET, ROLES } = require('./roles');

const ROLE_IDS = new Set(ROLES.map(r => r.id));
const LANES = Object.freeze([
  { id: 'wellness', name: 'Lion Elite Wellness', map: 'knowledge/maps/Lion Elite Wellness' },
  { id: 'beauty', name: 'Lion Elite Beauty & Coaching', map: 'knowledge/maps/Lion Elite Beauty & Coaching' },
  { id: 'buildpipeline', name: 'BuildPipeline', map: 'knowledge/maps/BuildPipeline & Agency' },
]);
const DISCOVERY_RUNS_PER_DAY = 12; // clinic-discovery.yml: every 2 hours
const SEND_JOB = 'clinic-outreach-send';

const ok = m => Boolean(m && !m.error && Array.isArray(m.rows));
const first = m => (ok(m) ? m.rows[0] || {} : null);
const money = n => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function nyDate(now) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
function nyLongDate(now) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(now);
}
function shiftDay(ymd, days) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DEFERRAL = /next run|today's cap/i; // held back for a later run, not rejected

function skipSummary(runs) {
  const blocking = {};
  const deferred = {};
  for (const run of runs) {
    for (const [reason, n] of Object.entries(run.skip_reasons || {})) {
      const bucket = DEFERRAL.test(reason) ? deferred : blocking;
      bucket[reason] = Math.max(bucket[reason] || 0, Number(n) || 0); // runs re-evaluate the same prospects; max, not sum
    }
  }
  const top = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]);
  return { blocking: top(blocking), deferred: top(deferred) };
}

function laneOfLead(lane) {
  const l = String(lane || '').toLowerCase();
  if (/beauty|coach|transform/.test(l)) return 'beauty';
  if (/pipeline|agency|lionos|gtm/.test(l)) return 'buildpipeline';
  if (/wellness|research|peptide|clinic/.test(l)) return 'wellness';
  return 'unknown';
}

/** Derive the numbers each lane is judged on. */
function derive(metrics, { now = new Date(), dailyCap = null } = {}) {
  const today = nyDate(now);
  const yesterday = shiftDay(today, -1);
  const d = { today, yesterday, dailyCap };

  // Wellness: clinic pipeline
  d.clinic = ok(metrics.clinicFunnel)
    ? Object.fromEntries(metrics.clinicFunnel.rows.map(r => [r.stage, Number(r.n) || 0]))
    : null;
  if (d.clinic) d.clinic.total = Object.values(d.clinic).reduce((a, b) => a + b, 0);
  const replies = first(metrics.clinicReplies);
  d.clinicReplies = replies ? { total: Number(replies.total) || 0, last7: Number(replies.last7) || 0 } : null;
  if (ok(metrics.sendsByDay)) {
    const byDay = Object.fromEntries(metrics.sendsByDay.rows.map(r => [r.day, Number(r.sent) || 0]));
    d.sentYesterday = byDay[yesterday] || 0;
    d.sentToday = byDay[today] || 0;
    d.sent7 = Object.entries(byDay).filter(([day]) => day >= shiftDay(today, -7) && day < today).reduce((a, [, n]) => a + n, 0);
  } else {
    d.sentYesterday = d.sentToday = d.sent7 = null;
  }
  d.runs = ok(metrics.outreachRuns24h) ? metrics.outreachRuns24h.rows : null;
  d.skips = d.runs ? skipSummary(d.runs) : null;
  d.sendTicks = ok(metrics.schedulerTicks24h)
    ? Number((metrics.schedulerTicks24h.rows.find(r => r.job === SEND_JOB) || {}).ticks || 0)
    : null;
  const disc = first(metrics.discoveryRuns24h);
  d.discovery = disc ? { runs: Number(disc.runs) || 0, stored: Number(disc.stored) || 0, found: Number(disc.found) || 0 } : null;
  const paused = first(metrics.outreachPaused);
  d.paused = paused ? Boolean(paused.value && paused.value.paused) : null;
  d.pausedSince = paused && paused.value ? paused.value.at || null : null;
  const o = first(metrics.storeOrders);
  d.orders = o ? {
    yOrders: Number(o.y_orders) || 0, yRevenue: Number(o.y_revenue) || 0,
    d7Orders: Number(o.d7_orders) || 0, d7Revenue: Number(o.d7_revenue) || 0,
    prev7Orders: Number(o.prev7_orders) || 0, prev7Revenue: Number(o.prev7_revenue) || 0,
    d30Orders: Number(o.d30_orders) || 0, d30Revenue: Number(o.d30_revenue) || 0,
    lastOrderAt: o.last_order_at || null,
  } : null;

  // Beauty & Coaching
  d.coaching = ok(metrics.coachingClients)
    ? Object.fromEntries(metrics.coachingClients.rows.map(r => [r.status || 'unknown', Number(r.n) || 0]))
    : null;
  if (d.coaching) {
    d.coaching.total = Object.values(d.coaching).reduce((a, b) => a + b, 0);
    d.coaching.activeCount = d.coaching.active || 0;
  }
  const ck = first(metrics.coachingCheckins7d);
  d.checkins7 = ck ? Number(ck.n) || 0 : null;
  d.leads = ok(metrics.capturedLeads)
    ? metrics.capturedLeads.rows.reduce((acc, r) => {
      const lane = laneOfLead(r.lane);
      acc[lane] = acc[lane] || { total: 0, last7: 0 };
      acc[lane].total += Number(r.total) || 0;
      acc[lane].last7 += Number(r.last7) || 0;
      return acc;
    }, {})
    : null;

  // BuildPipeline
  const fl = first(metrics.funnelLeads);
  d.funnelLeads = fl ? { total: Number(fl.total) || 0, last7: Number(fl.last7) || 0 } : null;
  const fe = first(metrics.funnelEvents7d);
  d.funnelEvents7 = fe ? Number(fe.n) || 0 : null;
  return d;
}

function action(lane, role, who, priority, title, why) {
  if (!ROLE_IDS.has(role)) throw new Error(`daily-brief: unknown role ${role}`);
  return { lane, role, who, priority, title, why };
}

function wellnessActions(d) {
  const out = [];
  const blockers = [];
  if (d.paused) {
    out.push(action('wellness', 'operations', 'owner', 100, 'Clinic outreach is paused. Resume it or leave it paused on purpose.',
      `Paused since ${d.pausedSince || 'an unknown time'}. Use the outreach-control workflow (resume).`));
  }
  if (d.sendTicks === 0) {
    blockers.push(`The Supabase sender (\`${SEND_JOB}\`) did not tick in the last 24 hours. It runs every 10 minutes, 13:00–20:59 UTC. If this repeats tomorrow, sending has stopped.`);
  }
  if (d.dailyCap && d.sentYesterday !== null && d.sentYesterday < d.dailyCap * 0.5 && !d.paused) {
    const deferred = d.skips && d.skips.deferred[0];
    out.push(action('wellness', 'operations', 'claude', 80, `Raise clinic send throughput: ${d.sentYesterday} sent yesterday against a cap of ${d.dailyCap}.`,
      deferred ? `Largest hold-back: "${deferred[0]}" (${deferred[1]}). Each run stops early, so more runs per day or more sends per run are needed.` : 'Each run is sending far below the cap.'));
  }
  if (d.skips && d.skips.blocking.length) {
    const [reason, n] = d.skips.blocking[0];
    const next = d.skips.blocking.slice(1, 3).map(([r, c]) => `"${r}" (${c})`).join(', ');
    out.push(action('wellness', 'sales', 'claude', 70, `Find out why ${n} clinics fail "${reason}", and fix the data or the rule.`,
      `This is the biggest reason clinics are rejected before a first e-mail.${next ? ` Next: ${next}.` : ''} Any change to a rule is shown to you before it ships.`));
  }
  if (d.clinicReplies && d.clinicReplies.last7 > 0) {
    out.push(action('wellness', 'sales', 'owner', 95, `Answer ${plural(d.clinicReplies.last7, 'clinic')} that replied this week.`,
      'A reply is the highest-value event in the pipeline. Mark each one with outreach-control → record_reply.'));
  } else if (d.clinic && (d.clinic.contacted || 0) >= 100 && d.clinicReplies && d.clinicReplies.total === 0) {
    out.push(action('wellness', 'marketing', 'owner', 75, `0 replies from ${d.clinic.contacted} contacted clinics: approve a new first-touch message to test.`,
      'The current message is not getting answers. Claude drafts a variant, and you approve it by adding its version to OUTREACH_APPROVED_MESSAGE_VERSIONS.'));
  }
  if (d.orders) {
    if (d.orders.d7Orders === 0) {
      out.push(action('wellness', 'marketing', 'owner', 85, 'No store orders in 7 days. Approve a reorder push to past customers.',
        'The consent-gated reorder campaigns exist (e-mail, and SMS with written consent). Turning sends on is your switch.'));
    } else if (d.orders.prev7Revenue > 0 && d.orders.d7Revenue < d.orders.prev7Revenue * 0.8) {
      const drop = Math.round((1 - d.orders.d7Revenue / d.orders.prev7Revenue) * 100);
      out.push(action('wellness', 'marketing', 'owner', 60, `Store revenue is down ${drop}% week over week (${money(d.orders.d7Revenue)} vs ${money(d.orders.prev7Revenue)}).`,
        'Decide on one push this week: a reorder reminder to past buyers, or a product spotlight in the daily social post.'));
    }
  }
  if (d.discovery && d.discovery.runs < DISCOVERY_RUNS_PER_DAY / 2) {
    out.push(action('wellness', 'operations', 'claude', 40, `Clinic discovery ran ${d.discovery.runs} of ${DISCOVERY_RUNS_PER_DAY} scheduled times in 24 hours.`,
      'GitHub drops scheduled runs. Moving discovery to the Supabase scheduler (like sending) makes it reliable.'));
  }
  return { actions: out, blockers };
}

function beautyActions(d) {
  const out = [];
  const leads = d.leads ? (d.leads.beauty || { total: 0, last7: 0 }) : null;
  if (d.coaching && d.coaching.total === 0 && leads && leads.total === 0) {
    out.push(action('beauty', 'client-success', 'claude', 90, 'Connect coaching lead capture: nothing from Lion Elite Beauty reaches the OS yet.',
      '0 coaching clients and 0 captured coaching leads in the database. Until the lionelitebeauty.com application form posts to /api/leads, agents cannot see, count or follow up a single coaching prospect.'));
  }
  if (leads && leads.last7 > 0) {
    out.push(action('beauty', 'sales', 'owner', 92, `Follow up ${plural(leads.last7, 'new coaching lead')} from this week within 24 hours.`,
      'Speed to lead decides high-ticket conversions. Book the consultation call.'));
  }
  if (d.coaching && d.coaching.activeCount > 0 && d.checkins7 === 0) {
    out.push(action('beauty', 'client-success', 'owner', 70, `No check-ins this week from ${plural(d.coaching.activeCount, 'active client')}.`,
      'Silent clients churn. Send each one a personal check-in today.'));
  }
  return { actions: out, blockers: [] };
}

function buildPipelineActions(d) {
  const out = [];
  if (d.funnelEvents7 === 0 && d.funnelLeads && d.funnelLeads.total === 0) {
    out.push(action('buildpipeline', 'executive', 'owner', 88, 'BuildPipeline has no live funnel: 0 visits and 0 applications recorded.',
      'The VSL funnel app is built but not published. Decide where it is hosted (buildpipeline.online currently points at Base44) so traffic and applications land in the OS.'));
  } else if (d.funnelEvents7 > 0 && d.funnelLeads && d.funnelLeads.last7 === 0) {
    out.push(action('buildpipeline', 'marketing', 'claude', 65, `${plural(d.funnelEvents7, 'funnel event')} this week but 0 applications.`,
      'People visit but do not apply. Review the application step for drop-off.'));
  }
  if (d.funnelLeads && d.funnelLeads.last7 > 0) {
    out.push(action('buildpipeline', 'sales', 'owner', 93, `Book calls with ${plural(d.funnelLeads.last7, 'new applicant')}.`,
      'Every application should have a booked call within 48 hours.'));
  }
  return { actions: out, blockers: [] };
}

function na(v, fmt = x => x) { return v === null || v === undefined ? 'no data' : fmt(v); }

function scoreboard(d) {
  const lines = { wellness: [], beauty: [], buildpipeline: [] };
  const o = d.orders;
  lines.wellness.push(`Store orders: yesterday ${o ? `${o.yOrders} (${money(o.yRevenue)})` : 'no data'} · 7 days ${o ? `${o.d7Orders} (${money(o.d7Revenue)})` : 'no data'} · prior 7 days ${o ? `${o.prev7Orders} (${money(o.prev7Revenue)})` : 'no data'} · 30 days ${o ? `${o.d30Orders} (${money(o.d30Revenue)})` : 'no data'}`);
  const c = d.clinic;
  lines.wellness.push(`Clinic pipeline: ${c ? `${c.total} clinics · ${c.discovered || 0} found · ${c.qualified || 0} qualified · ${c.contacted || 0} contacted · ${c.replied || 0} replied · ${c.suppressed || 0} opted out` : 'no data'}`);
  lines.wellness.push(`Clinic e-mails: yesterday ${na(d.sentYesterday)}${d.dailyCap ? ` of ${d.dailyCap} cap` : ''} · last 7 days ${na(d.sent7)} · replies this week ${na(d.clinicReplies && d.clinicReplies.last7)}`);
  lines.wellness.push(`Automation (24h): ${d.runs ? plural(d.runs.length, 'outreach run') : 'no data'} · sender ticks ${na(d.sendTicks)} · discovery ${d.discovery ? `${d.discovery.runs} runs, ${d.discovery.stored} clinics stored` : 'no data'}${d.paused ? ' · **PAUSED**' : ''}`);
  const k = d.coaching;
  const bl = d.leads ? (d.leads.beauty || { total: 0, last7: 0 }) : null;
  lines.beauty.push(`Coaching clients: ${k ? `${k.total} total · ${k.activeCount} active` : 'no data'} · check-ins this week ${na(d.checkins7)}`);
  lines.beauty.push(`Coaching leads captured: ${bl ? `${bl.last7} this week · ${bl.total} all time` : 'no data'}`);
  lines.buildpipeline.push(`Funnel: ${na(d.funnelEvents7)} events this week · applications ${d.funnelLeads ? `${d.funnelLeads.last7} this week · ${d.funnelLeads.total} all time` : 'no data'}`);
  return lines;
}

function headline(d) {
  const target30 = DAILY_REVENUE_TARGET * 30;
  if (!d.orders) return 'Revenue: no data.';
  const perDay = d.orders.d30Revenue / 30;
  const untracked = (d.coaching && d.coaching.total === 0) && (d.funnelLeads && d.funnelLeads.total === 0);
  return `Recorded revenue, last 30 days: ${money(d.orders.d30Revenue)} (about ${money(perDay)}/day) against a target of ${money(DAILY_REVENUE_TARGET)}/day (${Math.round((d.orders.d30Revenue / target30) * 100)}% of pace).${untracked ? ' Only Wellness store orders reach the OS today. Coaching and agency revenue are not recorded anywhere the agents can see.' : ''}`;
}

/**
 * Build the brief.
 * @param {object} metrics  output of brief-metrics.collectMetrics()
 * @param {object} opts     { now, dailyCap, trigger }
 */
function buildBrief(metrics, { now = new Date(), dailyCap = null, trigger = 'manual' } = {}) {
  const d = derive(metrics, { now, dailyCap });
  const parts = [wellnessActions(d), beautyActions(d), buildPipelineActions(d)];
  const actions = parts.flatMap(p => p.actions).sort((a, b) => b.priority - a.priority);
  const blockers = parts.flatMap(p => p.blockers);
  const failed = Object.entries(metrics).filter(([, m]) => m && m.error).map(([k, m]) => `${k} (${m.error})`);
  if (failed.length) blockers.push(`Some numbers could not be read and show as "no data": ${failed.join(', ')}.`);

  const owner = actions.filter(a => a.who === 'owner').slice(0, 3);
  const ownerRest = actions.filter(a => a.who === 'owner').slice(3);
  const claude = actions.filter(a => a.who === 'claude');
  const board = scoreboard(d);
  const lead = headline(d);

  const roleTitle = Object.fromEntries(ROLES.map(r => [r.id, r.title]));
  const laneName = Object.fromEntries(LANES.map(l => [l.id, l.name]));
  const line = a => `**${a.title}**  \n  _${laneName[a.lane]} · ${roleTitle[a.role]}._ ${a.why}`;

  const md = [];
  md.push('---', 'type: brief', `date: ${d.today}`, `trigger: ${trigger}`, 'tags: [brief, daily]', '---');
  md.push(`# Daily agent brief · ${nyLongDate(now)}`, '');
  md.push(`> Built from live data at ${now.toISOString().slice(11, 16)} UTC. "no data" means a number could not be read; it never means zero.`, '');
  md.push('## Where we stand', '', lead, '');
  md.push('## You, today', '');
  if (owner.length) owner.forEach((a, i) => md.push(`${i + 1}. ${line(a)}`));
  else md.push('Nothing needs you today.');
  if (ownerRest.length) md.push('', `Also waiting on you: ${ownerRest.map(a => a.title).join(' · ')}`);
  md.push('', '## Claude and the agents, today', '');
  if (claude.length) claude.forEach(a => md.push(`- [ ] ${line(a)}`));
  else md.push('- Nothing flagged.');
  md.push('', '## Blocked', '');
  if (blockers.length) blockers.forEach(b => md.push(`- ${b}`));
  else md.push('- Nothing blocked.');
  md.push('', '## Scoreboard', '');
  for (const lane of LANES) {
    md.push(`### [[${lane.map}|${lane.name}]]`, '');
    board[lane.id].forEach(l => md.push(`- ${l}`));
    md.push('');
  }
  md.push('[[knowledge/Home|Home]] · [[docs/daily-agent-brief|How this brief works]]', '');

  return {
    date: d.today,
    generatedAt: now.toISOString(),
    trigger,
    headline: lead,
    ownerActions: owner,
    claudeActions: claude,
    actions,
    blockers,
    scoreboard: board,
    markdown: md.join('\n'),
  };
}

module.exports = { buildBrief, derive, LANES, laneOfLead };
