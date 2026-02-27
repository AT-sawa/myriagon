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

  // Token expired - refresh (Google only; Slack tokens don't expire)
  if (serviceName === "slack") {
    return { accessToken: tokens.access_token as string, tokenType: "Bearer" };
  }

  // Google OAuth refresh
  const refreshToken = tokens.refresh_token as string;
  if (!refreshToken) {
    throw new Error(`${serviceName}: no refresh_token available`);
  }

  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

  const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId!,
      client_secret: clientSecret!,
      refresh_token: refreshToken,
    }),
  });

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
