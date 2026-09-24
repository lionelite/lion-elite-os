'use strict';
async function createBillingPortal({customerId,returnUrl,fetchImpl=fetch,env=process.env}={}){
  const key=String(env.STRIPE_SECRET_KEY||'').trim();
  if(!key)return {ok:false,reason:'not_configured'};
  if(!customerId)return {ok:false,reason:'missing_customer'};
  const p=new URLSearchParams();p.set('customer',customerId);p.set('return_url',returnUrl);
  const r=await fetchImpl('https://api.stripe.com/v1/billing_portal/sessions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/x-www-form-urlencoded'},body:p.toString()});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)return {ok:false,reason:'stripe_error',detail:String(j?.error?.message||('HTTP '+r.status)).slice(0,250)};
  return {ok:true,url:j.url};
}
module.exports={createBillingPortal};
