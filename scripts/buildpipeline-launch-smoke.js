'use strict';

const base=String(process.env.BUILDPIPELINE_BASE_URL||process.argv[2]||'https://buildpipeline.online').replace(/\/$/,'');
const checks=[
  ['sales','/'],
  ['pricing','/pricing'],
  ['login','/login'],
  ['security','/security'],
  ['support','/support'],
  ['terms','/terms'],
  ['privacy','/privacy'],
  ['acceptable-use','/acceptable-use'],
  ['readiness','/api/gtm-sales/readiness']
];

async function main(){
  let failed=0;
  for(const [name,path] of checks){
    try{
      const r=await fetch(base+path,{redirect:'follow',headers:{'user-agent':'BuildPipelineLaunchSmoke/1.0'}});
      const ok=r.status>=200&&r.status<400;
      console.log((ok?'PASS':'FAIL'),name,r.status,base+path);
      if(!ok)failed++;
      if(name==='readiness'&&ok){
        const j=await r.json();
        console.log('launchReady=',Boolean(j.launchReady),'missing=',Array.isArray(j.missing)?j.missing.join(','):'unknown');
        if(!j.launchReady)failed++;
      }
    }catch(error){
      failed++;console.log('FAIL',name,String(error.message||error));
    }
  }
  if(failed){console.error('BuildPipeline launch smoke failed:',failed,'check(s)');process.exitCode=1}
  else console.log('BuildPipeline launch smoke passed.');
}
main();
