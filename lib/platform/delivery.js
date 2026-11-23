'use strict';

function nextRetry({attemptCount,now=Date.now()}={}){
  const attempt=Math.max(0,Number(attemptCount||0));
  const delayMinutes=Math.min(360,Math.pow(2,attempt));
  return new Date(now+delayMinutes*60*1000).toISOString();
}

function transitionDelivery(job={},result={}){
  const attemptCount=Number(job.attemptCount||0)+1;
  if(result.ok) return {...job,status:'delivered',attemptCount,deliveredAt:new Date().toISOString(),lastError:null};
  if(attemptCount>=Number(job.maxAttempts||8)) return {...job,status:'dead',attemptCount,lastError:result.error||'delivery failed'};
  return {...job,status:'queued',attemptCount,nextAttemptAt:nextRetry({attemptCount}),lastError:result.error||'delivery failed'};
}

module.exports={nextRetry,transitionDelivery};
