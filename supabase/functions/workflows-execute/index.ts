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
      .select("id, n8n_workflow_id, tenant_id, status")
      .eq("id", workflow_id)
      .eq("tenant_id", ctx.tenantId)
      .single();

    if (wfErr || !workflow) return jsonResponse({ error: "Workflow not found" }, 404);
    if (!workflow.n8n_workflow_id) return jsonResponse({ error: "No n8n workflow linked" }, 400);

    // 2. Construct webhook URL
    const { apiKey, baseUrl } = await getN8nConfig();
    // baseUrl = https://xxx.app.n8n.cloud/api/v1 → instanceUrl = https://xxx.app.n8n.cloud
    const instanceUrl = baseUrl.replace(/\/api\/v1\/?$/, "");
    const webhookPath = `trigger-${workflow.n8n_workflow_id}`;
    const webhookUrl = `${instanceUrl}/webhook/${webhookPath}`;

    // 3. Call webhook to trigger execution
    const execRes = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        triggered_by: "manual",
        tenant_id: ctx.tenantId,
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!execRes.ok) {
      const errBody = await execRes.text();
      console.error("Webhook trigger failed:", execRes.status, errBody);
      return jsonResponse({
        error: "ワークフローの実行に失敗しました。フローが有効か確認してください。",
        detail: errBody,
      }, 502);
    }

    // 4. Log execution
    await serviceClient.from("executions").insert({
      tenant_id: ctx.tenantId,
      workflow_id: workflow_id,
      status: "running",
      started_at: new Date().toISOString(),
    });

    return jsonResponse({ success: true, message: "ワークフローを実行しました" });
  } catch (err) {
    console.error("workflows-execute error:", err);
    return errorResponse(err);
  }
});
