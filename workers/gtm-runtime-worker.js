'use strict';
const db=require('../lib/database');
const {RUNTIME_JOBS}=require('../lib/platform/runtime-jobs');
const {tick:signalTick}=require('./gtm-signal-worker');
const {tick:deliveryTick}=require('./gtm-delivery-worker');
const {assessSenderHealth}=require('../lib/platform/sender-health');

async function runJob(job){
  switch(job.jobKey){
    case 'checkup':{
      const r=await db.query(`SELECT
        (SELECT count(*)::int FROM gtm_signal_subscriptions WHERE status='active' AND last_error IS NOT NULL) AS "signalErrors",
        (SELECT count(*)::int FROM gtm_delivery_jobs WHERE status='dead') AS "deadDeliveries",
        (SELECT count(*)::int FROM gtm_senders WHERE status='error') AS "senderErrors"`);
      return r.rows[0];
    }
    case 'new_leads':{
      const r=await db.query(`INSERT INTO gtm_source_runs (workspace_id,campaign_id,provider,query,status)
        SELECT workspace_id,campaign_id,'apollo',jsonb_build_object('scheduled',true),'queued'
        FROM gtm_campaigns WHERE status='active'
        RETURNING source_run_id`);
      return {queued:r.rowCount};
    }
    case 'linkedin_search':{
      const r=await db.query(`SELECT count(*)::int AS count FROM gtm_linkedin_events WHERE processed_at IS NULL`);
      return {pendingEvents:r.rows[0].count};
    }
    case 'heat_scores':{
      const r=await db.query(`UPDATE gtm_prospects p SET intent_heat=LEAST(5,GREATEST(1,1+COALESCE(s.weight,0))),last_signal_at=s.last_signal_at,updated_at=now()
        FROM (
          SELECT prospect_id,SUM(weight)::int AS weight,MAX(observed_at) AS last_signal_at
          FROM gtm_signal_events WHERE prospect_id IS NOT NULL GROUP BY prospect_id
        ) s
        WHERE p.prospect_id=s.prospect_id
        RETURNING p.prospect_id`);
      return {updated:r.rowCount};
    }
    case 'queue':{
      const r=await db.query(`UPDATE gtm_prospects p SET status='queued',next_action='prepare_outreach',updated_at=now()
        FROM gtm_campaigns c
        WHERE p.campaign_id=c.campaign_id AND c.status='active'
          AND p.status IN ('discovered','qualified')
          AND p.fit_score>=60 AND p.intent_heat>=c.intent_threshold
        RETURNING p.prospect_id`);
      return {queued:r.rowCount};
    }
    case 'sender':{
      const r=await db.query(`SELECT count(*)::int AS count FROM gtm_send_attempts WHERE status='approved' AND scheduled_for<=now()`);
      return {approvedReady:r.rows[0].count};
    }
    case 'replies': return {subscriptions:await signalTick()};
    case 'grading':{
      const r=await db.query(`UPDATE gtm_prospects SET confidence=LEAST(100,GREATEST(confidence,CASE WHEN email IS NOT NULL THEN 70 ELSE 40 END)),updated_at=now()
        WHERE status IN ('discovered','qualified','queued') RETURNING prospect_id`);
      return {graded:r.rowCount};
    }
    case 'rewriting':{
      const r=await db.query(`SELECT count(*)::int AS count FROM gtm_inbox_messages WHERE direction='draft' AND status='draft' AND created_at<now()-interval '6 hours'`);
      return {staleDrafts:r.rows[0].count};
    }
    case 'account_health':{
      const senders=await db.query(`SELECT s.sender_id AS "senderId",s.workspace_id AS "workspaceId",s.status,
        EXISTS(SELECT 1 FROM gtm_sending_domains d WHERE d.sending_domain_id=s.sending_domain_id AND d.status='verified') AS "verifiedDomain",
        COALESCE((SELECT count(*) FILTER (WHERE status='failed')::float/NULLIF(count(*),0) FROM gtm_send_attempts a WHERE a.sender_id=s.sender_id AND a.created_at>now()-interval '7 days'),0) AS "failureRate"
        FROM gtm_senders s WHERE s.status IN ('warming','active','paused')`);
      let checked=0;
      for(const s of senders.rows){
        const health=assessSenderHealth({verifiedDomain:s.verifiedDomain,bounceRate:Number(s.failureRate||0),authOk:s.status!=='error'});
        await db.query(`INSERT INTO gtm_sender_health_checks (workspace_id,sender_id,status,details) VALUES ($1,$2,$3,$4)`,[s.workspaceId,s.senderId,health.status,health]);
        if(health.status!=='healthy') await db.query(`UPDATE gtm_senders SET status='paused',updated_at=now() WHERE sender_id=$1`,[s.senderId]);
        checked++;
      }
      return {checked};
    }
    case 'cleanup':{
      const a=await db.query(`DELETE FROM gtm_oauth_states WHERE expires_at<now()-interval '1 day' OR consumed_at<now()-interval '7 days'`);
      const b=await db.query(`DELETE FROM gtm_sessions WHERE expires_at<now()-interval '30 days' OR revoked_at<now()-interval '30 days'`);
      return {oauthStatesDeleted:a.rowCount,sessionsDeleted:b.rowCount};
    }
    default: throw new Error('unknown runtime job '+job.jobKey);
  }
}

function nextRunFor(def,now=new Date()){
  if(def.cadenceSeconds) return new Date(now.getTime()+def.cadenceSeconds*1000);
  const [h,m]=def.dailyTime.split(':').map(Number);
  const n=new Date(now);n.setUTCHours(h,m,0,0);if(n<=now)n.setUTCDate(n.getUTCDate()+1);return n;
}

async function ensureJobs(){
  for(const def of RUNTIME_JOBS){
    await db.query(`INSERT INTO gtm_runtime_jobs (workspace_id,job_key,cadence_seconds,daily_time,next_run_at)
      VALUES (NULL,$1,$2,$3,$4)
      ON CONFLICT DO NOTHING`,
      [def.key,def.cadenceSeconds||null,def.dailyTime||null,new Date()]);
  }
}

async function tick(){
  await ensureJobs();
  const due=await db.query(`WITH claim AS (
      SELECT runtime_job_id FROM gtm_runtime_jobs
      WHERE status='active' AND next_run_at<=now()
      ORDER BY next_run_at LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    UPDATE gtm_runtime_jobs j
    SET next_run_at=now()+interval '5 minutes',updated_at=now()
    FROM claim
    WHERE j.runtime_job_id=claim.runtime_job_id
    RETURNING j.runtime_job_id AS "runtimeJobId",j.job_key AS "jobKey",j.cadence_seconds AS "cadenceSeconds",j.daily_time AS "dailyTime"`);
  let count=0;
  for(const job of due.rows){
    const def=RUNTIME_JOBS.find(x=>x.key===job.jobKey);
    try{
      const result=await runJob(job);
      await db.query(`UPDATE gtm_runtime_jobs SET last_run_at=now(),next_run_at=$2,last_error=NULL,metadata=$3,updated_at=now() WHERE runtime_job_id=$1`,
        [job.runtimeJobId,nextRunFor(def),{lastResult:result}]);
    }catch(error){
      await db.query(`UPDATE gtm_runtime_jobs SET last_run_at=now(),next_run_at=$2,last_error=$3,updated_at=now() WHERE runtime_job_id=$1`,
        [job.runtimeJobId,nextRunFor(def),String(error.message||error)]);
    }
    count++;
  }
  await deliveryTick();
  return count;
}

async function main(){const once=process.argv.includes('--once');do{await tick();if(!once)await new Promise(r=>setTimeout(r,15000))}while(!once)}
if(require.main===module)main().catch(e=>{console.error(e);process.exit(1)});
module.exports={tick,runJob,nextRunFor,ensureJobs};
