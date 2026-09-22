'use strict';
const crypto=require('crypto');
const db=require('../../database');
const {newSessionToken,hashSessionToken}=require('./sessions');

class AuthStore{
  async upsertUser({email,displayName=''}) {
    if(!email) throw new Error('email is required');
    const r=await db.query(`INSERT INTO gtm_users (email,display_name) VALUES ($1,$2)
      ON CONFLICT (lower(email)) DO UPDATE SET display_name=EXCLUDED.display_name,updated_at=now()
      RETURNING user_id AS "userId",email,display_name AS "displayName",status`,[String(email).trim().toLowerCase(),String(displayName||'')]);
    return r.rows[0];
  }
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
  async ensureMembership(userId,workspaceId,role='owner'){
    const r=await db.query(`INSERT INTO gtm_workspace_memberships (workspace_id,user_id,role,status)
      VALUES ($1,$2,$3,'active')
      ON CONFLICT (workspace_id,user_id) DO UPDATE SET status='active'
      RETURNING workspace_id AS "workspaceId",user_id AS "userId",role,status`,[workspaceId,userId,role]);
    return r.rows[0];
  }
  async listMemberships(userId){
    const r=await db.query(`SELECT m.workspace_id AS "workspaceId",m.role,m.status,w.name,w.slug,w.plan
      FROM gtm_workspace_memberships m JOIN gtm_workspaces w ON w.workspace_id=m.workspace_id
      WHERE m.user_id=$1 AND m.status='active' ORDER BY w.created_at DESC`,[userId]);
    return r.rows;
  }
  async revokeSession(sessionId,userId){await db.query('UPDATE gtm_sessions SET revoked_at=now() WHERE session_id=$1 AND user_id=$2',[sessionId,userId]);return true}
}
module.exports={AuthStore};
