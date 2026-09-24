'use strict';
const crypto=require('crypto');

function signWebhook({secret,timestamp,body}){
  if(!secret) throw new Error('webhook signing secret required');
  const payload=String(timestamp)+'.'+String(body);
  return crypto.createHmac('sha256',String(secret)).update(payload).digest('hex');
}
function headersForWebhook({secret,body,timestamp=Math.floor(Date.now()/1000)}){
  return {
    'Content-Type':'application/json',
    'X-LionOS-Timestamp':String(timestamp),
    'X-LionOS-Signature':'sha256='+signWebhook({secret,timestamp,body})
  };
}
function verifyWebhook({secret,timestamp,body,signature,toleranceSeconds=300,now=Math.floor(Date.now()/1000)}){
  const ts=Number(timestamp);
  if(!Number.isFinite(ts)||Math.abs(now-ts)>toleranceSeconds) return false;
  const expected='sha256='+signWebhook({secret,timestamp:ts,body});
  const a=Buffer.from(expected),b=Buffer.from(String(signature||''));
  return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
module.exports={signWebhook,headersForWebhook,verifyWebhook};
