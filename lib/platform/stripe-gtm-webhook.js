'use strict';
const {verifyStripeSignature}=require('../coaching/stripe-webhook');
const db=require('../database');

function eventPlan(session={}){
  return String(session.metadata?.plan_key||session.subscription_details?.metadata?.plan_key||'').toLowerCase();
}
async function provisionCheckout(event){
  if(event?.type!=='checkout.session.completed')return {status:'ignored'};
  const s=event.data?.object||{};
  if(s.metadata?.product!=='lionos')return {status:'ignored'};
  const email=String(s.customer_details?.email||s.customer_email||'').trim().toLowerCase();
  const plan=eventPlan(s);
  if(!email||!['solo','agency'].includes(plan))return {status:'failed',detail:'missing LionOS email or plan'};
  const allowance=plan==='agency'?{data:6000,action:12000}:{data:3000,action:5000};
  return db.withTransaction(async client=>{
    let user=await client.query(`SELECT user_id FROM gtm_users WHERE lower(email)=lower($1) LIMIT 1`,[email]);
    let userId=user.rows[0]?.user_id;
    if(!userId){
      const r=await client.query(`INSERT INTO gtm_users (email,display_name,status) VALUES ($1,'','active') RETURNING user_id`,[email]);
      userId=r.rows[0].user_id;
    }
    let workspace=await client.query(`SELECT w.workspace_id FROM gtm_workspaces w
      JOIN gtm_workspace_memberships m ON m.workspace_id=w.workspace_id
      WHERE m.user_id=$1 AND m.role='owner' ORDER BY w.created_at LIMIT 1`,[userId]);
    let workspaceId=workspace.rows[0]?.workspace_id;
    if(!workspaceId){
      const w=await client.query(`INSERT INTO gtm_workspaces (name,slug,plan,data_credit_allowance,action_credit_allowance)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING workspace_id`,
        [email.split('@')[0]+' workspace','ws-'+Date.now().toString(36),plan,allowance.data,allowance.action]);
      workspaceId=w.rows[0].workspace_id;
      await client.query(`INSERT INTO gtm_workspace_memberships (workspace_id,user_id,role,status) VALUES ($1,$2,'owner','active')`,[workspaceId,userId]);
    }else{
      await client.query(`UPDATE gtm_workspaces SET plan=$2,data_credit_allowance=$3,action_credit_allowance=$4,updated_at=now() WHERE workspace_id=$1`,
        [workspaceId,plan,allowance.data,allowance.action]);
    }
    const sub=await client.query(`INSERT INTO gtm_subscriptions
      (workspace_id,customer_email,plan_key,provider_customer_id,provider_subscription_id,provider_checkout_id,status)
      VALUES ($1,$2,$3,$4,$5,$6,'active')
      ON CONFLICT (provider_checkout_id) DO UPDATE SET status='active',workspace_id=EXCLUDED.workspace_id,updated_at=now()
      RETURNING gtm_subscription_id AS "subscriptionId",workspace_id AS "workspaceId",plan_key AS "planKey",status`,
      [workspaceId,email,plan,s.customer||null,s.subscription||null,s.id||null]);
    await client.query(`UPDATE gtm_sales_leads SET status='paid',updated_at=now() WHERE lower(email)=lower($1) AND status IN ('new','checkout_started')`,[email]);
    return {status:'provisioned',subscription:sub.rows[0],email};
  });
}

async function applySubscriptionLifecycle(event){
  const type=event?.type;
  if(!['customer.subscription.deleted','invoice.payment_failed','invoice.payment_succeeded','invoice.paid'].includes(type))return {status:'ignored'};
  const o=event.data?.object||{};
  const subscriptionId=String(o.subscription||o.id||'');
  if(!subscriptionId)return {status:'ignored'};
  const status=type==='customer.subscription.deleted'?'cancelled':type==='invoice.payment_failed'?'past_due':'active';
  const r=await db.query(`UPDATE gtm_subscriptions SET status=$2,updated_at=now() WHERE provider_subscription_id=$1
    RETURNING workspace_id AS "workspaceId",status`,[subscriptionId,status]);
  if(!r.rows[0])return {status:'unmatched'};
  return {status:'applied',workspaceId:r.rows[0].workspaceId,subscriptionStatus:status};
}

module.exports={verifyStripeSignature,provisionCheckout,applySubscriptionLifecycle,eventPlan};
