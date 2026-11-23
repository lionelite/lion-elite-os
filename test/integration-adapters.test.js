const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGmailMessage, GmailAdapter } = require('../lib/platform/integrations/gmail');
const { GoogleCalendarAdapter } = require('../lib/platform/integrations/calendar');
const { integrationReadiness } = require('../lib/platform/integrations');

test('normalizes Gmail message metadata', () => {
  const msg = normalizeGmailMessage({
    id:'m1', threadId:'t1', internalDate:'1720000000000', labelIds:['INBOX'],
    payload:{headers:[{name:'From',value:'maya@example.com'},{name:'Subject',value:'Interested'}],body:{data:Buffer.from('Lets talk').toString('base64url')}}
  });
  assert.equal(msg.externalId,'m1');
  assert.equal(msg.from,'maya@example.com');
  assert.equal(msg.body,'Lets talk');
});

test('Gmail adapter fails closed without credentials', async () => {
  const adapter = new GmailAdapter();
  await assert.rejects(() => adapter.listRecentInbound(), /not configured/);
});

test('calendar adapter fails closed without credentials', async () => {
  const adapter = new GoogleCalendarAdapter();
  await assert.rejects(() => adapter.listBusy({timeMin:new Date().toISOString(),timeMax:new Date(Date.now()+3600000).toISOString()}), /not configured/);
});

test('readiness reflects configured providers', () => {
  assert.deepEqual(integrationReadiness({GTM_GMAIL_ACCESS_TOKEN:'x'}), {gmail:true,googleCalendar:false,calendly:false});
});
