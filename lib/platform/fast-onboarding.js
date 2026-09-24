'use strict';
const {planCampaign}=require('./campaign-planner');

function buildOnboardingPreview({website='',companyName='',keywords=[],channel='email',profile={}}={}){
  const cleanKeywords=[...new Set((keywords||[]).map(x=>String(x).trim()).filter(Boolean))].slice(0,20);
  const prompt=[
    companyName||website||'This company',
    cleanKeywords.length?'targeting '+cleanKeywords.join(', '):'',
    'using '+channel,
    'to book qualified meetings'
  ].filter(Boolean).join(' ');
  const campaign=planCampaign(prompt,{...profile,websiteUrl:website,companyDescription:profile.companyDescription||companyName});
  return {
    company:{website,companyName},
    keywords:cleanKeywords,
    channels:[channel],
    campaign,
    checklist:['company','keywords','channel','preview']
  };
}
module.exports={buildOnboardingPreview};
