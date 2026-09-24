'use strict';
const crypto=require('crypto');
const db=require('../database');
const {AuthStore}=require('./security/auth-store');

function token(){return crypto.randomBytes(32).toString('base64url')}
function hash(v){return crypto.createHash('sha256').update(String(v||'')).digest('hex')}
function baseUrl(){return String(process.env.PUBLIC_BASE_URL||'https://lion-elite-os.onrender.com').replace(/\/$/,'')}

async function sendAccessEmail({email,magicUrl,subject='Your BuildGTM access link'}){
  const apiKey=String(process.env.RESEND_API_KEY||'').trim();
  if(!apiKey)return {sent:false,reason:'RESEND_API_KEY_NOT_CONFIGURED'};
  const from=String(process.env.GTM_EMAIL_FROM||process.env.COACHING_EMAIL_FROM||'BuildGTM <info@lionelitewellness.com>').trim();
  const html=`<!doctype html><html><body style="margin:0;background:#090b10;color:#f6f7f9;font-family:Arial,sans-serif"><div style="max-width:600px;margin:auto;padding:36px 20px"><div style="border:1px solid #282f3a;background:#0e1219;border-radius:18px;padding:30px"><div style="font-size:12px;letter-spacing:2px;color:#d3aa52;font-weight:700">BUILDGTM</div><h1 style="font-size:28px">Your workspace is ready.</h1><p style="color:#b9c0c8;line-height:1.7">Use this one-time link to open BuildGTM. It expires in 30 minutes.</p><a href="${magicUrl}" style="display:inline-block;background:#d3aa52;color:#111;text-decoration:none;font-weight:700;padding:13px 18px;border-radius:10px">Open BuildGTM</a><p style="font-size:12px;color:#747f8c;margin-top:22px">If you did not request this link, you can ignore this email.</p></div></div></body></html>`;
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({from,to:[email],subject,html})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.message||'BuildGTM access email failed');
  return {sent:true,id:j.id||null};
}

async function issueLoginLink(email,{purpose='login',send=true}={}){
  const e=String(email||'').trim().toLowerCase();
  const u=await db.query('SELECT user_id AS "userId",email FROM gtm_users WHERE lower(email)=lower($1) AND status=\'active\' LIMIT 1',[e]);
  if(!u.rows[0])return {accepted:true};
  const raw=token();
  await db.query(`INSERT INTO gtm_login_links (user_id,token_hash,purpose,expires_at)
    VALUES ($1,$2,$3,now()+interval '30 minutes')`,[u.rows[0].userId,hash(raw),purpose]);
  const magicUrl=baseUrl()+'/gtm/access/?token='+encodeURIComponent(raw);
  let delivery={sent:false};
  if(send)delivery=await sendAccessEmail({email:e,magicUrl,subject:purpose==='activation'?'Activate your BuildGTM workspace':'Your BuildGTM access link'});
  return {accepted:true,magicUrl:send?undefined:magicUrl,delivery};
}

async function consumeLoginLink(raw,{userAgent='',ip=''}={}){
  const client=await db.pool.connect();
  try{
    await client.query('BEGIN');
    const r=await client.query(`SELECT l.gtm_login_link_id AS "linkId",l.user_id AS "userId"
      FROM gtm_login_links l JOIN gtm_users u ON u.user_id=l.user_id
      WHERE l.token_hash=$1 AND l.consumed_at IS NULL AND l.expires_at>now() AND u.status='active'
      FOR UPDATE`,[hash(raw)]);
    const row=r.rows[0];if(!row){await client.query('ROLLBACK');return null}
    await client.query('UPDATE gtm_login_links SET consumed_at=now() WHERE gtm_login_link_id=$1',[row.linkId]);
    await client.query('COMMIT');
    const auth=new AuthStore();
    return auth.issueSession(row.userId,{userAgent,ip});
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
module.exports={issueLoginLink,consumeLoginLink,sendAccessEmail,hash};
