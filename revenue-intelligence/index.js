'use strict';

const DEFAULT_TIME_ZONE = 'America/New_York';
const DEFAULT_MONTHLY_TARGET = 100000;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, number(value)));
}

function money(value) {
  return Math.round((number(value) + Number.EPSILON) * 100) / 100;
}

function toDate(value) {
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateParts(value, timeZone = DEFAULT_TIME_ZONE) {
  const date = toDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value;
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
  };
}

function dateKey(value, timeZone = DEFAULT_TIME_ZONE) {
  const parts = dateParts(value, timeZone);
  if (!parts) return null;
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function monthKey(value, timeZone = DEFAULT_TIME_ZONE) {
  const parts = dateParts(value, timeZone);
  if (!parts) return null;
  return `${parts.year}-${String(parts.month).padStart(2, '0')}`;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function shiftUtcDays(value, delta) {
  const date = toDate(value);
  if (!date) return null;
  return new Date(date.getTime() + delta * 86400000);
}

function sumBy(items, keyFn, amountFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item) || 'unknown';
    out[key] = money(number(out[key]) + number(amountFn(item)));
  }
  return out;
}

function normalizeRevenueEvent(event = {}) {
  const amount = money(event.amount ?? event.revenue ?? event.total ?? 0);
  return {
    id: event.id || event.orderId || event.paymentId || null,
    timestamp: event.timestamp || event.createdAt || event.date || null,
    amount,
    brand: event.brand || 'unknown',
    source: event.source || event.channel || 'unknown',
    campaign: event.campaign || null,
    customerId: event.customerId || null,
    orderId: event.orderId || event.id || null,
    isRepeat: Boolean(event.isRepeat || event.repeatCustomer),
    verified: event.verified !== false,
  };
}

function normalizeLead(lead = {}) {
  const stageProbability = clamp01(
    lead.stageProbability ?? lead.probability ?? defaultStageProbability(lead.status || lead.stage),
  );
  const leadQuality = clamp01(lead.leadQuality ?? lead.quality ?? lead.score ?? 0.5);
  const estimatedValue = money(lead.estimatedValue ?? lead.dealValue ?? lead.value ?? 0);
  return {
    id: lead.id || lead.leadId || null,
    name: lead.name || lead.businessName || 'Unknown lead',
    brand: lead.brand || 'unknown',
    source: lead.source || 'unknown',
    status: lead.status || lead.stage || 'new',
    owner: lead.owner || 'unassigned',
    nextAction: lead.nextAction || null,
    nextActionDate: lead.nextActionDate || lead.followUpDate || null,
    estimatedValue,
    stageProbability,
    leadQuality,
    expectedValue: money(estimatedValue * stageProbability * leadQuality),
    contactable: Boolean(lead.contactable || lead.email || lead.phone || lead.contactForm || lead.socialProfile),
  };
}

function defaultStageProbability(stage = '') {
  const normalized = String(stage).toLowerCase();
  const map = {
    new: 0.08,
    enriched: 0.12,
    qualified: 0.2,
    contacted: 0.25,
    engaged: 0.4,
    'meeting-booked': 0.55,
    meeting_booked: 0.55,
    proposal: 0.7,
    checkout: 0.75,
    won: 1,
    lost: 0,
    nurture: 0.08,
    reactivation: 0.25,
  };
  return map[normalized] ?? 0.1;
}

function calculateRevenueSummary(rawEvents = [], options = {}) {
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const now = toDate(options.now || new Date()) || new Date();
  const monthlyTarget = money(options.monthlyTarget || DEFAULT_MONTHLY_TARGET);
  const today = dateKey(now, timeZone);
  const yesterday = dateKey(shiftUtcDays(now, -1), timeZone);
  const currentMonth = monthKey(now, timeZone);
  const currentParts = dateParts(now, timeZone);
  const events = rawEvents.map(normalizeRevenueEvent).filter((event) => event.verified && toDate(event.timestamp));

  const todayEvents = events.filter((event) => dateKey(event.timestamp, timeZone) === today);
  const yesterdayEvents = events.filter((event) => dateKey(event.timestamp, timeZone) === yesterday);
  const mtdEvents = events.filter((event) => monthKey(event.timestamp, timeZone) === currentMonth);
  const last7Cutoff = shiftUtcDays(now, -6);
  const last7Events = events.filter((event) => {
    const timestamp = toDate(event.timestamp);
    return timestamp && timestamp >= new Date(last7Cutoff.setHours(0, 0, 0, 0)) && timestamp <= now;
  });

  const total = (rows) => money(rows.reduce((sum, row) => sum + row.amount, 0));
  const revenueToday = total(todayEvents);
  const revenueYesterday = total(yesterdayEvents);
  const revenueLast7Days = total(last7Events);
  const revenueMTD = total(mtdEvents);
  const orderEvents = mtdEvents.filter((event) => event.amount > 0);
  const repeatRevenue = total(mtdEvents.filter((event) => event.isRepeat));
  const attributedRevenue = total(mtdEvents.filter((event) => event.source && event.source !== 'unknown'));
  const totalDays = daysInMonth(currentParts.year, currentParts.month);
  const elapsedDays = Math.max(1, currentParts.day);
  const dailyTarget = money(monthlyTarget / totalDays);
  const requiredDailyPace = money(Math.max(0, monthlyTarget - revenueMTD) / Math.max(1, totalDays - elapsedDays + 1));
  const projectedMonthRevenue = money((revenueMTD / elapsedDays) * totalDays);

  return {
    generatedAt: now.toISOString(),
    timeZone,
    monthlyTarget,
    dailyTarget,
    revenueToday,
    revenueYesterday,
    revenueLast7Days,
    sevenDayAverage: money(revenueLast7Days / 7),
    revenueMTD,
    targetProgressPct: monthlyTarget ? money((revenueMTD / monthlyTarget) * 100) : 0,
    projectedMonthRevenue,
    projectedTargetGap: money(monthlyTarget - projectedMonthRevenue),
    requiredDailyPace,
    ordersMTD: orderEvents.length,
    averageOrderValue: orderEvents.length ? money(revenueMTD / orderEvents.length) : 0,
    repeatRevenue,
    repeatRevenueSharePct: revenueMTD ? money((repeatRevenue / revenueMTD) * 100) : 0,
    attributionCoveragePct: revenueMTD ? money((attributedRevenue / revenueMTD) * 100) : 0,
    byBrand: sumBy(mtdEvents, (event) => event.brand, (event) => event.amount),
    bySource: sumBy(mtdEvents, (event) => event.source, (event) => event.amount),
  };
}

function calculatePipeline(rawLeads = [], options = {}) {
  const now = toDate(options.now || new Date()) || new Date();
  const timeZone = options.timeZone || DEFAULT_TIME_ZONE;
  const today = dateKey(now, timeZone);
  const leads = rawLeads.map(normalizeLead);

  const overdue = leads.filter((lead) => {
    const due = dateKey(lead.nextActionDate, timeZone);
    return due && due < today && !['won', 'lost'].includes(String(lead.status).toLowerCase());
  });
  const dueToday = leads.filter((lead) => dateKey(lead.nextActionDate, timeZone) === today);
  const qualified = leads.filter((lead) => lead.contactable && lead.stageProbability >= 0.2);
  const weightedPipelineValue = money(leads.reduce((sum, lead) => sum + lead.expectedValue, 0));

  const ranked = [...leads]
    .filter((lead) => !['won', 'lost'].includes(String(lead.status).toLowerCase()))
    .sort((a, b) => {
      const aOverdue = overdue.some((lead) => lead.id && lead.id === a.id) ? 1 : 0;
      const bOverdue = overdue.some((lead) => lead.id && lead.id === b.id) ? 1 : 0;
      if (aOverdue !== bOverdue) return bOverdue - aOverdue;
      return b.expectedValue - a.expectedValue;
    });

  return {
    totalLeads: leads.length,
    qualifiedLeads: qualified.length,
    contactableLeads: leads.filter((lead) => lead.contactable).length,
    weightedPipelineValue,
    overdueFollowUps: overdue.length,
    overdueExpectedValue: money(overdue.reduce((sum, lead) => sum + lead.expectedValue, 0)),
    dueToday: dueToday.length,
    dueTodayExpectedValue: money(dueToday.reduce((sum, lead) => sum + lead.expectedValue, 0)),
    topOpportunities: ranked.slice(0, options.limit || 10),
  };
}

function evaluateSystemHealth(rawSystems = [], options = {}) {
  const now = toDate(options.now || new Date()) || new Date();
  const staleAfterHours = number(options.staleAfterHours, 26);
  return rawSystems.map((system = {}) => {
    const lastSuccess = toDate(system.lastSuccessAt || system.lastSuccessfulRun || system.lastRunAt);
    const ageHours = lastSuccess ? (now.getTime() - lastSuccess.getTime()) / 3600000 : Infinity;
    let status = system.status || 'unproven';
    if (system.error) status = 'broken';
    else if (!lastSuccess) status = 'unproven';
    else if (ageHours > staleAfterHours) status = 'degraded';
    else if (!['broken', 'degraded'].includes(status)) status = 'verified';
    return {
      name: system.name || 'unnamed-system',
      owner: system.owner || 'unassigned',
      status,
      lastSuccessAt: lastSuccess ? lastSuccess.toISOString() : null,
      ageHours: Number.isFinite(ageHours) ? money(ageHours) : null,
      qualifiedOutputCount: number(system.qualifiedOutputCount),
      error: system.error || null,
    };
  });
}

function detectRevenueLeaks(summary, pipeline, systems = []) {
  const leaks = [];
  const revenueGapToday = money(Math.max(0, summary.dailyTarget - summary.revenueToday));
  if (revenueGapToday > 0) {
    leaks.push({
      type: 'daily-revenue-gap',
      severity: revenueGapToday > summary.dailyTarget * 0.5 ? 'critical' : 'high',
      estimatedRecoverableRevenue: revenueGapToday,
      evidence: `Revenue today is $${summary.revenueToday} vs $${summary.dailyTarget} daily target.`,
      owner: 'sales',
      nextAction: 'Work the highest expected-value due and overdue opportunities before optional feature work.',
      verificationMetric: 'Revenue today',
    });
  }

  if (pipeline.overdueFollowUps > 0) {
    leaks.push({
      type: 'overdue-follow-ups',
      severity: pipeline.overdueFollowUps >= 5 ? 'critical' : 'high',
      estimatedRecoverableRevenue: pipeline.overdueExpectedValue,
      evidence: `${pipeline.overdueFollowUps} follow-ups are overdue with $${pipeline.overdueExpectedValue} weighted expected value.`,
      owner: 'sales',
      nextAction: 'Clear overdue follow-ups in expected-value order.',
      verificationMetric: 'Overdue follow-ups remaining',
    });
  }

  if (summary.revenueMTD > 0 && summary.attributionCoveragePct < 90) {
    const unknownRevenue = money(summary.revenueMTD * (1 - summary.attributionCoveragePct / 100));
    leaks.push({
      type: 'attribution-gap',
      severity: summary.attributionCoveragePct < 60 ? 'critical' : 'medium',
      estimatedRecoverableRevenue: 0,
      evidence: `${summary.attributionCoveragePct}% of MTD revenue is attributed; approximately $${unknownRevenue} lacks a known source.`,
      owner: 'marketing-ops',
      nextAction: 'Repair source/campaign attribution before scaling paid acquisition.',
      verificationMetric: 'Attribution coverage %',
    });
  }

  for (const system of systems.filter((system) => system.status !== 'verified')) {
    leaks.push({
      type: 'system-health',
      severity: system.status === 'broken' ? 'critical' : 'high',
      estimatedRecoverableRevenue: 0,
      evidence: `${system.name} is ${system.status}${system.lastSuccessAt ? `; last success ${system.lastSuccessAt}` : ''}.`,
      owner: system.owner,
      nextAction: `Restore ${system.name} and verify owner-visible output.`,
      verificationMetric: 'Last successful run and qualified output count',
    });
  }

  const severityRank = { critical: 3, high: 2, medium: 1, low: 0 };
  return leaks.sort((a, b) => {
    if (b.estimatedRecoverableRevenue !== a.estimatedRecoverableRevenue) {
      return b.estimatedRecoverableRevenue - a.estimatedRecoverableRevenue;
    }
    return severityRank[b.severity] - severityRank[a.severity];
  });
}

function buildDailyActions(summary, pipeline, leaks, options = {}) {
  const actions = [];
  const limit = options.limit || 5;

  for (const lead of pipeline.topOpportunities) {
    if (actions.length >= limit) break;
    actions.push({
      priority: actions.length + 1,
      type: 'sales-opportunity',
      owner: lead.owner,
      expectedValue: lead.expectedValue,
      action: lead.nextAction || `Follow up with ${lead.name}`,
      leadId: lead.id,
      reason: `${lead.status} opportunity with $${lead.expectedValue} weighted expected value.`,
    });
  }

  for (const leak of leaks) {
    if (actions.length >= limit) break;
    if (actions.some((action) => action.type === 'sales-opportunity') && leak.type === 'overdue-follow-ups') continue;
    actions.push({
      priority: actions.length + 1,
      type: leak.type,
      owner: leak.owner,
      expectedValue: leak.estimatedRecoverableRevenue,
      action: leak.nextAction,
      reason: leak.evidence,
    });
  }

  if (actions.length < limit && summary.projectedMonthRevenue < summary.monthlyTarget) {
    actions.push({
      priority: actions.length + 1,
      type: 'pace-recovery',
      owner: 'owner',
      expectedValue: money(Math.max(0, summary.monthlyTarget - summary.projectedMonthRevenue)),
      action: `Protect at least $${summary.requiredDailyPace} in daily revenue pace for the remainder of the month.`,
      reason: `Month-end projection is $${summary.projectedMonthRevenue} vs $${summary.monthlyTarget} target.`,
    });
  }

  return actions.slice(0, limit);
}

function generateExecutiveReport(input = {}, options = {}) {
  const mergedOptions = {
    monthlyTarget: input.monthlyTarget || options.monthlyTarget || DEFAULT_MONTHLY_TARGET,
    timeZone: input.timeZone || options.timeZone || DEFAULT_TIME_ZONE,
    now: input.now || options.now || new Date(),
  };
  const revenue = calculateRevenueSummary(input.revenueEvents || input.events || [], mergedOptions);
  const pipeline = calculatePipeline(input.leads || [], mergedOptions);
  const systems = evaluateSystemHealth(input.systems || [], mergedOptions);
  const leaks = detectRevenueLeaks(revenue, pipeline, systems);
  const actions = buildDailyActions(revenue, pipeline, leaks, { limit: input.actionLimit || 5 });

  return {
    generatedAt: revenue.generatedAt,
    objective: 'Revenue every day',
    compliance: {
      lionEliteWellness: 'Research-use-only positioning must be preserved in all customer-facing execution.',
      lionEliteBeauty: 'Premium coaching positioning must be preserved.',
    },
    revenue,
    pipeline,
    systems,
    topRevenueLeaks: leaks.slice(0, 3),
    dailyActions: actions,
  };
}

module.exports = {
  DEFAULT_MONTHLY_TARGET,
  DEFAULT_TIME_ZONE,
  normalizeRevenueEvent,
  normalizeLead,
  calculateRevenueSummary,
  calculatePipeline,
  evaluateSystemHealth,
  detectRevenueLeaks,
  buildDailyActions,
  generateExecutiveReport,
};
