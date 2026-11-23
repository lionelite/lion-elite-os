'use strict';

function buildInsights({prospects=[],meetings=[],usage=[]}={}){
  const sourced=prospects.length;
  const contacted=prospects.filter(p=>['contacted','replied','meeting','opportunity','won','lost'].includes(p.status)).length;
  const replied=prospects.filter(p=>['replied','meeting','opportunity','won','lost'].includes(p.status)).length;
  const booked=prospects.filter(p=>['meeting','opportunity','won','lost'].includes(p.status)).length || meetings.filter(m=>m.status==='booked').length;
  const byAction={};
  for(const row of usage){const key=row.actionKey||row.action_key||'unknown';if(!byAction[key])byAction[key]={credits:0,count:0};byAction[key].credits+=Number(row.credits||0);byAction[key].count+=Number(row.quantity||1)}
  return {
    funnel:{sourced,contacted,replied,booked},
    rates:{
      contactRate:sourced?contacted/sourced:0,
      replyRate:contacted?replied/contacted:0,
      bookingRate:replied?booked/replied:0
    },
    usage:byAction
  };
}

module.exports={buildInsights};
