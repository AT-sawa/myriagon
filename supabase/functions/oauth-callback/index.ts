import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encryptTokens, bytesToHex } from "../_shared/crypto.ts";
import { getN8nConfig, createN8nCredential, N8N_CRED_TYPE_MAP, buildN8nCredData } from "../_shared/n8n.ts";

const FRONTEND_ORIGIN = Deno.env.get("FRONTEND_URL") || "https://myriagon.app";

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function successHtml(serviceName: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>接続完了</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#070809;color:#e0e0e0;}
.card{text-align:center;padding:40px;border:1px solid #333;border-radius:16px;background:#111;}
.ok{color:#26de81;font-size:48px;}
</style></head>
<body><div class="card">
<div class="ok">✓</div>
<h2>${serviceName} 接続完了</h2>
<p>このウィンドウは自動的に閉じます。</p>
</div>
<script>
if(window.opener){
  window.opener.postMessage({type:'oauth-success',service:'${serviceName}'},'${FRONTEND_ORIGIN}');
  setTimeout(()=>window.close(),1500);
}
</script></body></html>`;
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8"><title>接続エラー</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#070809;color:#e0e0e0;}
.card{text-align:center;padding:40px;border:1px solid #333;border-radius:16px;background:#111;}
.err{color:#ff6b6b;font-size:48px;}
</style></head>
<body><div class="card">
<div class="err">✕</div>
<h2>接続エラー</h2>
<p>${message}</p>
</div>
<script>
if(window.opener){
  window.opener.postMessage({type:'oauth-error',message:'${message.replace(/'/g, "\\'")}'},'${FRONTEND_ORIGIN}');
}
</script></body></html>`;
}

serve(async (req) => {
  // This is a GET request (redirect from OAuth provider)
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    return htmlResponse(errorHtml(`OAuth denied: ${error}`), 400);
  }

  if (!code || !state) {
    return htmlResponse(errorHtml("Missing code or state parameter"), 400);
  }

  const serviceClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    // 1. Validate state
    const { data: stateRow, error: stateError } = await serviceClient
      .from("oauth_states")
      .select("*")
      .eq("state_token", state)
      .single();

    if (stateError || !stateRow) {
      return htmlResponse(errorHtml("Invalid or expired state token"), 400);
    }

    // Check expiry
    if (new Date(stateRow.expires_at) < new Date()) {
      await serviceClient.from("oauth_states").delete().eq("id", stateRow.id);
      return htmlResponse(errorHtml("State token expired. Please try again."), 400);
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
        return htmlResponse(errorHtml("Google認証に失敗しました"), 500);
      }

      tokens = await tokenRes.json();
      tokens.obtained_at = new Date().toISOString();

      // Google: create credentials for all 3 services
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
        return htmlResponse(errorHtml("Slack認証に失敗しました"), 500);
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
      return htmlResponse(errorHtml("Unknown service: " + stateRow.service_name), 400);
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

      // Try to create n8n credential
      let n8nCredId = "";
      try {
        const n8nCred = await createN8nCredential(
          n8nApiKey, n8nBaseUrl, n8nCredName, n8nCredType, n8nCredData
        );
        n8nCredId = String(n8nCred.id);
      } catch (e) {
        console.warn(`n8n credential creation for ${svcName} failed (may already exist):`, (e as Error).message);
      }

      // Upsert to credentials table
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

    const displayName = stateRow.service_name === "google" ? "Google" : "Slack";
    return htmlResponse(successHtml(displayName));
  } catch (err) {
    console.error("OAuth callback error:", err);
    return htmlResponse(errorHtml("サーバーエラーが発生しました"), 500);
  }
});
