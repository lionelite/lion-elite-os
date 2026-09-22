'use strict';
const db=require('../lib/database');
const {LinkedInProviderAdapter}=require('../lib/platform/integrations/linkedin-provider');

function providerFromEnv(){
  return new LinkedInProviderAdapter({
    baseUrl:process.env.GTM_LINKEDIN_PROVIDER_URL,
    token:process.env.GTM_LINKEDIN_PROVIDER_TOKEN
  });
}

async function pollSignals(provider){
  const connections=await db.query(`SELECT linkedin_connection_id AS "connectionId",workspace_id AS "workspaceId",provider,cursor
    FROM gtm_linkedin_connections WHERE status IN ('connected','degraded') ORDER BY updated_at LIMIT 50`);
  let ingested=0;
  for(const c of connections.rows){
    try{
      const result=await provider.pollSignals({cursor:c.cursor,limit:100});
      const events=Array.isArray(result.events)?result.events:[];
      for(const e of events){
        if(!e.id||!e.type) continue;
        let prospectId=null,campaignId=null;
        if(e.email){
          const p=await db.query(`SELECT prospect_id,campaign_id FROM gtm_prospects WHERE workspace_id=$1 AND lower(email)=lower($2) ORDER BY created_at DESC LIMIT 1`,[c.workspaceId,e.email]);
          prospectId=p.rows[0]?.prospect_id||null;campaignId=p.rows[0]?.campaign_id||null;
        }
        const ins=await db.query(`INSERT INTO gtm_linkedin_events (workspace_id,campaign_id,prospect_id,provider,external_event_id,event_type,payload)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (workspace_id,provider,external_event_id) DO NOTHING
          RETURNING linkedin_event_id`,
          [c.workspaceId,campaignId,prospectId,c.provider,String(e.id),String(e.type),e]);
        if(ins.rows[0]){
          await db.query(`INSERT INTO gtm_signal_events (workspace_id,campaign_id,prospect_id,provider,signal_type,external_event_id,weight,evidence,observed_at)
            VALUES ($1,$2,$3,'linkedin',$4,$5,$6,$7,COALESCE($8::timestamptz,now()))
            ON CONFLICT (workspace_id,provider,external_event_id) DO NOTHING`,
            [c.workspaceId,campaignId,prospectId,String(e.type),'linkedin:'+String(e.id),Number(e.weight||1),e,e.observedAt||null]);
          ingested++;
        }
      }
      await db.query(`UPDATE gtm_linkedin_connections SET cursor=$2,last_polled_at=now(),last_success_at=now(),last_error=NULL,status='connected',updated_at=now() WHERE linkedin_connection_id=$1`,
        [c.connectionId,result.nextCursor||c.cursor||null]);
    }catch(error){
      await db.query(`UPDATE gtm_linkedin_connections SET last_polled_at=now(),last_error=$2,status='degraded',updated_at=now() WHERE linkedin_connection_id=$1`,
        [c.connectionId,String(error.message||error)]);
    }
  }
  return ingested;
}

async function processActions(provider){
  const r=await db.query(`SELECT channel_action_request_id AS "actionRequestId",workspace_id AS "workspaceId",campaign_id AS "campaignId",
    prospect_id AS "prospectId",action_type AS "actionType",payload,compliance_snapshot AS "complianceSnapshot"
    FROM gtm_channel_action_requests WHERE channel='linkedin' AND status='queued' ORDER BY created_at LIMIT 25`);
  let processed=0;
  for(const action of r.rows){
    try{
      if(!action.complianceSnapshot?.allowed){
        await db.query(`UPDATE gtm_channel_action_requests SET status='blocked',last_error='compliance gate blocked action',updated_at=now() WHERE channel_action_request_id=$1`,[action.actionRequestId]);
        continue;
      }
      await db.query(`UPDATE gtm_channel_action_requests SET status='processing',updated_at=now() WHERE channel_action_request_id=$1`,[action.actionRequestId]);
      const out=await provider.execute(action);
      await db.query(`UPDATE gtm_channel_action_requests SET status='completed',provider='configured_provider',external_action_id=$2,last_error=NULL,updated_at=now() WHERE channel_action_request_id=$1`,
        [action.actionRequestId,out.id||out.actionId||null]);
      processed++;
    }catch(error){
      await db.query(`UPDATE gtm_channel_action_requests SET status='failed',last_error=$2,updated_at=now() WHERE channel_action_request_id=$1`,
        [action.actionRequestId,String(error.message||error)]);
    }
  }
  return processed;
}

async function tick(){
  const provider=providerFromEnv();
  provider.assertConfigured();
  const [signals,actions]=await Promise.all([pollSignals(provider),processActions(provider)]);
  return {signals,actions};
}
async function main(){
  const once=process.argv.includes('--once');
  do{
    if(String(process.env.GTM_LINKEDIN_WORKER_ENABLED||'').toLowerCase()==='true'){
      try{await tick()}catch(error){console.error('LinkedIn worker tick failed:',error.message||error)}
    }else{
      console.log('LinkedIn worker disabled; set GTM_LINKEDIN_WORKER_ENABLED=true after provider credentials are configured.');
    }
    if(!once)await new Promise(r=>setTimeout(r,60000));
  }while(!once)
}
if(require.main===module)main().catch(e=>{console.error(e);process.exit(1)});
module.exports={tick,pollSignals,processActions};
