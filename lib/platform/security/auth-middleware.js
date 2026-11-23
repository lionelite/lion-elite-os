'use strict';
const {bearerToken}=require('./sessions');
const {canAccessWorkspace}=require('../authorization');

function createAuthMiddleware(authStore){
  async function requireSession(req,res,next){
    try{
      const session=await authStore.resolveSession(bearerToken(req));
      if(!session) return res.status(401).json({error:'authentication required'});
      req.gtmSession=session;next();
    }catch(error){res.status(500).json({error:'authentication unavailable'})}
  }
  function requireWorkspaceRole(role='viewer'){
    return async(req,res,next)=>{
      try{
        const session=req.gtmSession||await authStore.resolveSession(bearerToken(req));
        if(!session) return res.status(401).json({error:'authentication required'});
        const membership=await authStore.getMembership(session.userId,req.params.workspaceId);
        if(!canAccessWorkspace(membership,role)) return res.status(403).json({error:'workspace access denied'});
        req.gtmSession=session;req.gtmMembership=membership;next();
      }catch(error){res.status(500).json({error:'authorization unavailable'})}
    };
  }
  return {requireSession,requireWorkspaceRole};
}
module.exports={createAuthMiddleware};
