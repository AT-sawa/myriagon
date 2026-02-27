import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import {
  authenticate,
  corsHeaders,
  errorResponse,
  jsonResponse,
  withRetry,
} from "../_shared/common.ts";
import { getValidAccessToken } from "../_shared/token-refresh.ts";

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const ctx = await authenticate(req);
    const { tool, params } = await req.json();

    const { accessToken } = await getValidAccessToken(ctx.tenantId, "google_sheets");
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };

    switch (tool) {
      case "read_sheet": {
        const { spreadsheet_id, range } = params;
        const data = await withRetry(async () => {
          const res = await fetch(
            `${SHEETS_API}/${spreadsheet_id}/values/${encodeURIComponent(range)}`,
            { headers }
          );
          if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
          return res.json();
        });
        return jsonResponse(data);
      }

      case "write_sheet": {
        const { spreadsheet_id, range, values } = params;
        const data = await withRetry(async () => {
          const res = await fetch(
            `${SHEETS_API}/${spreadsheet_id}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
            {
              method: "PUT",
              headers,
              body: JSON.stringify({ values }),
            }
          );
          if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
          return res.json();
        });
        return jsonResponse(data);
      }

      case "list_sheets": {
        const { spreadsheet_id } = params;
        const data = await withRetry(async () => {
          const res = await fetch(
            `${SHEETS_API}/${spreadsheet_id}?fields=sheets.properties`,
            { headers }
          );
          if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
          return res.json();
        });
        return jsonResponse(data.sheets || []);
      }

      case "append_row": {
        const { spreadsheet_id, range, values } = params;
        const data = await withRetry(async () => {
          const res = await fetch(
            `${SHEETS_API}/${spreadsheet_id}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({ values: [values] }),
            }
          );
          if (!res.ok) throw new Error(`Sheets API error: ${res.status}`);
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
