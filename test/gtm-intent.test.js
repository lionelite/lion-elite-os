const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateIntentHeat, queueEligibility } = require('../lib/platform/intent');

test('intent heat moves only from observed signals', () => {
  assert.equal(calculateIntentHeat({ signals: [] }), 1);
  assert.equal(calculateIntentHeat({ signals: [{ type: 'keyword_72h' }, { type: 'reaction' }] }), 4);
  assert.equal(calculateIntentHeat({ signals: [{ type: 'interested_reply' }] }), 5);
});

test('old inactivity cools a prospect', () => {
  assert.equal(calculateIntentHeat({ signals: [{ type: 'keyword_72h' }], daysSinceLastSignal: 14 }), 2);
});

test('queue gate requires threshold and stops after reply', () => {
  assert.deepEqual(queueEligibility({ intentHeat: 3, threshold: 4 }), { eligible: false, reason: 'below_intent_threshold' });
  assert.deepEqual(queueEligibility({ intentHeat: 4, threshold: 4 }), { eligible: true, reason: 'intent_threshold_met' });
  assert.deepEqual(queueEligibility({ intentHeat: 5, threshold: 4, replied: true }), { eligible: false, reason: 'reply_stops_sequence' });
});
