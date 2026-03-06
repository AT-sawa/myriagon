import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getN8nConfig, N8N_CRED_TYPE_MAP, buildN8nCredData } from "../_shared/n8n.ts";
import { decryptTokens, hexToBytes } from "../_shared/crypto.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { tenant_id, action } = await req.json();
    if (!tenant_id) {
      return new Response(JSON.stringify({ error: "tenant_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: creds } = await serviceClient
      .from("credentials")
      .select("*")
      .eq("tenant_id", tenant_id)
      .eq("status", "connected");

    // Diagnostic mode: check what's in the tokens
    if (action === "diagnose") {
      const clientId = Deno.env.get("GOOGLE_CLIENT_ID") || "";
      const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
      const diag: Record<string, unknown> = {
        google_client_id: clientId.slice(0, 20) + "...",
        google_client_secret_set: !!clientSecret,
        cred_encryption_key_set: !!Deno.env.get("CREDENTIAL_ENCRYPTION_KEY"),
      };

      for (const cred of creds || []) {
        try {
          if (!cred.encrypted_tokens || !cred.token_iv) {
            diag[cred.service_name] = "NO_TOKENS";
            continue;
          }
          const encrypted = hexToBytes(cred.encrypted_tokens);
          const iv = hexToBytes(cred.token_iv);
          const tokens = await decryptTokens(encrypted, iv);

          // Try refreshing the token to check validity
          let refreshResult = "not_attempted";
          let freshAccessToken = "";
          if (tokens.refresh_token && clientId && clientSecret) {
            const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: String(tokens.refresh_token),
                grant_type: "refresh_token",
              }),
            });
            const refreshData = await refreshRes.json();
            if (refreshData.access_token) {
              refreshResult = "OK";
              freshAccessToken = refreshData.access_token;
            } else {
              refreshResult = `FAILED: ${refreshData.error} - ${refreshData.error_description || ""}`;
            }
          }

          // Test API access with fresh token
          const apiTests: Record<string, string> = {};
          if (freshAccessToken && cred.service_name === "gmail") {
            const gmailTest = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
              headers: { Authorization: `Bearer ${freshAccessToken}` },
            });
            apiTests.gmail_api = gmailTest.ok ? "OK" : `${gmailTest.status}: ${(await gmailTest.json())?.error?.message?.slice(0, 100) || "unknown"}`;
          }
          if (freshAccessToken && cred.service_name === "google_sheets") {
            const sheetsTest = await fetch("https://sheets.googleapis.com/v4/spreadsheets?pageSize=1", {
              headers: { Authorization: `Bearer ${freshAccessToken}` },
            });
            apiTests.sheets_api = sheetsTest.ok ? "OK" : `${sheetsTest.status}: ${(await sheetsTest.json())?.error?.message?.slice(0, 100) || "unknown"}`;
          }

          diag[cred.service_name] = {
            has_access_token: !!tokens.access_token,
            access_token_prefix: tokens.access_token ? String(tokens.access_token).slice(0, 10) + "..." : "none",
            has_refresh_token: !!tokens.refresh_token,
            token_type: tokens.token_type || "none",
            obtained_at: tokens.obtained_at || "none",
            expires_in: tokens.expires_in || "none",
            n8n_cred_id: cred.n8n_credential_id,
            refresh_result: refreshResult,
            api_tests: apiTests,
          };
        } catch (e) {
          diag[cred.service_name] = `DECRYPT_ERROR: ${(e as Error).message}`;
        }
      }

      return new Response(JSON.stringify(diag, null, 2), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Enable APIs mode: try to enable Google APIs in the project
    if (action === "enable-apis") {
      const clientId = Deno.env.get("GOOGLE_CLIENT_ID") || "";
      const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
      const projectNumber = clientId.split("-")[0]; // Extract project number from client ID
      const results: Record<string, string> = {};

      // Get refresh token from gmail credential
      const gmailCred = (creds || []).find(c => c.service_name === "gmail");
      if (!gmailCred?.encrypted_tokens || !gmailCred?.token_iv) {
        return new Response(JSON.stringify({ error: "No gmail credential found" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const encrypted = hexToBytes(gmailCred.encrypted_tokens);
      const iv = hexToBytes(gmailCred.token_iv);
      const tokens = await decryptTokens(encrypted, iv);

      // Refresh token to get fresh access token
      const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: String(tokens.refresh_token),
          grant_type: "refresh_token",
        }),
      });
      const refreshData = await refreshRes.json();
      if (!refreshData.access_token) {
        return new Response(JSON.stringify({ error: "Token refresh failed", detail: refreshData }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const accessToken = refreshData.access_token;

      // Try enabling Gmail API
      const apis = ["gmail.googleapis.com", "sheets.googleapis.com", "drive.googleapis.com"];
      for (const api of apis) {
        const enableRes = await fetch(
          `https://serviceusage.googleapis.com/v1/projects/${projectNumber}/services/${api}:enable`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          }
        );
        if (enableRes.ok) {
          results[api] = "ENABLED";
        } else {
          const err = await enableRes.json();
          results[api] = `FAILED (${enableRes.status}): ${err?.error?.message?.slice(0, 200) || "unknown"}`;
        }
      }

      return new Response(JSON.stringify({ success: true, project: projectNumber, results }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Sync mode: decrypt and push to n8n
    const { apiKey, baseUrl } = await getN8nConfig();
    const results: Record<string, string> = {};

    for (const cred of creds || []) {
      const svcName = cred.service_name;
      try {
        if (!cred.encrypted_tokens || !cred.token_iv) {
          results[svcName] = "SKIP: no encrypted tokens";
          continue;
        }

        const encrypted = hexToBytes(cred.encrypted_tokens);
        const iv = hexToBytes(cred.token_iv);
        const tokens = await decryptTokens(encrypted, iv);

        const n8nCredType = N8N_CRED_TYPE_MAP[svcName];
        if (!n8nCredType) {
          results[svcName] = "SKIP: no n8n cred type mapping";
          continue;
        }

        const n8nCredData = buildN8nCredData(svcName, tokens);
        const n8nCredName = `tenant_${tenant_id}_${svcName}`;

        if (cred.n8n_credential_id) {
          const updateRes = await fetch(`${baseUrl}/credentials/${cred.n8n_credential_id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "X-N8N-API-KEY": apiKey },
            body: JSON.stringify({ name: n8nCredName, type: n8nCredType, data: n8nCredData }),
          });
          if (updateRes.ok) {
            results[svcName] = `UPDATED (${cred.n8n_credential_id})`;
          } else {
            const createRes = await fetch(`${baseUrl}/credentials`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-N8N-API-KEY": apiKey },
              body: JSON.stringify({ name: n8nCredName, type: n8nCredType, data: n8nCredData }),
            });
            if (createRes.ok) {
              const newCred = await createRes.json();
              await serviceClient.from("credentials").update({ n8n_credential_id: String(newCred.id) }).eq("id", cred.id);
              results[svcName] = `CREATED NEW (${newCred.id})`;
            } else {
              results[svcName] = `FAILED: ${await createRes.text()}`;
            }
          }
        } else {
          const createRes = await fetch(`${baseUrl}/credentials`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-N8N-API-KEY": apiKey },
            body: JSON.stringify({ name: n8nCredName, type: n8nCredType, data: n8nCredData }),
          });
          if (createRes.ok) {
            const newCred = await createRes.json();
            await serviceClient.from("credentials").update({ n8n_credential_id: String(newCred.id) }).eq("id", cred.id);
            results[svcName] = `CREATED (${newCred.id})`;
          } else {
            results[svcName] = `FAILED: ${await createRes.text()}`;
          }
        }
      } catch (e) {
        results[svcName] = `ERROR: ${(e as Error).message}`;
      }
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
