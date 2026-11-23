const test=require('node:test');const assert=require('node:assert/strict');
const {hash}=require('../lib/platform/gtm-access');
const {createBillingPortal}=require('../lib/platform/stripe-billing-portal');
test('access token hash is deterministic and opaque',()=>{assert.equal(hash('x'),hash('x'));assert.notEqual(hash('x'),'x')});
test('billing portal fails closed without stripe',async()=>{const x=await createBillingPortal({customerId:'cus_x',returnUrl:'https://x.test',env:{}});assert.equal(x.ok,false);assert.equal(x.reason,'not_configured')});
