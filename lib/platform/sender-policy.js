'use strict';

function dailyCapForAge(daysActive){
  const d=Math.max(0,Number(daysActive||0));
  if(d<7) return 10;
  if(d<30) return 20;
  if(d<60) return 40;
  return 60;
}

function withinSendWindow({now=new Date(),start='09:00',end='17:00'}={}){
  const [sh,sm]=start.split(':').map(Number),[eh,em]=end.split(':').map(Number);
  const mins=now.getHours()*60+now.getMinutes();
  return mins>=sh*60+sm && mins<eh*60+em;
}

function evaluateSend({
  sender,
  sentToday=0,
  prospect={},
  message={},
  compliance={},
  now=new Date()
}={}){
  const blockers=[];
  if(!sender||!['warming','active'].includes(sender.status)) blockers.push('sender_inactive');
  if(sender&&sentToday>=Number(sender.dailyCap||0)) blockers.push('daily_cap_reached');
  if(sender&&!withinSendWindow({now,start:sender.sendWindowStart||'09:00',end:sender.sendWindowEnd||'17:00'})) blockers.push('outside_send_window');
  if(prospect.status==='replied') blockers.push('reply_stops_sequence');
  if(prospect.status==='suppressed') blockers.push('suppressed');
  if(prospect.optedOut) blockers.push('opt_out');
  if(compliance.evidenceRequired && !message.evidenceBacked) blockers.push('missing_evidence');
  if(compliance.noInventedClaims!==false && message.hasInventedClaims) blockers.push('invented_claim');
  if(compliance.requireReachableContact!==false && !message.to) blockers.push('missing_recipient');
  return {allowed:blockers.length===0,blockers};
}

module.exports={dailyCapForAge,withinSendWindow,evaluateSend};
