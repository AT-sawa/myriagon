// ─── n8n API ヘルパー ──────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// n8n クレデンシャルタイプのマッピング
export const N8N_CRED_TYPE_MAP: Record<string, string> = {
  gmail: "googleOAuth2Api",
  google_sheets: "googleSheetsOAuth2Api",
  google_drive: "googleDriveOAuth2Api",
  slack: "slackOAuth2Api",
  openai: "openAiApi",
  anthropic: "anthropicApi",
  notion: "notionOAuth2Api",
  hubspot: "hubspotOAuth2Api",
  stripe: "stripeApi",
  supabase: "supabaseApi",
};

export async function getN8nConfig(): Promise<{ apiKey: string; baseUrl: string }> {
  const serviceClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const { data: vaultData } = await serviceClient.rpc("vault_read", {
    secret_name: "n8n_api_key",
  });
  const apiKey = vaultData?.[0]?.secret || Deno.env.get("N8N_API_KEY") || "";
  const baseUrl = Deno.env.get("N8N_BASE_URL") || "https://api.n8n.cloud/api/v1";
  return { apiKey, baseUrl };
}

export async function createN8nCredential(
  apiKey: string,
  baseUrl: string,
  name: string,
  type: string,
  data: Record<string, unknown>
): Promise<{ id: string }> {
  const res = await fetch(`${baseUrl}/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": apiKey,
    },
    body: JSON.stringify({ name, type, data }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`n8n credential creation failed (${res.status}): ${body}`);
  }
  return await res.json();
}

export async function updateN8nCredential(
  apiKey: string,
  baseUrl: string,
  credId: string,
  name: string,
  type: string,
  data: Record<string, unknown>
): Promise<void> {
  const res = await fetch(`${baseUrl}/credentials/${credId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": apiKey,
    },
    body: JSON.stringify({ name, type, data }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`n8n credential update failed (${res.status}): ${body}`);
  }
}

// Build n8n credential data shape from tokens
export function buildN8nCredData(
  serviceName: string,
  tokens: Record<string, unknown>
): Record<string, unknown> {
  if (["gmail", "google_sheets", "google_drive"].includes(serviceName)) {
    const baseData: Record<string, unknown> = {
      clientId: Deno.env.get("GOOGLE_CLIENT_ID") || "",
      clientSecret: Deno.env.get("GOOGLE_CLIENT_SECRET") || "",
      serverUrl: "https://oauth2.googleapis.com",
      sendAdditionalBodyProperties: false,
      additionalBodyProperties: "{}",
      oauthTokenData: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type || "Bearer",
        expires_in: tokens.expires_in,
      },
    };
    // googleOAuth2Api (gmail) has a scope field; googleSheetsOAuth2Api and googleDriveOAuth2Api do not
    if (serviceName === "gmail") {
      baseData.scope = "https://www.googleapis.com/auth/gmail.modify";
    }
    return baseData;
  }
  if (serviceName === "slack") {
    // slackOAuth2Api schema: serverUrl, clientId, clientSecret, sendAdditionalBodyProperties, additionalBodyProperties, oauthTokenData
    return {
      clientId: Deno.env.get("SLACK_CLIENT_ID") || "",
      clientSecret: Deno.env.get("SLACK_CLIENT_SECRET") || "",
      serverUrl: "https://slack.com",
      sendAdditionalBodyProperties: false,
      additionalBodyProperties: "{}",
      oauthTokenData: {
        access_token: tokens.access_token,
        token_type: tokens.token_type || "Bearer",
      },
    };
  }
  if (serviceName === "notion") {
    // notionOAuth2Api schema: serverUrl, clientId, clientSecret, sendAdditionalBodyProperties, additionalBodyProperties, oauthTokenData
    return {
      clientId: Deno.env.get("NOTION_CLIENT_ID") || "",
      clientSecret: Deno.env.get("NOTION_CLIENT_SECRET") || "",
      serverUrl: "https://api.notion.com",
      sendAdditionalBodyProperties: false,
      additionalBodyProperties: "{}",
      oauthTokenData: {
        access_token: tokens.access_token,
        token_type: tokens.token_type || "Bearer",
      },
    };
  }
  if (serviceName === "hubspot") {
    // hubspotOAuth2Api schema: serverUrl, clientId, clientSecret, sendAdditionalBodyProperties, additionalBodyProperties, oauthTokenData
    return {
      clientId: Deno.env.get("HUBSPOT_CLIENT_ID") || "",
      clientSecret: Deno.env.get("HUBSPOT_CLIENT_SECRET") || "",
      serverUrl: "https://api.hubapi.com",
      sendAdditionalBodyProperties: false,
      additionalBodyProperties: "{}",
      oauthTokenData: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        token_type: tokens.token_type || "Bearer",
        expires_in: tokens.expires_in,
      },
    };
  }
  if (serviceName === "stripe") {
    // stripeApi schema: secretKey, signatureSecret
    return {
      secretKey: tokens.access_token as string,
    };
  }
  if (serviceName === "openai") {
    // openAiApi schema: apiKey, organizationId, url
    return {
      apiKey: (tokens.api_key || tokens.access_token) as string,
    };
  }
  if (serviceName === "supabase") {
    // supabaseApi schema: host, serviceRole
    return {
      host: Deno.env.get("SUPABASE_URL") || "",
      serviceRole: (tokens.api_key || tokens.access_token) as string,
    };
  }
  // API key services (fallback)
  return { apiKey: tokens.api_key };
}
