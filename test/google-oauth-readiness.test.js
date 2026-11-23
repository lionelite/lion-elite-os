const test=require('node:test');const assert=require('node:assert/strict');
const {config}=require('../lib/platform/oauth/google');
const {productionReadiness}=require('../lib/platform/readiness');
test('Google OAuth config fails closed',()=>{assert.throws(()=>config({}),/not configured/)});
test('production readiness exposes booleans only',()=>{const r=productionReadiness({DATABASE_URL:'x',GTM_AUTH_EXCHANGE_SECRET:'x',GTM_OAUTH_ENCRYPTION_KEY:'x',GTM_OAUTH_CALLBACK_SECRET:'x',GTM_GOOGLE_CLIENT_ID:'x',GTM_GOOGLE_CLIENT_SECRET:'x',GTM_GOOGLE_REDIRECT_URI:'x',RESEND_API_KEY:'x',APOLLO_API_KEY:'x'});assert.equal(r.ready,true);assert.equal(typeof r.required.googleOAuth,'boolean')});
