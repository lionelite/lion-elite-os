'use strict';
const db=require('../lib/database');
const {OAuthStore}=require('../lib/platform/oauth-store');
const {GmailAdapter}=require('../lib/platform/integrations/gmail');
const {classifyReply}=require('../lib/platform/reply-assistant');

const oauthStore=new OAuthStore();
function extractEmail(value=''){const m=String(value).match(/<([^>]+)>/);return String(m?m[1]:value).trim().toLowerCase()}

async function processGmail(subscription){
  const credential=await oauthStore.get(subscription.workspaceId,'gmail',null);
  if(!credential) throw new Error('gmail oauth credential not found');
  const gmail=new GmailAdapter({accessToken:credential.accessToken});
  const after=subscription.lastPolledAt?Math.floor(new Date(subscription.lastPolledAt).getTime()/1000):Math.floor((Date.now()-3600000)/1000);
  const messages=await gmail.listRecentInbound({afterEpochSeconds:after,maxResults:50});
  let matched=0;
  for(const message of messages){
    const email=extractEmail(message.from);
    if(!email) continue;
    const p=await db.query(`SELECT prospect_id AS "prospectId",campaign_id AS "campaignId" FROM gtm_prospects WHERE workspace_id=$1 AND lower(email)=$2 ORDER BY created_at DESC LIMIT 1`,[subscription.workspaceId,email]);
    const prospect=p.rows[0];if(!prospect) continue;
    const externalEventId='gmail:'+String(message.externalId||'');
    const inserted=await db.query(`INSERT INTO gtm_signal_events (workspace_id,campaign_id,prospect_id,provider,signal_type,external_event_id,weight,evidence,observed_at)
      VALUES ($1,$2,$3,'gmail','reply',$4,2,$5,COALESCE($6::timestamptz,now()))
      ON CONFLICT (workspace_id,provider,external_event_id) DO NOTHING RETURNING signal_event_id`,
      [subscription.workspaceId,prospect.campaignId,prospect.prospectId,externalEventId,{subject:message.subject,from:message.from,threadExternalId:message.threadExternalId},message.receivedAt]);
    if(!inserted.rows[0]) continue;
    const classification=classifyReply(message.body||message.subject||'');
    await db.withTransaction(async client=>{
      const nextStatus=classification==='opt_out'?'suppressed':'replied';
      const nextAction=classification==='opt_out'?null:(classification==='interested'?'book_meeting':'review_reply');
      await client.query(`UPDATE gtm_prospects SET status=$3,replied_at=COALESCE($4::timestamptz,now()),intent_heat=5,next_action=$5,updated_at=now() WHERE workspace_id=$1 AND prospect_id=$2`,
        [subscription.workspaceId,prospect.prospectId,nextStatus,message.receivedAt,nextAction]);
      const existing=await client.query(`SELECT thread_id FROM gtm_inbox_threads WHERE workspace_id=$1 AND prospect_id=$2 AND status IN ('open','waiting') ORDER BY created_at DESC LIMIT 1`,[subscription.workspaceId,prospect.prospectId]);
      let threadId=existing.rows[0]?.thread_id;
      if(!threadId){
        const t=await client.query(`INSERT INTO gtm_inbox_threads (workspace_id,prospect_id,campaign_id,channel,status,classification,latest_message_at)
          VALUES ($1,$2,$3,'email','open',$4,COALESCE($5::timestamptz,now())) RETURNING thread_id`,
          [subscription.workspaceId,prospect.prospectId,prospect.campaignId,classification,message.receivedAt]);
        threadId=t.rows[0].thread_id;
      }
      await client.query(`INSERT INTO gtm_inbox_messages (workspace_id,thread_id,direction,sender,body,status) VALUES ($1,$2,'inbound',$3,$4,'received')`,
        [subscription.workspaceId,threadId,message.from,message.body||message.subject||'']);
    });
    matched++;
  }
  return {messages:messages.length,matched};
}

async function tick(){
  const due=await db.query(`SELECT signal_subscription_id AS "subscriptionId",workspace_id AS "workspaceId",campaign_id AS "campaignId",provider,signal_type AS "signalType",config,poll_interval_seconds AS "pollIntervalSeconds",last_polled_at AS "lastPolledAt"
    FROM gtm_signal_subscriptions WHERE status='active' AND next_poll_at<=now() ORDER BY next_poll_at LIMIT 25`);
  for(const sub of due.rows){
    try{
      if(sub.provider==='gmail'&&sub.signalType==='reply') await processGmail(sub);
      else throw new Error('unsupported signal subscription '+sub.provider+':'+sub.signalType);
      await db.query(`UPDATE gtm_signal_subscriptions SET last_polled_at=now(),next_poll_at=now()+make_interval(secs=>$2),last_error=NULL,updated_at=now() WHERE signal_subscription_id=$1`,[sub.subscriptionId,Math.max(60,sub.pollIntervalSeconds||60)]);
    }catch(error){
      await db.query(`UPDATE gtm_signal_subscriptions SET last_polled_at=now(),next_poll_at=now()+interval '5 minutes',last_error=$2,status='active',updated_at=now() WHERE signal_subscription_id=$1`,[sub.subscriptionId,String(error.message||error)]);
    }
  }
  return due.rows.length;
}

async function main(){if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');const once=process.argv.includes('--once');do{await tick();if(!once)await new Promise(r=>setTimeout(r,15000))}while(!once)}
if(require.main===module)main().catch(e=>{console.error(e);process.exit(1)});
module.exports={tick,processGmail,extractEmail};
