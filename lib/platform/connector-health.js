'use strict';

function verifiedConnector({provider,ok,label,error,metadata={}}={}){
  const now=new Date().toISOString();
  return {
    provider,
    status:ok?'connected':'degraded',
    verifiedAt:ok?now:null,
    lastSuccessAt:ok?now:null,
    lastFailureAt:ok?null:now,
    lastError:ok?null:String(error||'verification failed'),
    label:label||provider,
    metadata
  };
}

module.exports={verifiedConnector};
