'use strict';
const db=require('../lib/database');
const {decrypt}=require('../lib/platform/security/crypto-vault');
const {headersForWebhook}=require('../lib/platform/webhook-signing');
const {transitionDelivery}=require('../lib/platform/delivery');

async function deliverWebhook(job,endpoint,fetchImpl=fetch){
  const body=JSON.stringify(job.payload||{});
  const secret=decrypt(endpoint.signingSecretCiphertext);
  const headers=headersForWebhook({secret,body});
  const response=await fetchImpl(endpoint.url,{method:'POST',headers,body});
  if(!response.ok) return {ok:false,error:'HTTP '+response.status+' '+await response.text()};
  return {ok:true};
}

async function tick({fetchImpl=fetch}={}){
  const due=await db.query(`SELECT delivery_job_id AS "deliveryJobId",workspace_id AS "workspaceId",destination,event_type AS "eventType",payload,status,attempt_count AS "attemptCount",max_attempts AS "maxAttempts"
    FROM gtm_delivery_jobs WHERE status IN ('queued','failed') AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 50`);
  for(const job of due.rows){
    try{
      const match=String(job.destination||'').match(/^webhook:(.+)$/);
      if(!match) throw new Error('unsupported destination '+job.destination);
      const e=await db.query(`SELECT webhook_endpoint_id AS "webhookEndpointId",url,signing_secret_ciphertext AS "signingSecretCiphertext",enabled
        FROM gtm_webhook_endpoints WHERE workspace_id=$1 AND webhook_endpoint_id=$2`,[job.workspaceId,match[1]]);
      const endpoint=e.rows[0];if(!endpoint||!endpoint.enabled) throw new Error('webhook endpoint unavailable');
      await db.query(`UPDATE gtm_delivery_jobs SET status='processing',updated_at=now() WHERE delivery_job_id=$1`,[job.deliveryJobId]);
      const result=await deliverWebhook(job,endpoint,fetchImpl);
      const next=transitionDelivery(job,result);
      await db.query(`UPDATE gtm_delivery_jobs SET status=$2,attempt_count=$3,next_attempt_at=COALESCE($4::timestamptz,next_attempt_at),last_error=$5,delivered_at=COALESCE($6::timestamptz,delivered_at),updated_at=now() WHERE delivery_job_id=$1`,
        [job.deliveryJobId,next.status,next.attemptCount,next.nextAttemptAt||null,next.lastError||null,next.deliveredAt||null]);
      await db.query(`UPDATE gtm_webhook_endpoints SET last_delivery_at=CASE WHEN $3 THEN now() ELSE last_delivery_at END,last_error=CASE WHEN $3 THEN NULL ELSE $4 END,updated_at=now() WHERE workspace_id=$1 AND webhook_endpoint_id=$2`,
        [job.workspaceId,endpoint.webhookEndpointId,result.ok,result.error||null]);
    }catch(error){
      const next=transitionDelivery(job,{ok:false,error:String(error.message||error)});
      await db.query(`UPDATE gtm_delivery_jobs SET status=$2,attempt_count=$3,next_attempt_at=COALESCE($4::timestamptz,next_attempt_at),last_error=$5,updated_at=now() WHERE delivery_job_id=$1`,
        [job.deliveryJobId,next.status,next.attemptCount,next.nextAttemptAt||null,next.lastError||null]);
    }
  }
  return due.rows.length;
}

async function main(){const once=process.argv.includes('--once');do{await tick();if(!once)await new Promise(r=>setTimeout(r,15000))}while(!once)}
if(require.main===module)main().catch(e=>{console.error(e);process.exit(1)});
module.exports={tick,deliverWebhook};
