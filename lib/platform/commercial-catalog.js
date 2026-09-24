'use strict';

const PLANS=Object.freeze({
  solo:{key:'solo',monthlyCents:29900,annualCents:299000,dataCredits:3000,actionCredits:5000,channels:2,clientWorkspaces:0,seats:1,modelTier:'standard'},
  agency:{key:'agency',monthlyCents:49900,annualCents:499000,dataCredits:6000,actionCredits:12000,channels:5,clientWorkspaces:5,seats:5,modelTier:'premium'}
});
const ADDONS=Object.freeze({
  channel:{key:'channel',monthlyCents:1200},
  clientWorkspace:{key:'client-workspace',monthlyCents:9900},
  seat:{key:'seat',monthlyCents:1900}
});
const CREDIT_PACKS=Object.freeze([
  {key:'data-3000',purse:'data',credits:3000,priceCents:3600},
  {key:'data-7500',purse:'data',credits:7500,priceCents:9000},
  {key:'data-15000',purse:'data',credits:15000,priceCents:18000},
  {key:'action-25000',purse:'action',credits:25000,priceCents:8800},
  {key:'action-60000',purse:'action',credits:60000,priceCents:21000},
  {key:'action-125000',purse:'action',credits:125000,priceCents:43800}
]);
function getPack(key){return CREDIT_PACKS.find(x=>x.key===key)||null}
module.exports={PLANS,ADDONS,CREDIT_PACKS,getPack};
