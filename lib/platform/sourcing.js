'use strict';

class SourceProvider {
  constructor(name){this.name=name}
  async search(){throw new Error('search() not implemented')}
}

class CsvSourceProvider extends SourceProvider {
  constructor(rows=[]){super('csv');this.rows=rows}
  async search({icp={}}={}){
    const industries=(icp.industries||[]).map(x=>String(x).toLowerCase());
    return this.rows.filter(row=>{
      if(!industries.length) return true;
      return industries.some(i=>String(row.industry||'').toLowerCase().includes(i));
    });
  }
}

function fitGate(candidate={},icp={},highPrecision=false){
  const reasons=[];
  let score=100;
  const industries=(icp.industries||[]).map(x=>String(x).toLowerCase());
  if(industries.length&&!industries.some(i=>String(candidate.industry||'').toLowerCase().includes(i))){score-=60;reasons.push('industry_mismatch')}
  const range=icp.employees;
  if(range&&Number.isFinite(Number(candidate.employees))){
    const n=Number(candidate.employees);
    if(range.min!=null&&n<range.min){score-=30;reasons.push('below_employee_min')}
    if(range.max!=null&&n>range.max){score-=30;reasons.push('above_employee_max')}
  }
  const accepted=highPrecision?score===100:score>=60;
  return {accepted,score:Math.max(0,score),reasons};
}

async function runSourcing({provider,query,icp,highPrecision=false}){
  const candidates=await provider.search({query,icp});
  return candidates.map(candidate=>({candidate,fit:fitGate(candidate,icp,highPrecision)})).filter(x=>x.fit.accepted);
}

module.exports={SourceProvider,CsvSourceProvider,fitGate,runSourcing};
