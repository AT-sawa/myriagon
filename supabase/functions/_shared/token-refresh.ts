// ─── Token取得 + リフレッシュ ───────────────────────────────
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decryptTokens, encryptTokens, hexToBytes, bytesToHex } from "./crypto.ts";

interface TokenResult {
  accessToken: string;
  tokenType: string;
}

/**
 * credentials テーブルから暗号化トークンを取得し、
 * 期限切れならリフレッシュして返す。
 */
export async function getValidAccessToken(
  tenantId: string,
  serviceName: string
): Promise<TokenResult> {
  const serviceClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data, error } = await serviceClient
    .from("credentials")
    .select("id, encrypted_tokens, token_iv, token_expires_at, credential_type, n8n_credential_id")
    .eq("tenant_id", tenantId)
    .eq("service_name", serviceName)
    .eq("status", "connected")
    .single();

  if (error || !data) {
    throw new Error(`${serviceName} is not connected`);
  }

  if (!data.encrypted_tokens || !data.token_iv) {
    throw new Error(`${serviceName} has no stored tokens`);
  }

  const encBytes = hexToBytes(data.encrypted_tokens);
  const ivBytes = hexToBytes(data.token_iv);
  const tokens = await decryptTokens(encBytes, ivBytes);

  // API key services - just return the key
  if (data.credential_type === "api_key") {
    return { accessToken: tokens.api_key as string, tokenType: "Bearer" };
  }

  // OAuth2 - check expiry
  const expiresAt = data.token_expires_at ? new Date(data.token_expires_at).getTime() : 0;
  const now = Date.now();
  const bufferMs = 5 * 60 * 1000; // 5 minute buffer

  if (expiresAt > now + bufferMs) {
    // Token is still valid
    return { accessToken: tokens.access_token as string, tokenType: "Bearer" };
  }

  // Token expired - refresh
  // Slack tokens don't expire
  if (serviceName === "slack") {
    return { accessToken: tokens.access_token as string, tokenType: "Bearer" };
  }

  const refreshToken = tokens.refresh_token as string;
  if (!refreshToken) {
    throw new Error(`${serviceName}: no refresh_token available`);
  }

  // Service-specific refresh configuration
  const REFRESH_CONFIG: Record<string, { url: string; clientIdEnv: string; clientSecretEnv: string }> = {
    gmail:         { url: "https://oauth2.googleapis.com/token", clientIdEnv: "GOOGLE_CLIENT_ID", clientSecretEnv: "GOOGLE_CLIENT_SECRET" },
    google_sheets: { url: "https://oauth2.googleapis.com/token", clientIdEnv: "GOOGLE_CLIENT_ID", clientSecretEnv: "GOOGLE_CLIENT_SECRET" },
    google_drive:  { url: "https://oauth2.googleapis.com/token", clientIdEnv: "GOOGLE_CLIENT_ID", clientSecretEnv: "GOOGLE_CLIENT_SECRET" },
    notion:        { url: "https://api.notion.com/v1/oauth/token", clientIdEnv: "NOTION_CLIENT_ID", clientSecretEnv: "NOTION_CLIENT_SECRET" },
    hubspot:       { url: "https://api.hubapi.com/oauth/v1/token", clientIdEnv: "HUBSPOT_CLIENT_ID", clientSecretEnv: "HUBSPOT_CLIENT_SECRET" },
  };

  const config = REFRESH_CONFIG[serviceName];
  if (!config) {
    // No refresh support for this service, return existing token
    return { accessToken: tokens.access_token as string, tokenType: "Bearer" };
  }

  const clientId = Deno.env.get(config.clientIdEnv);
  const clientSecret = Deno.env.get(config.clientSecretEnv);

  let refreshRes: Response;

  if (serviceName === "notion") {
    // Notion uses Basic auth (client_id:client_secret) and JSON body
    const basicAuth = btoa(`${clientId}:${clientSecret}`);
    refreshRes = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${basicAuth}`,
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
  } else {
    // Google, HubSpot use form-encoded body
    refreshRes = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId!,
        client_secret: clientSecret!,
        refresh_token: refreshToken,
      }),
    });
  }

  if (!refreshRes.ok) {
    const errBody = await refreshRes.text();
    throw new Error(`Token refresh failed for ${serviceName}: ${errBody}`);
  }

  const refreshData = await refreshRes.json();

  // Update stored tokens
  const updatedTokens = {
    ...tokens,
    access_token: refreshData.access_token,
    expires_in: refreshData.expires_in,
    obtained_at: new Date().toISOString(),
  };

  const { encrypted, iv } = await encryptTokens(updatedTokens);
  const newExpiresAt = new Date(Date.now() + (refreshData.expires_in || 3600) * 1000).toISOString();

  await serviceClient
    .from("credentials")
    .update({
      encrypted_tokens: bytesToHex(encrypted),
      token_iv: bytesToHex(iv),
      token_expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", data.id);

  return { accessToken: refreshData.access_token, tokenType: "Bearer" };
}
