const test=require('node:test');const assert=require('node:assert/strict');
const {PLANS,CREDIT_PACKS,getPack}=require('../lib/platform/commercial-catalog');
const {buildOnboardingPreview}=require('../lib/platform/fast-onboarding');

test('commercial catalog exposes core plans and packs',()=>{assert.equal(PLANS.solo.monthlyCents,29900);assert.equal(PLANS.agency.monthlyCents,49900);assert.equal(CREDIT_PACKS.length,6);assert.equal(getPack('data-3000').credits,3000)});
test('fast onboarding produces a four-step preview',()=>{const x=buildOnboardingPreview({companyName:'Acme',keywords:['med spa'],channel:'email'});assert.equal(x.checklist.length,4);assert.deepEqual(x.channels,['email']);assert.ok(x.campaign)});
