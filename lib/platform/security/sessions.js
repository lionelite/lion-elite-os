'use strict';
const crypto=require('crypto');
function newSessionToken(){return crypto.randomBytes(32).toString('base64url')}
function hashSessionToken(token){return crypto.createHash('sha256').update(String(token||'')).digest('hex')}
function bearerToken(req){const h=String(req.headers?.authorization||'');const m=h.match(/^Bearer\s+(.+)$/i);return m?m[1].trim():null}
module.exports={newSessionToken,hashSessionToken,bearerToken};
