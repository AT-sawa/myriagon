import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import {
  authenticate,
  corsHeaders,
  errorResponse,
  jsonResponse,
  withRetry,
} from "../_shared/common.ts";
import { getValidAccessToken } from "../_shared/token-refresh.ts";

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const ctx = await authenticate(req);
    const { tool, params } = await req.json();

    const { accessToken } = await getValidAccessToken(ctx.tenantId, "gmail");
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    switch (tool) {
      case "get_emails": {
        const { query, max_results } = params;
        const q = encodeURIComponent(query || "");
        const limit = max_results || 20;
        const data = await withRetry(async () => {
          const res = await fetch(
            `${GMAIL_API}/messages?q=${q}&maxResults=${limit}`,
            { headers }
          );
          if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
          return res.json();
        });

        // Fetch full message details
        const messages = [];
        for (const msg of data.messages || []) {
          const detail = await withRetry(async () => {
            const res = await fetch(
              `${GMAIL_API}/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
              { headers }
            );
            if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
            return res.json();
          });
          messages.push(detail);
        }
        return jsonResponse({ messages, resultSizeEstimate: data.resultSizeEstimate });
      }

      case "send_email": {
        const { to, subject, body } = params;
        const raw = btoa(
          `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}`
        )
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        const data = await withRetry(async () => {
          const res = await fetch(`${GMAIL_API}/messages/send`, {
            method: "POST",
            headers,
            body: JSON.stringify({ raw }),
          });
          if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
          return res.json();
        });
        return jsonResponse(data);
      }

      case "list_labels": {
        const data = await withRetry(async () => {
          const res = await fetch(`${GMAIL_API}/labels`, { headers });
          if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
          return res.json();
        });
        return jsonResponse(data.labels || []);
      }

      case "move_email": {
        const { message_id, add_labels, remove_labels } = params;
        const data = await withRetry(async () => {
          const res = await fetch(
            `${GMAIL_API}/messages/${message_id}/modify`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                addLabelIds: add_labels || [],
                removeLabelIds: remove_labels || [],
              }),
            }
          );
          if (!res.ok) throw new Error(`Gmail API error: ${res.status}`);
          return res.json();
        });
        return jsonResponse(data);
      }

      default:
        return jsonResponse({ error: `Unknown tool: ${tool}` }, 400);
    }
  } catch (err) {
    return errorResponse(err);
  }
});
