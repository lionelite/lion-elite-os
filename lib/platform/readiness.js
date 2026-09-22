'use strict';
function productionReadiness(env=process.env){
  const required={
    database:Boolean(env.DATABASE_URL),
    authExchange:Boolean(env.GTM_AUTH_EXCHANGE_SECRET),
    oauthEncryption:Boolean(env.GTM_OAUTH_ENCRYPTION_KEY),
    oauthCallback:Boolean(env.GTM_OAUTH_CALLBACK_SECRET),
    googleOAuth:Boolean(env.GTM_GOOGLE_CLIENT_ID&&env.GTM_GOOGLE_CLIENT_SECRET&&env.GTM_GOOGLE_REDIRECT_URI),
    resend:Boolean(env.RESEND_API_KEY),
    apollo:Boolean(env.APOLLO_API_KEY)
  };
  const ready=Object.values(required).every(Boolean);
  return {ready,required};
}
module.exports={productionReadiness};
