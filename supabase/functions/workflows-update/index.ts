import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticate, corsHeaders, errorResponse, jsonResponse } from "../_shared/common.ts";
import { getN8nConfig, N8N_CRED_TYPE_MAP, NODE_TYPE_TO_SERVICE } from "../_shared/n8n.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const ctx = await authenticate(req);
    const { workflow_id, parameters, schedule, status } = await req.json();

    if (!workflow_id) return jsonResponse({ error: "workflow_id is required" }, 400);

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Fetch workflow + verify ownership
    const { data: workflow, error: wfErr } = await serviceClient
      .from("workflows")
      .select("*, templates(workflow_json, parameters_schema, services)")
      .eq("id", workflow_id)
      .eq("tenant_id", ctx.tenantId)
      .single();

    if (wfErr || !workflow) return jsonResponse({ error: "Workflow not found" }, 404);
    if (!workflow.n8n_workflow_id) return jsonResponse({ error: "No n8n workflow linked" }, 400);

    const { apiKey, baseUrl } = await getN8nConfig();

    // 2. Handle status-only toggle (activate/deactivate in n8n)
    if (status && !parameters && !schedule) {
      const endpoint = status === "active" ? "activate" : "deactivate";
      const res = await fetch(`${baseUrl}/workflows/${workflow.n8n_workflow_id}/${endpoint}`, {
        method: "POST",
        headers: { "X-N8N-API-KEY": apiKey },
      });
      if (!res.ok) {
        const errBody = await res.text();
        console.error(`n8n ${endpoint} failed:`, errBody);
      }
      await serviceClient.from("workflows").update({ status, updated_at: new Date().toISOString() }).eq("id", workflow_id);
      return jsonResponse({ success: true, status });
    }

    // 3. Re-substitute parameters in template workflow_json
    const template = workflow.templates;
    if (!template?.workflow_json) return jsonResponse({ error: "Template not found" }, 400);

    const newParams = parameters || workflow.parameters || {};

    let wfStr = JSON.stringify(template.workflow_json);
    for (const [key, value] of Object.entries(newParams)) {
      wfStr = wfStr.replaceAll(`{{${key}}}`, String(value));
    }
    const workflowJson = JSON.parse(wfStr);

    // 4. Update schedule trigger node if schedule provided
    if (schedule) {
      const triggerIdx = (workflowJson.nodes || []).findIndex(
        (n: Record<string, unknown>) => {
          const t = n.type as string;
          return t?.includes("scheduleTrigger");
        }
      );
      if (triggerIdx >= 0) {
        const newRule = buildScheduleRule(schedule);
        workflowJson.nodes[triggerIdx].parameters = {
          ...workflowJson.nodes[triggerIdx].parameters,
          rule: { interval: [newRule] },
        };
      }
    }

    // 5. Re-inject credentials
    const { data: creds } = await serviceClient
      .from("credentials")
      .select("service_name, n8n_credential_id")
      .eq("tenant_id", ctx.tenantId)
      .eq("status", "connected");

    const credMap: Record<string, string> = {};
    for (const c of creds || []) {
      if (c.n8n_credential_id) credMap[c.service_name] = c.n8n_credential_id;
    }

    workflowJson.nodes = (workflowJson.nodes || []).map((node: Record<string, unknown>) => {
      const svc = NODE_TYPE_TO_SERVICE[node.type as string];
      if (svc && credMap[svc]) {
        const credType = N8N_CRED_TYPE_MAP[svc];
        if (credType) {
          node.credentials = {
            ...(node.credentials as Record<string, unknown> || {}),
            [credType]: { id: credMap[svc], name: `tenant_${ctx.tenantId}_${svc}` },
          };
        }
      }
      return node;
    });

    // 6. PUT n8n workflow (n8n API uses PUT, not PATCH)
    // First get the current workflow name
    const getRes = await fetch(`${baseUrl}/workflows/${workflow.n8n_workflow_id}`, {
      headers: { "X-N8N-API-KEY": apiKey },
    });
    const currentN8n = getRes.ok ? await getRes.json() : {};

    const patchRes = await fetch(`${baseUrl}/workflows/${workflow.n8n_workflow_id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-N8N-API-KEY": apiKey },
      body: JSON.stringify({
        name: currentN8n.name || `${ctx.tenantId}_workflow`,
        nodes: workflowJson.nodes,
        connections: workflowJson.connections || {},
        settings: workflowJson.settings || {},
      }),
    });

    if (!patchRes.ok) {
      const errBody = await patchRes.text();
      console.error("n8n PATCH failed:", errBody);
      return jsonResponse({ error: "n8n workflow update failed", detail: errBody }, 502);
    }

    // 7. Update DB
    const updateData: Record<string, unknown> = {
      parameters: newParams,
      updated_at: new Date().toISOString(),
    };
    if (status) updateData.status = status;

    await serviceClient.from("workflows").update(updateData).eq("id", workflow_id);

    return jsonResponse({ success: true });
  } catch (err) {
    console.error("workflows-update error:", err);
    return errorResponse(err);
  }
});

function buildScheduleRule(schedule: { type: string; value?: number | string; hour?: number; day?: number }) {
  switch (schedule.type) {
    case "minutes":
      return { field: "minutes", minutesInterval: Number(schedule.value) || 5 };
    case "hourly":
      return { field: "hours", hoursInterval: Number(schedule.value) || 1 };
    case "daily":
      return { field: "hours", hoursInterval: 24, triggerAtHour: Number(schedule.hour ?? schedule.value ?? 9) };
    case "weekly":
      return { field: "weeks", triggerAtDay: Number(schedule.day ?? 1), triggerAtHour: Number(schedule.hour ?? 9) };
    case "cron":
      return { field: "cronExpression", expression: String(schedule.value) };
    default:
      return { field: "minutes", minutesInterval: 5 };
  }
}
