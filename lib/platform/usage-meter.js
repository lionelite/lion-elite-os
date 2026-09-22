'use strict';

const ACTION_COSTS=Object.freeze({
  'enrich.reveal':{purse:'data',credits:30},
  'company.enrich':{purse:'data',credits:10},
  'company.scrape':{purse:'data',credits:10},
  'intent.reactions':{purse:'data',credits:1},
  'research.premium':{purse:'action',credits:75},
  'research.standard':{purse:'action',credits:40},
  'icp.build.premium':{purse:'action',credits:16},
  'icp.build.standard':{purse:'action',credits:8},
  'ai.message.premium':{purse:'action',credits:4},
  'ai.reply.premium':{purse:'action',credits:4},
  'ai.turn.standard':{purse:'action',credits:4},
  'ai.classify.fit':{purse:'action',credits:3},
  'email.send':{purse:'action',credits:1},
  'ai.message.standard':{purse:'action',credits:2},
  'ai.reply.standard':{purse:'action',credits:2},
  'lead.source.linkedin':{purse:'action',credits:1},
  'ai.plan.search':{purse:'action',credits:1},
  'ai.message.economy':{purse:'action',credits:1},
  'meeting.book':{purse:'action',credits:1}
});

function priceAction(actionKey, quantity=1){
  const rule=ACTION_COSTS[actionKey];
  if(!rule) return {purse:null,credits:0,quantity};
  return {purse:rule.purse,credits:rule.credits*quantity,quantity};
}

function summarizeUsage(entries=[],allowances={data:0,action:0}){
  const spent={data:0,action:0};
  for(const entry of entries){if(entry.purse in spent) spent[entry.purse]+=Number(entry.credits||0);}
  const result={};
  for(const purse of ['data','action']){
    const allowance=Number(allowances[purse]||0), used=spent[purse];
    result[purse]={used,allowance,remaining:Math.max(0,allowance-used),percent:allowance?Math.min(100,Math.round((used/allowance)*100)):0,blocked:allowance>0&&used>=allowance};
  }
  return result;
}

module.exports={ACTION_COSTS,priceAction,summarizeUsage};
