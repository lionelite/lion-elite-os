'use strict';

class LinkedInProviderAdapter {
  constructor({baseUrl,token,fetchImpl=fetch}={}){
    this.baseUrl=String(baseUrl||'').replace(/\/$/,'');
    this.token=token;
    this.fetchImpl=fetchImpl;
  }
  assertConfigured(){
    if(!this.baseUrl||!this.token){const e=new Error('LinkedIn provider is not configured');e.code='LINKEDIN_PROVIDER_NOT_CONFIGURED';throw e}
  }
  async request(path,{method='GET',body}={}){
    this.assertConfigured();
    const r=await this.fetchImpl(this.baseUrl+path,{method,headers:{Authorization:'Bearer '+this.token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    if(!r.ok){const e=new Error('LinkedIn provider request failed');e.status=r.status;e.detail=await r.text();throw e}
    return r.json();
  }
  async pollSignals({cursor,limit=100}={}){
    const qs=new URLSearchParams({limit:String(limit)});if(cursor)qs.set('cursor',cursor);
    return this.request('/signals?'+qs.toString());
  }
  async execute(action){
    if(!action?.complianceSnapshot?.allowed) throw new Error('LinkedIn action blocked by compliance gate');
    return this.request('/actions',{method:'POST',body:action});
  }
}
module.exports={LinkedInProviderAdapter};
