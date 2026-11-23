const test=require('node:test');const assert=require('node:assert/strict');
const {LinkedInProviderAdapter}=require('../lib/platform/integrations/linkedin-provider');

test('provider executes compliant LinkedIn action',async()=>{
  let seen;
  const p=new LinkedInProviderAdapter({baseUrl:'https://provider.test',token:'x',fetchImpl:async(url,opts)=>{seen={url,opts};return{ok:true,json:async()=>({id:'a1'})}}});
  const r=await p.execute({actionType:'connect',complianceSnapshot:{allowed:true}});
  assert.equal(r.id,'a1');assert.match(seen.url,/\/actions$/);
});
