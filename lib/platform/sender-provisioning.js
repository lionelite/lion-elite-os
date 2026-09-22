'use strict';
function dnsRequirements(domain){
  return [
    {type:'TXT',host:'@',purpose:'SPF',value:'v=spf1 include:YOUR_SENDER_PROVIDER ~all'},
    {type:'TXT',host:'selector1._domainkey',purpose:'DKIM',value:'PROVIDER_DKIM_VALUE'},
    {type:'TXT',host:'_dmarc',purpose:'DMARC',value:'v=DMARC1; p=none; rua=mailto:dmarc@'+domain}
  ];
}
function nextProvisioningState(current,event){
  const map={
    requested:{dns_issued:'dns_pending',cancel:'cancelled'},
    dns_pending:{dns_verified:'verifying',fail:'failed',cancel:'cancelled'},
    verifying:{provider_ready:'provisioned',fail:'failed',cancel:'cancelled'},
    failed:{retry:'dns_pending',cancel:'cancelled'},
    provisioned:{disable:'cancelled'}
  };
  return map[current]?.[event]||current;
}
module.exports={dnsRequirements,nextProvisioningState};
