import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticate, corsHeaders, errorResponse, jsonResponse } from "../_shared/common.ts";
import { encryptTokens, bytesToHex } from "../_shared/crypto.ts";
import { getN8nConfig, createN8nCredential, N8N_CRED_TYPE_MAP, buildN8nCredData } from "../_shared/n8n.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Authenticate the user (same as other Edge Functions)
    const ctx = await authenticate(req);
    const { code, state } = await req.json();

    if (!code || !state) {
      return jsonResponse({ error: "code and state are required" }, 400);
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Validate state
    const { data: stateRow, error: stateError } = await serviceClient
      .from("oauth_states")
      .select("*")
      .eq("state_token", state)
      .single();

    if (stateError || !stateRow) {
      return jsonResponse({ error: "無効または期限切れの認証トークンです。もう一度お試しください。" }, 400);
    }

    // Check expiry
    if (new Date(stateRow.expires_at) < new Date()) {
      await serviceClient.from("oauth_states").delete().eq("id", stateRow.id);
      return jsonResponse({ error: "認証トークンの有効期限が切れました。もう一度お試しください。" }, 400);
    }

    // Verify the user matches
    if (stateRow.tenant_id !== ctx.tenantId) {
      return jsonResponse({ error: "認証トークンが一致しません" }, 403);
    }

    // Delete state (one-time use)
    await serviceClient.from("oauth_states").delete().eq("id", stateRow.id);

    const callbackUrl = stateRow.redirect_uri;
    let tokens: Record<string, unknown>;
    let serviceNames: string[];

    // 2. Exchange code for tokens
    if (stateRow.service_name === "google" || stateRow.service_name === "gmail" ||
        stateRow.service_name === "google_sheets" || stateRow.service_name === "google_drive") {
      // Google OAuth token exchange
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
          client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
          redirect_uri: callbackUrl,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        console.error("Google token exchange failed:", errBody);
        return jsonResponse({ error: "Google認証に失敗しました。もう一度お試しください。" }, 500);
      }

      tokens = await tokenRes.json();
      tokens.obtained_at = new Date().toISOString();
      serviceNames = ["gmail", "google_sheets", "google_drive"];

    } else if (stateRow.service_name === "slack") {
      // Slack OAuth token exchange
      const tokenRes = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: Deno.env.get("SLACK_CLIENT_ID")!,
          client_secret: Deno.env.get("SLACK_CLIENT_SECRET")!,
          redirect_uri: callbackUrl,
        }),
      });

      const slackData = await tokenRes.json();
      if (!slackData.ok) {
        console.error("Slack token exchange failed:", JSON.stringify(slackData));
        return jsonResponse({ error: "Slack認証に失敗しました。もう一度お試しください。" }, 500);
      }

      tokens = {
        access_token: slackData.access_token,
        token_type: "Bearer",
        bot_user_id: slackData.bot_user_id,
        team_id: slackData.team?.id,
        obtained_at: new Date().toISOString(),
      };
      serviceNames = ["slack"];

    } else {
      return jsonResponse({ error: "Unknown service: " + stateRow.service_name }, 400);
    }

    // 3. Encrypt tokens
    const { encrypted, iv } = await encryptTokens(tokens);
    const encHex = bytesToHex(encrypted);
    const ivHex = bytesToHex(iv);

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + (tokens.expires_in as number) * 1000).toISOString()
      : null;

    // 4. Get n8n config
    const { apiKey: n8nApiKey, baseUrl: n8nBaseUrl } = await getN8nConfig();

    // 5. Create/update credentials for each service
    for (const svcName of serviceNames) {
      const n8nCredType = N8N_CRED_TYPE_MAP[svcName] || svcName;
      const n8nCredData = buildN8nCredData(svcName, tokens);
      const n8nCredName = `tenant_${stateRow.tenant_id}_${svcName}`;

      let n8nCredId = "";
      try {
        const n8nCred = await createN8nCredential(
          n8nApiKey, n8nBaseUrl, n8nCredName, n8nCredType, n8nCredData
        );
        n8nCredId = String(n8nCred.id);
      } catch (e) {
        console.warn(`n8n credential for ${svcName} skipped:`, (e as Error).message);
      }

      await serviceClient
        .from("credentials")
        .upsert(
          {
            tenant_id: stateRow.tenant_id,
            service_name: svcName,
            n8n_credential_id: n8nCredId || null,
            status: "connected",
            credential_type: "oauth2",
            encrypted_tokens: encHex,
            token_iv: ivHex,
            scopes: stateRow.scopes || [],
            token_expires_at: expiresAt,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "tenant_id,service_name" }
        );
    }

    // Clean up expired states
    await serviceClient
      .from("oauth_states")
      .delete()
      .lt("expires_at", new Date().toISOString());

    return jsonResponse({
      success: true,
      services: serviceNames,
      service_name: stateRow.service_name,
    });
  } catch (err) {
    console.error("OAuth exchange error:", err);
    return errorResponse(err);
  }
});
