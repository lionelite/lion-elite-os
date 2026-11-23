'use strict';
const {calculateIntentHeat}=require('../intent');

class SignalProvider{constructor(name){this.name=name}async poll(){throw new Error('poll() not implemented')}}
async function pollSubscription({subscription,provider,prospects=[]}){
  const events=await provider.poll(subscription.config||{});
  const byProspect=new Map(prospects.map(p=>[String(p.sourceExternalId||p.email||p.prospectId),p]));
  const updates=[];
  for(const event of events||[]){
    const prospect=byProspect.get(String(event.prospectKey||''));
    if(!prospect) continue;
    const signals=[...(prospect.signals||[]),{type:event.signalType}];
    updates.push({prospectId:prospect.prospectId,event,intentHeat:calculateIntentHeat({signals})});
  }
  return updates;
}
function nextPollAt(intervalSeconds=60,now=Date.now()){return new Date(now+Math.max(60,Number(intervalSeconds||60))*1000).toISOString()}
module.exports={SignalProvider,pollSubscription,nextPollAt};
