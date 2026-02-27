import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import {
  authenticate,
  corsHeaders,
  errorResponse,
  jsonResponse,
  withRetry,
} from "../_shared/common.ts";
import { getValidAccessToken } from "../_shared/token-refresh.ts";

const SLACK_API = "https://slack.com/api";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const ctx = await authenticate(req);
    const { tool, params } = await req.json();

    const { accessToken: token } = await getValidAccessToken(ctx.tenantId, "slack");
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    switch (tool) {
      case "send_message": {
        const { channel, text, blocks } = params;
        const data = await withRetry(async () => {
          const res = await fetch(`${SLACK_API}/chat.postMessage`, {
            method: "POST",
            headers,
            body: JSON.stringify({ channel, text, blocks }),
          });
          if (!res.ok) throw new Error(`Slack API error: ${res.status}`);
          return res.json();
        });
        if (!data.ok) throw new Error(`Slack error: ${data.error}`);
        return jsonResponse(data);
      }

      case "list_channels": {
        const { types, limit } = params || {};
        const data = await withRetry(async () => {
          const res = await fetch(
            `${SLACK_API}/conversations.list?types=${types || "public_channel"}&limit=${limit || 100}`,
            { headers }
          );
          if (!res.ok) throw new Error(`Slack API error: ${res.status}`);
          return res.json();
        });
        if (!data.ok) throw new Error(`Slack error: ${data.error}`);
        return jsonResponse(data.channels || []);
      }

      case "get_history": {
        const { channel, limit } = params;
        const data = await withRetry(async () => {
          const res = await fetch(
            `${SLACK_API}/conversations.history?channel=${channel}&limit=${limit || 50}`,
            { headers }
          );
          if (!res.ok) throw new Error(`Slack API error: ${res.status}`);
          return res.json();
        });
        if (!data.ok) throw new Error(`Slack error: ${data.error}`);
        return jsonResponse(data.messages || []);
      }

      default:
        return jsonResponse({ error: `Unknown tool: ${tool}` }, 400);
    }
  } catch (err) {
    return errorResponse(err);
  }
});
