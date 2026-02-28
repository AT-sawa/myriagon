import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticate, corsHeaders, errorResponse, jsonResponse } from "../_shared/common.ts";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
].join(" ");

const SLACK_SCOPES = "chat:write,channels:read,channels:history,groups:read,groups:history";

// Notion OAuth scopes (Notion uses a single "read content" scope implicitly)
// HubSpot scopes for CRM
const HUBSPOT_SCOPES = "crm.objects.contacts.write crm.objects.contacts.read crm.objects.deals.read crm.objects.deals.write";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const ctx = await authenticate(req);
    const { service_name } = await req.json();

    if (!service_name) {
      return jsonResponse({ error: "service_name is required" }, 400);
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Generate cryptographic state token
    const stateBytes = crypto.getRandomValues(new Uint8Array(32));
    const stateToken = Array.from(stateBytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Use frontend URL as callback so the redirect URI matches what's registered
    // in Google Cloud Console. The frontend will capture code/state and call
    // oauth-exchange to complete the token exchange.
    const frontendUrl = Deno.env.get("FRONTEND_URL") || "https://myriagon.app";
    const callbackUrl = `${frontendUrl}/oauth/callback`;

    let authUrl: string;
    let scopes: string[];

    if (service_name === "google" || service_name === "gmail" || service_name === "google_sheets" || service_name === "google_drive") {
      const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
      if (!clientId) {
        return jsonResponse({ error: "GOOGLE_CLIENT_ID not configured" }, 500);
      }

      scopes = GOOGLE_SCOPES.split(" ");
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        response_type: "code",
        scope: GOOGLE_SCOPES,
        access_type: "offline",
        prompt: "consent",
        state: stateToken,
      });
      authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    } else if (service_name === "slack") {
      const clientId = Deno.env.get("SLACK_CLIENT_ID");
      if (!clientId) {
        return jsonResponse({ error: "SLACK_CLIENT_ID not configured" }, 500);
      }

      scopes = SLACK_SCOPES.split(",");
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        scope: SLACK_SCOPES,
        state: stateToken,
      });
      authUrl = `https://slack.com/oauth/v2/authorize?${params.toString()}`;

    } else if (service_name === "notion") {
      const clientId = Deno.env.get("NOTION_CLIENT_ID");
      if (!clientId) {
        return jsonResponse({ error: "NOTION_CLIENT_ID not configured" }, 500);
      }

      scopes = ["read_content", "insert_content", "update_content"];
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        response_type: "code",
        owner: "user",
        state: stateToken,
      });
      authUrl = `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;

    } else if (service_name === "hubspot") {
      const clientId = Deno.env.get("HUBSPOT_CLIENT_ID");
      if (!clientId) {
        return jsonResponse({ error: "HUBSPOT_CLIENT_ID not configured" }, 500);
      }

      scopes = HUBSPOT_SCOPES.split(" ");
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        scope: HUBSPOT_SCOPES,
        state: stateToken,
      });
      authUrl = `https://app.hubspot.com/oauth/authorize?${params.toString()}`;

    } else if (service_name === "stripe") {
      const clientId = Deno.env.get("STRIPE_CONNECT_CLIENT_ID");
      if (!clientId) {
        return jsonResponse({ error: "STRIPE_CONNECT_CLIENT_ID not configured" }, 500);
      }

      scopes = ["read_write"];
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        scope: "read_write",
        state: stateToken,
        redirect_uri: callbackUrl,
      });
      authUrl = `https://connect.stripe.com/oauth/authorize?${params.toString()}`;

    } else {
      return jsonResponse({ error: `OAuth not supported for ${service_name}. Use credentials-create for API keys.` }, 400);
    }

    // Store state in DB (service_role_key bypasses RLS)
    const { error: stateError } = await serviceClient.from("oauth_states").insert({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      service_name: service_name === "google" ? "google" : service_name,
      state_token: stateToken,
      redirect_uri: callbackUrl,
      scopes,
    });

    if (stateError) {
      return jsonResponse({ error: "Failed to create OAuth state: " + stateError.message }, 500);
    }

    return jsonResponse({ auth_url: authUrl, callback_url: callbackUrl });
  } catch (err) {
    return errorResponse(err);
  }
});
