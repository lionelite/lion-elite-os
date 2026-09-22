'use strict';
const express=require('express');
const {bearerToken}=require('../lib/platform/security/sessions');
const {registerClient,issueAuthorizationCode,exchangeCode,resolveMcpToken,toolsForToken}=require('../lib/platform/mcp-oauth');

function createMcpRouter({authStore}){
  const router=express.Router();

  router.post('/register',async(req,res)=>{
    try{
      const session=await authStore.resolveSession(bearerToken(req));
      if(!session)return res.status(401).json({error:'authentication required'});
      const client=await registerClient({
        userId:session.userId,
        clientName:req.body?.clientName,
        redirectUris:Array.isArray(req.body?.redirectUris)?req.body.redirectUris:[],
        scopes:Array.isArray(req.body?.scopes)?req.body.scopes:[]
      });
      res.status(201).json(client);
    }catch(error){res.status(400).json({error:error.message})}
  });

  router.post('/authorize',async(req,res)=>{
    try{
      const session=await authStore.resolveSession(bearerToken(req));
      if(!session)return res.status(401).json({error:'authentication required'});
      const membership=await authStore.getMembership(session.userId,req.body?.workspaceId);
      if(!membership||membership.status!=='active')return res.status(403).json({error:'workspace access denied'});
      const result=await issueAuthorizationCode({
        clientId:req.body?.clientId,userId:session.userId,workspaceId:req.body?.workspaceId,
        redirectUri:req.body?.redirectUri,codeChallenge:req.body?.codeChallenge,
        scopes:Array.isArray(req.body?.scopes)?req.body.scopes:[]
      });
      res.json(result);
    }catch(error){res.status(400).json({error:error.message})}
  });

  router.post('/token',async(req,res)=>{
    try{
      const token=await exchangeCode({
        clientId:req.body?.client_id||req.body?.clientId,
        code:req.body?.code,
        codeVerifier:req.body?.code_verifier||req.body?.codeVerifier,
        redirectUri:req.body?.redirect_uri||req.body?.redirectUri
      });
      res.json({access_token:token.accessToken,token_type:token.tokenType,expires_in:token.expiresIn,scope:token.scope});
    }catch(error){res.status(400).json({error:'invalid_grant',error_description:error.message})}
  });

  router.get('/tools',async(req,res)=>{
    const token=await resolveMcpToken(bearerToken(req));
    if(!token)return res.status(401).json({error:'invalid_token'});
    res.json({workspaceId:token.workspaceId,tools:toolsForToken(token)});
  });

  return router;
}
module.exports={createMcpRouter};
