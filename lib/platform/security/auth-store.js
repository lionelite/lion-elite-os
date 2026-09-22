'use strict';
const crypto=require('crypto');
const db=require('../../database');
const {newSessionToken,hashSessionToken}=require('./sessions');

class AuthStore{
  async issueSession(userId,{ttlHours=168,userAgent='',ip=''}={}){
    const token=newSessionToken();
    const tokenHash=hashSessionToken(token);
    const expiresAt=new Date(Date.now()+ttlHours*3600000).toISOString();
    const ipHash=ip?crypto.createHash('sha256').update(String(ip)).digest('hex'):null;
    await db.query(`INSERT INTO gtm_sessions (user_id,token_hash,user_agent,ip_hash,expires_at) VALUES ($1,$2,$3,$4,$5)`,[userId,tokenHash,userAgent,ipHash,expiresAt]);
    return {token,expiresAt};
  }
  async resolveSession(token){
    if(!token) return null;
    const result=await db.query(`SELECT s.session_id AS "sessionId",s.user_id AS "userId",u.email,u.display_name AS "displayName",s.expires_at AS "expiresAt"
      FROM gtm_sessions s JOIN gtm_users u ON u.user_id=s.user_id
      WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.status='active'`,[hashSessionToken(token)]);
    const row=result.rows[0]||null;
    if(row) await db.query('UPDATE gtm_sessions SET last_seen_at=now() WHERE session_id=$1',[row.sessionId]);
    return row;
  }
  async getMembership(userId,workspaceId){
    const r=await db.query(`SELECT workspace_id AS "workspaceId",user_id AS "userId",role,status FROM gtm_workspace_memberships WHERE user_id=$1 AND workspace_id=$2`,[userId,workspaceId]);
    return r.rows[0]||null;
  }
  async revokeSession(sessionId,userId){await db.query('UPDATE gtm_sessions SET revoked_at=now() WHERE session_id=$1 AND user_id=$2',[sessionId,userId]);return true}
}
module.exports={AuthStore};
