const test=require('node:test');const assert=require('node:assert/strict');
const {encrypt,decrypt}=require('../lib/platform/security/crypto-vault');
const {newSessionToken,hashSessionToken}=require('../lib/platform/security/sessions');
const {dnsRequirements,nextProvisioningState}=require('../lib/platform/sender-provisioning');
const {SignalProvider,pollSubscription,nextPollAt}=require('../lib/platform/signals/poller');

test('OAuth vault round trips without plaintext',()=>{const env={GTM_OAUTH_ENCRYPTION_KEY:'test-secret'};const c=encrypt('token-123',env);assert.notEqual(c,'token-123');assert.equal(decrypt(c,env),'token-123')});
test('session tokens are opaque and stored as hashes',()=>{const t=newSessionToken();assert.ok(t.length>20);assert.equal(hashSessionToken(t).length,64);assert.notEqual(hashSessionToken(t),t)});
test('sender provisioning moves through DNS verification states',()=>{assert.equal(nextProvisioningState('requested','dns_issued'),'dns_pending');assert.equal(nextProvisioningState('dns_pending','dns_verified'),'verifying');assert.equal(nextProvisioningState('verifying','provider_ready'),'provisioned');assert.equal(dnsRequirements('example.com').length,3)});
test('signal poller updates prospect heat from live events',async()=>{class P extends SignalProvider{async poll(){return[{prospectKey:'p1',signalType:'keyword_72h'}]}}const u=await pollSubscription({subscription:{config:{}},provider:new P('x'),prospects:[{prospectId:'1',sourceExternalId:'p1',signals:[]}]});assert.equal(u.length,1);assert.equal(u[0].intentHeat,3);assert.ok(new Date(nextPollAt(60)).getTime()>Date.now())});
