import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticate, corsHeaders, errorResponse, jsonResponse } from "../_shared/common.ts";
import { getN8nConfig } from "../_shared/n8n.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const ctx = await authenticate(req);
    const { workflow_id } = await req.json();

    if (!workflow_id) return jsonResponse({ error: "workflow_id is required" }, 400);

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Fetch workflow + verify ownership
    const { data: workflow, error: wfErr } = await serviceClient
      .from("workflows")
      .select("id, n8n_workflow_id, tenant_id")
      .eq("id", workflow_id)
      .eq("tenant_id", ctx.tenantId)
      .single();

    if (wfErr || !workflow) return jsonResponse({ error: "Workflow not found" }, 404);

    // 2. Delete from n8n (best-effort)
    if (workflow.n8n_workflow_id) {
      try {
        const { apiKey, baseUrl } = await getN8nConfig();
        // Deactivate first
        await fetch(`${baseUrl}/workflows/${workflow.n8n_workflow_id}/deactivate`, {
          method: "POST",
          headers: { "X-N8N-API-KEY": apiKey },
        });
        // Then delete
        await fetch(`${baseUrl}/workflows/${workflow.n8n_workflow_id}`, {
          method: "DELETE",
          headers: { "X-N8N-API-KEY": apiKey },
        });
      } catch (e) {
        console.warn("n8n delete failed (continuing):", (e as Error).message);
      }
    }

    // 3. Delete executions first, then workflow
    await serviceClient.from("executions").delete().eq("workflow_id", workflow_id);
    await serviceClient.from("workflows").delete().eq("id", workflow_id);

    return jsonResponse({ success: true });
  } catch (err) {
    console.error("workflows-delete error:", err);
    return errorResponse(err);
  }
});
