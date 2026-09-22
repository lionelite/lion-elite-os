const test=require('node:test');const assert=require('node:assert/strict');
const {dailyCapForAge,evaluateSend}=require('../lib/platform/sender-policy');
const {importRows}=require('../lib/platform/csv-import');

test('sender ramp grows conservatively with age',()=>{assert.equal(dailyCapForAge(0),10);assert.equal(dailyCapForAge(10),20);assert.equal(dailyCapForAge(35),40);assert.equal(dailyCapForAge(90),60)});
test('send gate blocks reply, cap, and unsupported copy',()=>{const r=evaluateSend({sender:{status:'active',dailyCap:10,sendWindowStart:'00:00',sendWindowEnd:'23:59'},sentToday:10,prospect:{status:'replied'},message:{to:'x@y.com',evidenceBacked:false,hasInventedClaims:true},compliance:{evidenceRequired:true},now:new Date('2026-09-22T12:00:00')});assert.equal(r.allowed,false);assert.ok(r.blockers.includes('daily_cap_reached'));assert.ok(r.blockers.includes('reply_stops_sequence'));assert.ok(r.blockers.includes('missing_evidence'));assert.ok(r.blockers.includes('invented_claim'))});
test('CSV import skips ICP fit gate by default but still requires reachability',()=>{const r=importRows([{Email:'a@x.com',Name:'A'},{Email:'',Name:'B'}],{email:'Email',contactName:'Name'});assert.equal(r.accepted.length,1);assert.equal(r.accepted[0].fitGateSkipped,true);assert.equal(r.rejected.length,1)});
