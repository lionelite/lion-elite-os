'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildClinicSupplyEmail, segmentFor, cityFromMarket } = require('../lib/outreach/clinic-supply-email');
const { draftForContext, isClinicSupply } = require('../lib/outreach/draft-router');
const { buildEmailJobContext } = require('../lib/outreach-enqueue');

const clinic = { businessName: 'GlowVita', category: 'med-spa', whyTargeted: 'Names medspa.', market: 'miami-fl' };

test('every step is RUO-approved, personalized, and passes the quality checklist', () => {
  for (const step of [1, 2, 3]) {
    const d = buildClinicSupplyEmail(clinic, { step });
    assert.equal(d.approved, true, `step ${step} compliance`);
    assert.deepEqual(d.quality.blockers, [], `step ${step} blockers`);
    assert.ok(d.quality.score >= 90, `step ${step} score ${d.quality.score}`);
    assert.match(d.body, /GlowVita/);
    assert.match(d.body, /laboratory research purposes only/);
  }
});

test('step 1 makes the pilot offer, asks one discovery question, and names the market', () => {
  const d = buildClinicSupplyEmail(clinic);
  assert.match(d.body, /side-by-side quote/);
  assert.match(d.body, /med spas and aesthetics practices in Miami/);
  assert.match(d.body, /price, documentation, or delivery reliability\?/);
  assert.match(d.body, /won't contact you again/);
});

test('no savings claim, no patient-service language, no guessed names', () => {
  for (const step of [1, 2, 3]) {
    const body = buildClinicSupplyEmail(clinic, { step }).body;
    assert.doesNotMatch(body, /save \d|% (off|cheaper|less)|guarantee|patient|therapy|weight|hormone/i);
    assert.match(body, /^Hi GlowVita team,/);
  }
  assert.match(buildClinicSupplyEmail({ ...clinic, contactName: 'Dana' }).body, /^Hi Dana,/);
});

test('segments and city names come from the stored record', () => {
  assert.equal(segmentFor({ category: 'clinic', businessName: 'West Coast Plastic Surgery' }).id, 'plastic_surgery');
  assert.equal(segmentFor({ category: 'clinic', whyTargeted: 'Names iv .', businessName: 'IV Elements' }).id, 'iv_hydration');
  assert.equal(segmentFor({ category: 'med-spa', businessName: 'Kalon' }).id, 'med_spa');
  assert.equal(segmentFor({ category: 'clinic', businessName: 'Main Street Medical' }).id, 'clinic');
  assert.equal(cityFromMarket('boca-raton-fl'), 'Boca Raton');
  assert.equal(cityFromMarket('delray-boynton-fl'), 'Delray Beach and Boynton Beach');
  assert.equal(cityFromMarket(''), '');
});

test('a business name the RUO gate rejects is held, not sent', () => {
  const d = buildClinicSupplyEmail({ businessName: 'Injection Artistry', category: 'med-spa', market: 'miami-fl' });
  assert.equal(d.approved, false);
  const routed = draftForContext({ businessName: 'Injection Artistry', category: 'med-spa', campaignId: 'osm-business-discovery' });
  assert.equal(routed.draft.approved, false);
  assert.ok(routed.quality.blockers.length > 0);
});

test('stored clinic prospects route to the clinic sequence, gyms keep the Beauty builder', () => {
  const clinicProspect = {
    prospectId: 'p1', campaignId: 'osm-business-discovery',
    business: { name: 'GlowVita', niche: 'med-spa', region: 'miami-fl' }, contact: { email: 'info@glowvita.example' },
  };
  const ctx = buildEmailJobContext(clinicProspect);
  assert.equal(isClinicSupply(ctx), true);
  const routed = draftForContext(ctx);
  assert.equal(routed.route, 'clinic_supply');
  assert.match(routed.draft.body, /Lion Elite Wellness/);
  assert.doesNotMatch(routed.draft.body, /Lion Elite Beauty|coaching/);
  assert.match(routed.draft.body, /in Miami/);

  const gym = draftForContext(buildEmailJobContext({ ...clinicProspect, business: { name: 'Iron Gym', niche: 'gym', region: 'miami-fl' } }));
  assert.equal(gym.route, 'beauty_partnership');
  assert.equal(draftForContext({ businessName: 'X Clinic', campaignId: 'med_spa_research_supply' }).route, 'clinic_supply');
});

test('the email worker builds drafts through the router, not the Beauty builder directly', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'workers', 'outreach-worker.js'), 'utf8');
  assert.match(src, /draftForContext\(context\)/);
  assert.doesNotMatch(src, /require\('\.\.\/lib\/email-generation'\)/);
});

test('nothing passes a queue NAME where addJob() expects a queue KEY', () => {
  const fs = require('fs');
  const path = require('path');
  const { QUEUE_NAMES } = require('../lib/job-queues');
  const root = path.join(__dirname, '..');
  const files = ['scripts', 'workers', 'lib', 'routes'].flatMap(dir => {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() ? (e.name === 'node_modules' ? [] : walk(path.join(d, e.name))) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);
    return walk(path.join(root, dir));
  });
  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    if (/addJob\(\s*QUEUE_NAMES\./.test(src)) offenders.push(path.relative(root, file));
    for (const name of Object.values(QUEUE_NAMES)) {
      if (new RegExp(`addJob\\(\\s*['"]${name}['"]`).test(src) && !Object.keys(QUEUE_NAMES).includes(name)) offenders.push(`${path.relative(root, file)}: '${name}'`);
    }
  }
  assert.deepEqual(offenders, []);
});
