const test=require('node:test');const assert=require('node:assert/strict');
const {configForPlan,buildParams}=require('../lib/platform/stripe-gtm-checkout');
const {cleanEmail}=require('../routes/gtm-sales');

test('LionOS checkout fails closed without Stripe config',()=>{const c=configForPlan('solo',{});assert.equal(c.enabled,false);assert.ok(c.missing.includes('STRIPE_SECRET_KEY'))});
test('LionOS checkout metadata identifies product and plan',()=>{const p=buildParams({priceId:'price_x',baseUrl:'https://lionos.test',email:'a@b.com',planKey:'agency'});assert.equal(p.get('metadata[product]'),'lionos');assert.equal(p.get('metadata[plan_key]'),'agency');assert.equal(p.get('customer_email'),'a@b.com')});
test('sales email sanitizer rejects malformed email',()=>{assert.equal(cleanEmail('bad'),'');assert.equal(cleanEmail('A@B.com'),'a@b.com')});
