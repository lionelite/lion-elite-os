'use strict';
const crypto=require('crypto');

function keyFromEnv(env=process.env){
  const raw=String(env.GTM_OAUTH_ENCRYPTION_KEY||'').trim();
  if(!raw) throw new Error('GTM_OAUTH_ENCRYPTION_KEY is not configured');
  return crypto.createHash('sha256').update(raw).digest();
}
function encrypt(value,env=process.env){
  if(value==null||value==='') return null;
  const key=keyFromEnv(env),iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const ciphertext=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return ['v1',iv.toString('base64url'),tag.toString('base64url'),ciphertext.toString('base64url')].join('.');
}
function decrypt(payload,env=process.env){
  if(!payload) return null;
  const [v,ivB64,tagB64,dataB64]=String(payload).split('.');
  if(v!=='v1'||!ivB64||!tagB64||!dataB64) throw new Error('invalid encrypted payload');
  const decipher=crypto.createDecipheriv('aes-256-gcm',keyFromEnv(env),Buffer.from(ivB64,'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64,'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64,'base64url')),decipher.final()]).toString('utf8');
}
module.exports={encrypt,decrypt,keyFromEnv};
