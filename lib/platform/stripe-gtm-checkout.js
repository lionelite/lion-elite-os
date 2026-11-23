'use strict';

const STRIPE_API='https://api.stripe.com/v1/checkout/sessions';
const PLAN_ENV={
  solo:'GTM_STRIPE_PRICE_SOLO_MONTHLY',
  agency:'GTM_STRIPE_PRICE_AGENCY_MONTHLY'
};

function configForPlan(planKey,env=process.env){
  const secretKey=String(env.STRIPE_SECRET_KEY||'').trim();
  const priceEnv=PLAN_ENV[planKey];
  const priceId=priceEnv?String(env[priceEnv]||'').trim():'';
  const baseUrl=String(env.PUBLIC_BASE_URL||'https://lion-elite-os.onrender.com').replace(/\/$/,'');
  const missing=[];
  if(!secretKey)missing.push('STRIPE_SECRET_KEY');
  if(!priceEnv)missing.push('VALID_PLAN_KEY');
  if(priceEnv&&!priceId)missing.push(priceEnv);
  return {secretKey,priceId,priceEnv,baseUrl,enabled:missing.length===0,missing};
}

function buildParams({priceId,baseUrl,email='',planKey}){
  const p=new URLSearchParams();
  p.set('mode','subscription');
  p.set('line_items[0][price]',priceId);
  p.set('line_items[0][quantity]','1');
  p.set('success_url',baseUrl+'/gtm/start/?checkout=success&session_id={CHECKOUT_SESSION_ID}');
  p.set('cancel_url',baseUrl+'/gtm/pricing/?checkout=cancelled');
  p.set('allow_promotion_codes','true');
  p.set('billing_address_collection','auto');
  p.set('subscription_data[metadata][product]','lionos');
  p.set('subscription_data[metadata][plan_key]',planKey);
  p.set('metadata[product]','lionos');
  p.set('metadata[plan_key]',planKey);
  if(email)p.set('customer_email',email);
  return p;
}

async function createGtmCheckout({planKey,email='',env=process.env,fetchImpl=fetch}={}){
  const cfg=configForPlan(planKey,env);
  if(!cfg.enabled)return {ok:false,reason:'not_configured',missing:cfg.missing};
  const response=await fetchImpl(STRIPE_API,{
    method:'POST',
    headers:{Authorization:'Bearer '+cfg.secretKey,'Content-Type':'application/x-www-form-urlencoded'},
    body:buildParams({priceId:cfg.priceId,baseUrl:cfg.baseUrl,email,planKey}).toString()
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok)return {ok:false,reason:'stripe_error',detail:String(data?.error?.message||('HTTP '+response.status)).slice(0,300)};
  if(!data.url)return {ok:false,reason:'stripe_error',detail:'Stripe returned no checkout URL.'};
  return {ok:true,url:data.url,id:data.id||null};
}
module.exports={PLAN_ENV,configForPlan,buildParams,createGtmCheckout};
