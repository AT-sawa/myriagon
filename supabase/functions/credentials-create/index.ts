import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { authenticate, corsHeaders, errorResponse, jsonResponse, PLAN_LIMITS } from "../_shared/common.ts";
import { encryptTokens, bytesToHex } from "../_shared/crypto.ts";
import { getN8nConfig, createN8nCredential, updateN8nCredential, N8N_CRED_TYPE_MAP, buildN8nCredData } from "../_shared/n8n.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const ctx = await authenticate(req);
    const body = await req.json();
    const { service_name, api_key, use_platform_key, provider_token, provider_refresh_token } = body;

    if (!service_name) {
      return jsonResponse({ error: "service_name is required" }, 400);
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // ── Plan limit check: max services ──
    const limits = PLAN_LIMITS[ctx.plan] || PLAN_LIMITS.starter;
    const { count: credCount } = await serviceClient
      .from("credentials")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", ctx.tenantId)
      .eq("status", "connected");

    // Google OAuth creates 3 services at once; count how many are truly NEW (not upsert)
    const isGoogle = service_name === "google" && body.provider_token;
    let newCount = 0;
    if (isGoogle) {
      const { count: existingGoogle } = await serviceClient
        .from("credentials")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", ctx.tenantId)
        .in("service_name", ["gmail", "google_sheets", "google_drive"])
        .eq("status", "connected");
      newCount = 3 - (existingGoogle || 0); // only count truly new services
    } else {
      const { count: existingService } = await serviceClient
        .from("credentials")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", ctx.tenantId)
        .eq("service_name", service_name)
        .eq("status", "connected");
      newCount = (existingService || 0) > 0 ? 0 : 1; // 0 if reconnecting
    }
    if ((credCount || 0) + newCount > limits.maxServices) {
      return jsonResponse({
        error: `${ctx.plan}プランの接続サービス上限（${limits.maxServices}個）に達しています。プランをアップグレードしてください。`,
        code: "PLAN_LIMIT",
      }, 403);
    }

    // ── Mode 1: Google OAuth via Supabase Auth provider_token ──
    if (service_name === "google" && provider_token) {
      const tokens: Record<string, unknown> = {
        access_token: provider_token,
        refresh_token: provider_refresh_token || null,
        token_type: "Bearer",
        obtained_at: new Date().toISOString(),
      };

      const { encrypted, iv } = await encryptTokens(tokens);
      const encHex = bytesToHex(encrypted);
      const ivHex = bytesToHex(iv);

      const googleScopes = [
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive",
      ];

      const { apiKey: n8nApiKey, baseUrl: n8nBaseUrl } = await getN8nConfig();

      // Create/update credentials for all 3 Google services
      const googleServices = ["gmail", "google_sheets", "google_drive"];
      for (const svcName of googleServices) {
        const n8nCredType = N8N_CRED_TYPE_MAP[svcName] || svcName;
        const n8nCredData = buildN8nCredData(svcName, tokens);
        const n8nCredName = `tenant_${ctx.tenantId}_${svcName}`;

        // Check for existing n8n credential
        const { data: existingCred } = await serviceClient
          .from("credentials")
          .select("n8n_credential_id")
          .eq("tenant_id", ctx.tenantId)
          .eq("service_name", svcName)
          .single();

        let n8nCredId = existingCred?.n8n_credential_id || "";

        if (n8nCredId) {
          try {
            await updateN8nCredential(n8nApiKey, n8nBaseUrl, n8nCredId, n8nCredName, n8nCredType, n8nCredData);
          } catch (e) {
            console.warn(`n8n credential update for ${svcName} failed, trying create:`, (e as Error).message);
            try {
              const n8nCred = await createN8nCredential(n8nApiKey, n8nBaseUrl, n8nCredName, n8nCredType, n8nCredData);
              n8nCredId = String(n8nCred.id);
            } catch (e2) {
              console.error(`n8n credential create also failed for ${svcName}:`, (e2 as Error).message);
            }
          }
        } else {
          try {
            const n8nCred = await createN8nCredential(n8nApiKey, n8nBaseUrl, n8nCredName, n8nCredType, n8nCredData);
            n8nCredId = String(n8nCred.id);
          } catch (e) {
            console.error(`n8n credential creation failed for ${svcName}:`, (e as Error).message);
          }
        }

        await serviceClient
          .from("credentials")
          .upsert(
            {
              tenant_id: ctx.tenantId,
              service_name: svcName,
              n8n_credential_id: n8nCredId || null,
              status: "connected",
              credential_type: "oauth2",
              encrypted_tokens: encHex,
              token_iv: ivHex,
              scopes: googleScopes,
              token_expires_at: null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "tenant_id,service_name" }
          );
      }

      return jsonResponse({
        service_name: "google",
        status: "connected",
        services: googleServices,
      }, 201);
    }

    // ── Mode 2: Platform key (OpenAI, Anthropic) ──
    // ── Mode 3: Manual API key ──
    let resolvedKey: string;
    if (use_platform_key) {
      const PLATFORM_KEY_MAP: Record<string, string> = {
        openai: "OPENAI_API_KEY",
        anthropic: "ANTHROPIC_API_KEY",
      };
      const envName = PLATFORM_KEY_MAP[service_name];
      if (!envName) {
        return jsonResponse({ error: `Platform key not available for ${service_name}` }, 400);
      }
      const envKey = Deno.env.get(envName);
      if (!envKey) {
        return jsonResponse({ error: `${service_name} platform key not configured` }, 500);
      }
      resolvedKey = envKey;
    } else {
      if (!api_key || !api_key.trim()) {
        return jsonResponse({ error: "api_key is required" }, 400);
      }
      resolvedKey = api_key.trim();
    }

    // Encrypt the API key
    const tokens = { api_key: resolvedKey };
    const { encrypted, iv } = await encryptTokens(tokens);

    // Create n8n credential
    const { apiKey: n8nApiKey, baseUrl: n8nBaseUrl } = await getN8nConfig();
    const n8nCredType = N8N_CRED_TYPE_MAP[service_name] || service_name;
    const n8nCredName = `tenant_${ctx.tenantId}_${service_name}`;
    const n8nCredData = buildN8nCredData(service_name, tokens);

    let n8nCredId = "";
    try {
      const n8nCred = await createN8nCredential(
        n8nApiKey, n8nBaseUrl, n8nCredName, n8nCredType, n8nCredData
      );
      n8nCredId = String(n8nCred.id);
    } catch (e) {
      console.warn(`n8n credential creation for ${service_name} skipped:`, (e as Error).message);
    }

    const { data: credential, error: upsertError } = await serviceClient
      .from("credentials")
      .upsert(
        {
          tenant_id: ctx.tenantId,
          service_name,
          n8n_credential_id: n8nCredId || null,
          status: "connected",
          credential_type: "api_key",
          encrypted_tokens: bytesToHex(encrypted),
          token_iv: bytesToHex(iv),
          scopes: [],
          token_expires_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "tenant_id,service_name" }
      )
      .select("id, tenant_id, service_name, status, credential_type, created_at, updated_at")
      .single();

    if (upsertError) {
      return jsonResponse({ error: upsertError.message }, 500);
    }

    return jsonResponse(credential, 201);
  } catch (err) {
    return errorResponse(err);
  }
});
