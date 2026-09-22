'use strict';
const db=require('../database');
const {encrypt,decrypt}=require('./security/crypto-vault');

class OAuthStore{
  async save(workspaceId,{provider,externalAccountId=null,accessToken,refreshToken=null,tokenExpiresAt=null,scopes=[],metadata={}}){
    const r=await db.query(`INSERT INTO gtm_oauth_credentials (workspace_id,provider,external_account_id,access_token_ciphertext,refresh_token_ciphertext,token_expires_at,scopes,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (workspace_id,provider,external_account_id) DO UPDATE SET access_token_ciphertext=EXCLUDED.access_token_ciphertext,refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext,token_expires_at=EXCLUDED.token_expires_at,scopes=EXCLUDED.scopes,metadata=EXCLUDED.metadata,updated_at=now()
      RETURNING oauth_credential_id AS "oauthCredentialId",provider,external_account_id AS "externalAccountId",token_expires_at AS "tokenExpiresAt",scopes,metadata`,
      [workspaceId,provider,externalAccountId,encrypt(accessToken),encrypt(refreshToken),tokenExpiresAt,scopes,metadata]);
    return r.rows[0];
  }
  async listMetadata(workspaceId){
    const r=await db.query(`SELECT oauth_credential_id AS "oauthCredentialId",provider,external_account_id AS "externalAccountId",token_expires_at AS "tokenExpiresAt",scopes,metadata,updated_at AS "updatedAt"
      FROM gtm_oauth_credentials WHERE workspace_id=$1 ORDER BY provider,updated_at DESC`,[workspaceId]);
    return r.rows;
  }
  async get(workspaceId,provider,externalAccountId=null){
    const r=await db.query(`SELECT oauth_credential_id AS "oauthCredentialId",provider,external_account_id AS "externalAccountId",access_token_ciphertext AS "accessTokenCiphertext",refresh_token_ciphertext AS "refreshTokenCiphertext",token_expires_at AS "tokenExpiresAt",scopes,metadata
      FROM gtm_oauth_credentials WHERE workspace_id=$1 AND provider=$2 AND external_account_id IS NOT DISTINCT FROM $3`,[workspaceId,provider,externalAccountId]);
    if(!r.rows[0]) return null;
    const row=r.rows[0];return {...row,accessToken:decrypt(row.accessTokenCiphertext),refreshToken:decrypt(row.refreshTokenCiphertext)};
  }
}
module.exports={OAuthStore};
