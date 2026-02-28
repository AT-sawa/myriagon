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

    } else if (stateRow.service_name === "notion") {
      // Notion OAuth token exchange (Basic Auth + JSON body)
      const clientId = Deno.env.get("NOTION_CLIENT_ID")!;
      const clientSecret = Deno.env.get("NOTION_CLIENT_SECRET")!;
      const basicAuth = btoa(`${clientId}:${clientSecret}`);

      const tokenRes = await fetch("https://api.notion.com/v1/oauth/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${basicAuth}`,
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: callbackUrl,
        }),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        console.error("Notion token exchange failed:", errBody);
        return htmlResponse(errorHtml("Notion認証に失敗しました"), 500);
      }

      const notionData = await tokenRes.json();
      tokens = {
        access_token: notionData.access_token,
        token_type: "Bearer",
        workspace_id: notionData.workspace_id,
        workspace_name: notionData.workspace_name,
        bot_id: notionData.bot_id,
        obtained_at: new Date().toISOString(),
      };
      serviceNames = ["notion"];

    } else if (stateRow.service_name === "hubspot") {
      // HubSpot OAuth token exchange (form-urlencoded)
      const tokenRes = await fetch("https://api.hubapi.com/oauth/v1/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: Deno.env.get("HUBSPOT_CLIENT_ID")!,
          client_secret: Deno.env.get("HUBSPOT_CLIENT_SECRET")!,
          redirect_uri: callbackUrl,
        }),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        console.error("HubSpot token exchange failed:", errBody);
        return htmlResponse(errorHtml("HubSpot認証に失敗しました"), 500);
      }

      const hubData = await tokenRes.json();
      tokens = {
        access_token: hubData.access_token,
        refresh_token: hubData.refresh_token,
        token_type: "Bearer",
        expires_in: hubData.expires_in,
        obtained_at: new Date().toISOString(),
      };
      serviceNames = ["hubspot"];

    } else if (stateRow.service_name === "stripe") {
      // Stripe Connect OAuth token exchange (form-urlencoded)
      const tokenRes = await fetch("https://connect.stripe.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_secret: Deno.env.get("STRIPE_SECRET_KEY")!,
        }),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        console.error("Stripe token exchange failed:", errBody);
        return htmlResponse(errorHtml("Stripe認証に失敗しました"), 500);
      }

      const stripeData = await tokenRes.json();
      tokens = {
        access_token: stripeData.access_token || stripeData.stripe_user_id,
        refresh_token: stripeData.refresh_token,
        stripe_user_id: stripeData.stripe_user_id,
        stripe_publishable_key: stripeData.stripe_publishable_key,
        token_type: "Bearer",
        obtained_at: new Date().toISOString(),
      };
      serviceNames = ["stripe"];

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

    const displayNameMap: Record<string, string> = {
      google: "Google", gmail: "Google", google_sheets: "Google", google_drive: "Google",
      slack: "Slack", notion: "Notion", hubspot: "HubSpot", stripe: "Stripe",
    };
    const displayName = displayNameMap[stateRow.service_name] || stateRow.service_name;
    return htmlResponse(successHtml(displayName));
  } catch (err) {
    console.error("OAuth callback error:", err);
    return htmlResponse(errorHtml("サーバーエラーが発生しました"), 500);
  }
});
