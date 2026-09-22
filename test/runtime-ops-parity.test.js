const test=require('node:test');const assert=require('node:assert/strict');
const {evaluateBudget}=require('../lib/platform/budget-policy');
const {detectOptOut}=require('../lib/platform/opt-out');
const {headersForWebhook,verifyWebhook}=require('../lib/platform/webhook-signing');
const {verifiedConnector}=require('../lib/platform/connector-health');

test('budget warns at 80 and hard stops at zero',()=>{let x=evaluateBudget({data:{allowance:100,remaining:20,percent:80},action:{allowance:100,remaining:50,percent:50}});assert.equal(x.incidents[0].level,'warning');x=evaluateBudget({data:{allowance:100,remaining:0,percent:100},action:{allowance:100,remaining:50,percent:50}});assert.equal(x.blocked,true);assert.equal(x.incidents[0].level,'hard_stop')});
test('deterministic opt out runs without a model',()=>{assert.equal(detectOptOut('Please take me off this list').optOut,true);assert.equal(detectOptOut('Sounds interesting').optOut,false)});
test('webhooks are signed with timestamp body HMAC',()=>{const body=JSON.stringify({type:'meeting.booked'});const h=headersForWebhook({secret:'s',body,timestamp:1000});assert.equal(verifyWebhook({secret:'s',body,timestamp:'1000',signature:h['X-LionOS-Signature'],now:1000}),true);assert.equal(verifyWebhook({secret:'bad',body,timestamp:'1000',signature:h['X-LionOS-Signature'],now:1000}),false)});
test('connector health only says connected after verification',()=>{assert.equal(verifiedConnector({provider:'hubspot',ok:true}).status,'connected');assert.equal(verifiedConnector({provider:'hubspot',ok:false,error:'401'}).status,'degraded')});
