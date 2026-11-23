const test=require('node:test');const assert=require('node:assert/strict');
const {provisionDefaultAgents}=require('../lib/platform/default-gtm-agents');
const {priceAction,summarizeUsage}=require('../lib/platform/usage-meter');
const {CsvSourceProvider,runSourcing}=require('../lib/platform/sourcing');
const {transitionDelivery}=require('../lib/platform/delivery');
const {buildInsights}=require('../lib/platform/insights');

test('provisions five default GTM agents',()=>{const a=provisionDefaultAgents('w1');assert.equal(a.length,5);assert.deepEqual(a.map(x=>x.agentKey),['leads','intent','outbound','copy','qa'])});
test('meters data and action credits separately',()=>{assert.deepEqual(priceAction('enrich.reveal',2),{purse:'data',credits:60,quantity:2});const s=summarizeUsage([{purse:'data',credits:90},{purse:'action',credits:100}],{data:100,action:500});assert.equal(s.data.percent,90);assert.equal(s.action.remaining,400)});
test('sourcing applies ICP fit gate before acceptance',async()=>{const p=new CsvSourceProvider([{industry:'Med Spa',employees:8,name:'A'},{industry:'Restaurant',employees:12,name:'B'}]);const r=await runSourcing({provider:p,icp:{industries:['med spa'],employees:{min:2,max:20}}});assert.equal(r.length,1);assert.equal(r[0].candidate.name,'A')});
test('delivery retries then goes dead',()=>{let j={attemptCount:0,maxAttempts:2};j=transitionDelivery(j,{ok:false,error:'x'});assert.equal(j.status,'queued');j=transitionDelivery(j,{ok:false,error:'x'});assert.equal(j.status,'dead')});
test('builds funnel and usage insights',()=>{const x=buildInsights({prospects:[{status:'contacted'},{status:'replied'},{status:'meeting'}],usage:[{actionKey:'email.send',credits:2,quantity:2}]});assert.equal(x.funnel.sourced,3);assert.equal(x.funnel.replied,2);assert.equal(x.usage['email.send'].credits,2)});
