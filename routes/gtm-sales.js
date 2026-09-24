'use strict';
const express=require('express');
const db=require('../lib/database');
const {PLANS,ADDONS,CREDIT_PACKS}=require('../lib/platform/commercial-catalog');
const {createGtmCheckout,configForPlan}=require('../lib/platform/stripe-gtm-checkout');
const {verifyStripeSignature,provisionCheckout,applySubscriptionLifecycle}=require('../lib/platform/stripe-gtm-webhook');
const {issueLoginLink,consumeLoginLink}=require('../lib/platform/gtm-access');
const {createBillingPortal}=require('../lib/platform/stripe-billing-portal');
const {bearerToken}=require('../lib/platform/security/sessions');
const {AuthStore}=require('../lib/platform/security/auth-store');

function cleanEmail(v=''){const e=String(v).trim().toLowerCase();return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)?e:''}

function createGtmSalesRouter(){
  const router=express.Router();
  router.get('/catalog',(_req,res)=>res.json({plans:PLANS,addOns:ADDONS,creditPacks:CREDIT_PACKS}));
  router.get('/readiness',(_req,res)=>{
    const solo=configForPlan('solo'),agency=configForPlan('agency');
    const publicBaseUrl=String(process.env.PUBLIC_BASE_URL||'').trim();
    const emailFrom=String(process.env.GTM_EMAIL_FROM||process.env.COACHING_EMAIL_FROM||'').trim();
    const checks={
      database:Boolean(process.env.DATABASE_URL),
      stripeSecret:Boolean(process.env.STRIPE_SECRET_KEY),
      soloPrice:solo.enabled,
      agencyPrice:agency.enabled,
      stripeWebhook:Boolean(process.env.GTM_STRIPE_WEBHOOK_SECRET),
      resend:Boolean(process.env.RESEND_API_KEY),
      emailFrom:Boolean(emailFrom),
      publicBaseUrl:publicBaseUrl==='https://buildpipeline.online'||publicBaseUrl==='https://www.buildpipeline.online'
    };
    const missing=Object.entries(checks).filter(([,ok])=>!ok).map(([key])=>key);
    res.json({
      product:'BuildPipeline',
      launchReady:missing.length===0,
      checks,
      checkout:{solo:solo.enabled,agency:agency.enabled},
      database:checks.database,
      webhook:checks.stripeWebhook,
      missing,
      requiredBaseUrl:'https://buildpipeline.online'
    });
  });
  router.post('/lead',async(req,res)=>{
    const email=cleanEmail(req.body?.email);
    if(!email)return res.status(400).json({error:'valid email required'});
    const plan=['solo','agency','enterprise'].includes(req.body?.planInterest)?req.body.planInterest:null;
    if(process.env.DATABASE_URL){
      await db.query(`INSERT INTO gtm_sales_leads (email,company_name,website_url,plan_interest) VALUES ($1,$2,$3,$4)`,
        [email,String(req.body?.companyName||''),String(req.body?.websiteUrl||''),plan]);
    }
    res.status(201).json({ok:true});
  });
  router.post('/checkout',async(req,res)=>{
    const email=cleanEmail(req.body?.email);
    const planKey=String(req.body?.planKey||'').toLowerCase();
    if(!email)return res.status(400).json({error:'valid email required'});
    if(!['solo','agency'].includes(planKey))return res.status(400).json({error:'planKey must be solo or agency'});
    const result=await createGtmCheckout({planKey,email});
    if(!result.ok)return res.status(result.reason==='not_configured'?503:502).json(result);
    if(process.env.DATABASE_URL){
      await db.query(`INSERT INTO gtm_sales_leads (email,plan_interest,status) VALUES ($1,$2,'checkout_started')`,[email,planKey]);
    }
    res.json({url:result.url,id:result.id});
  });

  router.post('/access/request',async(req,res)=>{
    const email=cleanEmail(req.body?.email);
    if(!email)return res.status(400).json({error:'valid email required'});
    if(!process.env.DATABASE_URL)return res.status(503).json({error:'database unavailable'});
    try{await issueLoginLink(email);res.json({accepted:true})}catch(error){res.status(500).json({error:'access email unavailable'})}
  });
  router.post('/access/exchange',async(req,res)=>{
    if(!process.env.DATABASE_URL)return res.status(503).json({error:'database unavailable'});
    const session=await consumeLoginLink(String(req.body?.token||''),{userAgent:req.get('user-agent')||'',ip:req.ip||''});
    if(!session)return res.status(400).json({error:'invalid or expired access link'});
    const auth=new AuthStore();
    const me=await auth.resolveSession(session.token);
    const memberships=await auth.listMemberships(me.userId);
    res.json({sessionToken:session.token,expiresAt:session.expiresAt,user:me,workspaces:memberships});
  });
  router.post('/billing-portal',async(req,res)=>{
    if(!process.env.DATABASE_URL)return res.status(503).json({error:'database unavailable'});
    const auth=new AuthStore();
    const session=await auth.resolveSession(bearerToken(req));
    if(!session)return res.status(401).json({error:'authentication required'});
    const sub=await db.query(`SELECT provider_customer_id AS "customerId" FROM gtm_subscriptions
      WHERE lower(customer_email)=lower($1) AND provider_customer_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,[session.email]);
    const origin=String(process.env.PUBLIC_BASE_URL||'https://lion-elite-os.onrender.com').replace(/\/$/,'');
    const result=await createBillingPortal({customerId:sub.rows[0]?.customerId,returnUrl:origin+'/gtm/account/'});
    if(!result.ok)return res.status(503).json(result);
    res.json({url:result.url});
  });

  router.post('/stripe-webhook',async(req,res)=>{
    const secret=String(process.env.GTM_STRIPE_WEBHOOK_SECRET||'').trim();
    if(!secret)return res.status(503).json({error:'GTM_STRIPE_WEBHOOK_SECRET missing'});
    if(!verifyStripeSignature({rawBody:req.rawBody,signatureHeader:req.get('stripe-signature'),secret}))return res.status(401).json({error:'invalid signature'});
    if(!process.env.DATABASE_URL)return res.status(503).json({error:'DATABASE_URL required for GTM provisioning'});
    try{
      const provision=await provisionCheckout(req.body);
      const lifecycle=await applySubscriptionLifecycle(req.body);
      res.json({received:true,provision,lifecycle});
    }catch(error){
      res.status(500).json({error:'GTM provisioning failed',detail:String(error.message||error).slice(0,200)});
    }
  });
  return router;
}
module.exports={createGtmSalesRouter,cleanEmail};
