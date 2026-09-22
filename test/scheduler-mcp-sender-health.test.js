const test=require('node:test');const assert=require('node:assert/strict');
const {runtimeJobCatalog}=require('../lib/platform/runtime-jobs');
const {MCP_TOOLS,allowedTools,assertNoSendTools}=require('../lib/platform/mcp-tools');
const {chooseSender,assessSenderHealth}=require('../lib/platform/sender-health');

test('runtime catalog mirrors eleven isolated jobs',()=>{assert.equal(runtimeJobCatalog().length,11);assert.ok(runtimeJobCatalog().find(x=>x.key==='account_health'&&x.cadenceSeconds===21600))});
test('MCP exposes fifteen tools and no send tool',()=>{assert.equal(MCP_TOOLS.length,15);assert.equal(assertNoSendTools(),true);assert.equal(allowedTools(['workspace:read']).some(x=>x.name==='workspace.get'),true)});
test('sender rotation chooses least-used healthy active sender',()=>{const s=chooseSender([{status:'active',healthStatus:'healthy',sentToday:5,connectedAt:new Date(Date.now()-70*86400000).toISOString()},{status:'active',healthStatus:'healthy',sentToday:2,connectedAt:new Date(Date.now()-70*86400000).toISOString()}]);assert.equal(s.sentToday,2)});
test('sender health degrades on bad signals',()=>{assert.equal(assessSenderHealth({bounceRate:.08}).status,'degraded')});
