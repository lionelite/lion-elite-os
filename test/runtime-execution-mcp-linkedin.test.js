const test=require('node:test');const assert=require('node:assert/strict');
const {challenge}=require('../lib/platform/mcp-oauth');
const {LinkedInProviderAdapter}=require('../lib/platform/integrations/linkedin-provider');
const {nextRunFor}=require('../workers/gtm-runtime-worker');

test('PKCE challenge is deterministic S256 base64url',()=>{assert.equal(challenge('abc'),challenge('abc'));assert.notEqual(challenge('abc'),'abc')});
test('LinkedIn provider fails closed without config',async()=>{const p=new LinkedInProviderAdapter();await assert.rejects(()=>p.pollSignals(),/not configured/)});
test('LinkedIn action requires compliance approval',async()=>{const p=new LinkedInProviderAdapter({baseUrl:'https://provider.test',token:'x',fetchImpl:async()=>({ok:true,json:async()=>({id:'a1'})})});await assert.rejects(()=>p.execute({complianceSnapshot:{allowed:false}}),/blocked by compliance gate/)});
test('daily runtime jobs schedule into the future',()=>{const now=new Date('2026-09-22T09:00:00Z');const next=nextRunFor({dailyTime:'08:00'},now);assert.ok(next>now)});
