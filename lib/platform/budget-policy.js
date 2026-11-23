'use strict';

function evaluateBudget(summary={},warnPercent=80){
  const incidents=[];
  for(const purse of ['data','action']){
    const x=summary[purse]||{};
    const percent=Number(x.percent||0);
    const remaining=Number(x.remaining||0);
    if(Number(x.allowance||0)<=0) continue;
    if(remaining<=0) incidents.push({purse,level:'hard_stop',percentUsed:100,balanceRemaining:0});
    else if(percent>=warnPercent) incidents.push({purse,level:'warning',percentUsed:percent,balanceRemaining:remaining});
  }
  return {blocked:incidents.some(x=>x.level==='hard_stop'),incidents};
}

module.exports={evaluateBudget};
