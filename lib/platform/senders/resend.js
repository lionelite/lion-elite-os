'use strict';

class ResendProvisioner {
  constructor({apiKey,fetchImpl=fetch}={}){this.apiKey=apiKey;this.fetchImpl=fetchImpl}
  assertConfigured(){if(!this.apiKey){const e=new Error('Resend API key is not configured');e.code='RESEND_NOT_CONFIGURED';throw e}}
  async api(path,{method='GET',body}={}){
    this.assertConfigured();
    const r=await this.fetchImpl('https://api.resend.com'+path,{method,headers:{Authorization:'Bearer '+this.apiKey,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    if(!r.ok){const e=new Error('Resend API request failed');e.status=r.status;e.detail=await r.text();throw e}
    return r.json();
  }
  async createDomain(domain){return this.api('/domains',{method:'POST',body:{name:domain}})}
  async getDomain(id){return this.api('/domains/'+encodeURIComponent(id))}
  async verifyDomain(id){return this.api('/domains/'+encodeURIComponent(id)+'/verify',{method:'POST'})}
}
module.exports={ResendProvisioner};
