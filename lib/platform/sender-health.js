'use strict';

function effectiveSenderCap({connectedAt,warmedAt,configuredCap=60}={}){
  const anchor=new Date(warmedAt||connectedAt||Date.now());
  const days=Math.max(0,Math.floor((Date.now()-anchor.getTime())/86400000));
  const ramp=days<7?10:days<30?20:days<60?40:60;
  return Math.min(Number(configuredCap||60),ramp);
}

function chooseSender(senders=[]){
  return [...senders]
    .filter(s=>s.status==='active'&&s.healthStatus!=='blocked')
    .filter(s=>Number(s.sentToday||0)<effectiveSenderCap(s))
    .sort((a,b)=>Number(a.sentToday||0)-Number(b.sentToday||0))[0]||null;
}

function assessSenderHealth({verifiedDomain=true,bounceRate=0,complaintRate=0,authOk=true}={}){
  const reasons=[];
  if(!verifiedDomain) reasons.push('domain_unverified');
  if(!authOk) reasons.push('auth_failed');
  if(Number(bounceRate)>0.05) reasons.push('high_bounce_rate');
  if(Number(complaintRate)>0.003) reasons.push('high_complaint_rate');
  return {status:reasons.length?'degraded':'healthy',reasons};
}
module.exports={effectiveSenderCap,chooseSender,assessSenderHealth};
