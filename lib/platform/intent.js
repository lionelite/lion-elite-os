'use strict';

const SIGNAL_WEIGHTS = Object.freeze({
  interested_reply: 5,
  reply: 2,
  keyword_72h: 2,
  reaction: 1,
  hiring_signal: 1,
  funding_signal: 1
});

function calculateIntentHeat({ signals = [], daysSinceLastSignal = null } = {}) {
  let heat = 1;
  for (const signal of signals) {
    const weight = SIGNAL_WEIGHTS[signal.type] || 0;
    heat += weight;
  }
  if (Number.isFinite(daysSinceLastSignal) && daysSinceLastSignal >= 14) {
    heat -= 1;
  }
  return Math.max(1, Math.min(5, heat));
}

function queueEligibility({ intentHeat, threshold = 4, suppressed = false, replied = false }) {
  if (suppressed) return { eligible: false, reason: 'suppressed' };
  if (replied) return { eligible: false, reason: 'reply_stops_sequence' };
  if (intentHeat < threshold) return { eligible: false, reason: 'below_intent_threshold' };
  return { eligible: true, reason: 'intent_threshold_met' };
}

module.exports = { SIGNAL_WEIGHTS, calculateIntentHeat, queueEligibility };
