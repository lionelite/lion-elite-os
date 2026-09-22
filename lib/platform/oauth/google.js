'use strict';
const crypto=require('crypto');
const db=require('../../database');
const {encrypt,decrypt}=require('../security/crypto-vault');

const GOOGLE_AUTH_URL='https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL='https://oauth2.googleapis.com/token';

function config(env=process.env){
  const clientId=String(env.GTM_GOOGLE_CLIENT_ID||'').trim();
  const clientSecret=String(env.GTM_GOOGLE_CLIENT_SECRET||'').trim();
  const redirectUri=String(env.GTM_GOOGLE_REDIRECT_URI||'').trim();
  if(!clientId||!clientSecret||!redirectUri) throw new Error('Google OAuth is not configured');
  return {clientId,clientSecret,redirectUri};
}
function sha256Base64url(value){return crypto.createHash('sha256').update(value).digest('base64url')}
function randomToken(bytes=32){return crypto.randomBytes(bytes).toString('base64url')}

async function beginGoogleOAuth({workspaceId,userId,env=process.env}){
  const {clientId,redirectUri}=config(env);
  const state=randomToken(32),verifier=randomToken(48),challenge=sha256Base64url(verifier);
  const stateHash=crypto.createHash('sha256').update(state).digest('hex');
  const expiresAt=new Date(Date.now()+10*60*1000).toISOString();
  await db.query(`INSERT INTO gtm_oauth_states (workspace_id,user_id,provider,state_hash,redirect_uri,code_verifier_ciphertext,expires_at)
    VALUES ($1,$2,'google',$3,$4,$5,$6)`,[workspaceId,userId,stateHash,redirectUri,encrypt(verifier),expiresAt]);
  const scopes=[
    'openid','email',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/calendar'
  ];
  const url=new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id',clientId);
  url.searchParams.set('redirect_uri',redirectUri);
  url.searchParams.set('response_type','code');
  url.searchParams.set('scope',scopes.join(' '));
  url.searchParams.set('access_type','offline');
  url.searchParams.set('prompt','consent');
  url.searchParams.set('include_granted_scopes','true');
  url.searchParams.set('state',state);
  url.searchParams.set('code_challenge',challenge);
  url.searchParams.set('code_challenge_method','S256');
  return {url:url.toString(),expiresAt};
}

async function exchangeGoogleOAuth({state,code,env=process.env,fetchImpl=fetch}){
  const {clientId,clientSecret,redirectUri}=config(env);
  const stateHash=crypto.createHash('sha256').update(String(state||'')).digest('hex');
  const r=await db.query(`SELECT oauth_state_id AS "oauthStateId",workspace_id AS "workspaceId",user_id AS "userId",code_verifier_ciphertext AS "codeVerifierCiphertext"
    FROM gtm_oauth_states
    WHERE provider='google' AND state_hash=$1 AND consumed_at IS NULL AND expires_at>now()`,[stateHash]);
  const row=r.rows[0];if(!row) throw new Error('invalid or expired OAuth state');
  const body=new URLSearchParams({
    code:String(code||''),client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri,
    grant_type:'authorization_code',code_verifier:decrypt(row.codeVerifierCiphertext)
  });
  const response=await fetchImpl(GOOGLE_TOKEN_URL,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString()});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error_description||data.error||'Google OAuth token exchange failed');
  await db.query('UPDATE gtm_oauth_states SET consumed_at=now() WHERE oauth_state_id=$1',[row.oauthStateId]);
  return {workspaceId:row.workspaceId,userId:row.userId,tokens:data};
}
module.exports={beginGoogleOAuth,exchangeGoogleOAuth,config};
