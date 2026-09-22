const test=require('node:test');const assert=require('node:assert/strict');
const {ApolloProvider}=require('../lib/platform/sources/apollo');
const {canAccessWorkspace}=require('../lib/platform/authorization');

test('Apollo adapter fails closed without API key',async()=>{const p=new ApolloProvider();await assert.rejects(()=>p.search({}),/not configured/)});
test('Apollo search uses people API endpoint and normalizes results',async()=>{
  let seen='';
  const p=new ApolloProvider({apiKey:'x',fetchImpl:async(url)=>{seen=url;return {ok:true,json:async()=>({people:[{id:'p1',name:'Maya Chen',title:'VP Ops',organization:{name:'Northbeam',primary_domain:'northbeam.io'}}]})}}});
  const r=await p.search({icp:{geography:'Florida'}});
  assert.match(seen,/mixed_people\/api_search/);assert.equal(r[0].sourceExternalId,'p1');assert.equal(r[0].companyName,'Northbeam');
});
test('workspace roles enforce minimum access',()=>{assert.equal(canAccessWorkspace({status:'active',role:'viewer'},'viewer'),true);assert.equal(canAccessWorkspace({status:'active',role:'viewer'},'admin'),false);assert.equal(canAccessWorkspace({status:'active',role:'owner'},'admin'),true);assert.equal(canAccessWorkspace({status:'suspended',role:'owner'},'viewer'),false)});
