'use strict';
const crypto=require('crypto');
const db=require('../database');
const {allowedTools}=require('./mcp-tools');

function randomToken(bytes=32){return crypto.randomBytes(bytes).toString('base64url')}
function hash(value){return crypto.createHash('sha256').update(String(value||'')).digest('hex')}
function challenge(verifier){return crypto.createHash('sha256').update(String(verifier||'')).digest('base64url')}

async function registerClient({userId,clientName,redirectUris=[],scopes=[]}){
  if(!userId||!clientName) throw new Error('userId and clientName are required');
  const clientId='lionos_'+randomToken(18);
  const r=await db.query(`INSERT INTO gtm_mcp_clients (user_id,client_name,client_id,scopes)
    VALUES ($1,$2,$3,$4)
    RETURNING client_id AS "clientId",client_name AS "clientName",scopes,status`,
    [userId,clientName,clientId,{allowedScopes:scopes,redirectUris}]);
  return r.rows[0];
}

async function issueAuthorizationCode({clientId,userId,workspaceId,redirectUri,codeChallenge,scopes=[]}){
  const c=await db.query(`SELECT client_id AS "clientId",user_id AS "userId",scopes,status FROM gtm_mcp_clients WHERE client_id=$1 AND user_id=$2 AND status='active'`,[clientId,userId]);
  if(!c.rows[0]) throw new Error('MCP client not found');
  const cfg=c.rows[0].scopes||{};
  const redirects=Array.isArray(cfg.redirectUris)?cfg.redirectUris:[];
  if(!redirects.includes(redirectUri)) throw new Error('redirect_uri not registered');
  const allowed=new Set(Array.isArray(cfg.allowedScopes)?cfg.allowedScopes:[]);
  const requested=scopes.filter(s=>allowed.has(s));
  if(!requested.length) throw new Error('no permitted MCP scopes requested');
  const code=randomToken(32);
  await db.query(`INSERT INTO gtm_mcp_auth_codes (client_id,user_id,workspace_id,code_hash,redirect_uri,code_challenge,scopes,expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')`,
    [clientId,userId,workspaceId,hash(code),redirectUri,codeChallenge,requested]);
  return {code,scopes:requested};
}

async function exchangeCode({clientId,code,codeVerifier,redirectUri}){
  const r=await db.query(`SELECT mcp_auth_code_id AS "authCodeId",user_id AS "userId",workspace_id AS "workspaceId",redirect_uri AS "redirectUri",code_challenge AS "codeChallenge",scopes
    FROM gtm_mcp_auth_codes WHERE client_id=$1 AND code_hash=$2 AND consumed_at IS NULL AND expires_at>now()`,[clientId,hash(code)]);
  const row=r.rows[0];if(!row) throw new Error('invalid or expired authorization code');
  if(row.redirectUri!==redirectUri) throw new Error('redirect_uri mismatch');
  if(challenge(codeVerifier)!==row.codeChallenge) throw new Error('PKCE verification failed');
  const token=randomToken(32),tokenHash=hash(token),expiresIn=3600;
  await db.withTransaction(async client=>{
    await client.query('UPDATE gtm_mcp_auth_codes SET consumed_at=now() WHERE mcp_auth_code_id=$1',[row.authCodeId]);
    await client.query(`INSERT INTO gtm_mcp_access_tokens (client_id,user_id,workspace_id,token_hash,scopes,expires_at)
      VALUES ($1,$2,$3,$4,$5,now()+interval '1 hour')`,[clientId,row.userId,row.workspaceId,tokenHash,row.scopes]);
  });
  return {accessToken:token,tokenType:'Bearer',expiresIn,scope:row.scopes.join(' ')};
}

async function resolveMcpToken(token){
  if(!token) return null;
  const r=await db.query(`SELECT client_id AS "clientId",user_id AS "userId",workspace_id AS "workspaceId",scopes,expires_at AS "expiresAt"
    FROM gtm_mcp_access_tokens WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()`,[hash(token)]);
  const row=r.rows[0]||null;
  if(row) await db.query('UPDATE gtm_mcp_access_tokens SET last_used_at=now() WHERE token_hash=$1',[hash(token)]);
  return row;
}

function toolsForToken(tokenRow){return tokenRow?allowedTools(tokenRow.scopes||[]):[]}

module.exports={registerClient,issueAuthorizationCode,exchangeCode,resolveMcpToken,toolsForToken,challenge};
