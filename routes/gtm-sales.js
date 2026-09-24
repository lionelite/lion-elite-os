'use strict';
const express=require('express');
const db=require('../lib/database');
const {PLANS,ADDONS,CREDIT_PACKS}=require('../lib/platform/commercial-catalog');
const {createGtmCheckout,configForPlan}=require('../lib/platform/stripe-gtm-checkout');
const {verifyStripeSignature,provisionCheckout,applySubscriptionLifecycle}=require('../lib/platform/stripe-gtm-webhook');

function cleanEmail(v=''){const e=String(v).trim().toLowerCase();return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)?e:''}

function createGtmSalesRouter(){
  const router=express.Router();
  router.get('/catalog',(_req,res)=>res.json({plans:PLANS,addOns:ADDONS,creditPacks:CREDIT_PACKS}));
  router.get('/readiness',(_req,res)=>{
    const solo=configForPlan('solo'),agency=configForPlan('agency');
    res.json({checkout:{solo:solo.enabled,agency:agency.enabled},missing:{solo:solo.missing,agency:agency.missing},database:Boolean(process.env.DATABASE_URL),webhook:Boolean(process.env.GTM_STRIPE_WEBHOOK_SECRET)});
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
