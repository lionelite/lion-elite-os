const test=require('node:test');const assert=require('node:assert/strict');
const {classifyReply,draftReply}=require('../lib/platform/reply-assistant');
test('classifies common reply intent',()=>{assert.equal(classifyReply('Sounds good, lets book a call'),'interested');assert.equal(classifyReply('How much does it cost?'),'pricing');assert.equal(classifyReply('Please stop emailing me'),'opt_out')});
test('drafts a booking-oriented response',()=>{const d=draftReply({classification:'interested',contactName:'Maya',bookingUrl:'https://cal.example'});assert.match(d,/Maya/);assert.match(d,/https:\/\/cal.example/)});
