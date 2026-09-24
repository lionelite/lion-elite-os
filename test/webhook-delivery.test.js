const test=require('node:test');const assert=require('node:assert/strict');
const {deliverWebhook}=require('../workers/gtm-delivery-worker');
const {encrypt}=require('../lib/platform/security/crypto-vault');

test('delivery sends signed webhook headers',async()=>{
  const env={GTM_OAUTH_ENCRYPTION_KEY:'secret'};
  const prior=process.env.GTM_OAUTH_ENCRYPTION_KEY;process.env.GTM_OAUTH_ENCRYPTION_KEY='secret';
  let seen;
  const result=await deliverWebhook(
    {payload:{type:'meeting.booked'}},
    {url:'https://example.test',signingSecretCiphertext:encrypt('hook-secret',env)},
    async(url,opts)=>{seen={url,opts};return{ok:true,text:async()=>''}}
  );
  if(prior===undefined) delete process.env.GTM_OAUTH_ENCRYPTION_KEY; else process.env.GTM_OAUTH_ENCRYPTION_KEY=prior;
  assert.equal(result.ok,true);assert.match(seen.opts.headers['X-LionOS-Signature'],/^sha256=/);
});
