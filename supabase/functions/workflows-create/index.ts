import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { N8N_CRED_TYPE_MAP, NODE_TYPE_TO_SERVICE, getN8nConfig } from "../_shared/n8n.ts";
import { PLAN_LIMITS } from "../_shared/common.ts";

const ALLOWED_ORIGIN = Deno.env.get("FRONTEND_URL") || "https://myriagon.app";
const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// NODE_TYPE_TO_SERVICE is imported from _shared/n8n.ts

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
    );

    // Verify auth
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get tenant_id
    const { data: userData } = await supabase
      .from("users")
      .select("tenant_id")
      .eq("auth_uid", user.id)
      .single();

    if (!userData) {
      return new Response(JSON.stringify({ error: "User not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Plan limit check: max workflows ──
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: tenant } = await serviceClient
      .from("tenants")
      .select("plan")
      .eq("id", userData.tenant_id)
      .single();
    const plan = tenant?.plan || "starter";
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.starter;

    const { count: workflowCount } = await supabase
      .from("workflows")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", userData.tenant_id)
      .in("status", ["active", "paused"]);

    if ((workflowCount || 0) >= limits.maxWorkflows) {
      return new Response(JSON.stringify({
        error: `${plan}プランのフロー上限（${limits.maxWorkflows}個）に達しています。プランをアップグレードしてください。`,
        code: "PLAN_LIMIT",
      }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Plan limit check: max executions per month ──
    if (limits.maxExecutionsPerMonth !== Infinity) {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const { count: execCount } = await serviceClient
        .from("executions")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", userData.tenant_id)
        .gte("started_at", monthStart.toISOString());

      if ((execCount || 0) >= limits.maxExecutionsPerMonth) {
        return new Response(JSON.stringify({
          error: `${plan}プランの月間実行上限（${limits.maxExecutionsPerMonth}回）に達しています。プランをアップグレードしてください。`,
          code: "PLAN_LIMIT",
        }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const { template_id, parameters } = await req.json();

    // 1. Get template workflow_json
    const { data: template, error: tplError } = await supabase
      .from("templates")
      .select("workflow_json, title, services")
      .eq("id", template_id)
      .single();

    if (tplError || !template) {
      return new Response(JSON.stringify({ error: "Template not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Replace {{variables}} in workflow_json
    let workflowStr = JSON.stringify(template.workflow_json);
    for (const [key, value] of Object.entries(parameters)) {
      workflowStr = workflowStr.replaceAll(`{{${key}}}`, String(value));
    }
    const workflowJson = JSON.parse(workflowStr);

    // 3. Get n8n API key from Vault
    const { apiKey: n8nApiKey, baseUrl: n8nBaseUrl } = await getN8nConfig();

    // 3.5 Load tenant credentials and bind to workflow nodes
    const { data: creds } = await serviceClient
      .from("credentials")
      .select("service_name, n8n_credential_id")
      .eq("tenant_id", userData.tenant_id)
      .eq("status", "connected");

    const credMap: Record<string, string> = {};
    for (const c of creds || []) {
      if (c.n8n_credential_id) {
        credMap[c.service_name] = c.n8n_credential_id;
      }
    }

    // Check that all required services have n8n credentials
    const requiredServices = new Set<string>();
    for (const node of (workflowJson.nodes || [])) {
      const svc = NODE_TYPE_TO_SERVICE[node.type as string];
      if (svc) requiredServices.add(svc);
    }
    const missingCreds = [...requiredServices].filter(svc => !credMap[svc]);
    if (missingCreds.length > 0) {
      const svcNames = missingCreds.join(", ");
      return new Response(JSON.stringify({
        error: `以下のサービスが未接続です: ${svcNames}。先に「接続」ページからサービスを接続してください。`,
        code: "MISSING_CREDENTIALS",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Inject n8n credentials into each node
    const nodes = (workflowJson.nodes || []).map((node: Record<string, unknown>) => {
      const nodeType = node.type as string;
      const serviceName = NODE_TYPE_TO_SERVICE[nodeType];
      if (serviceName && credMap[serviceName]) {
        const n8nCredType = N8N_CRED_TYPE_MAP[serviceName];
        if (n8nCredType) {
          node.credentials = {
            ...(node.credentials as Record<string, unknown> || {}),
            [n8nCredType]: {
              id: credMap[serviceName],
              name: `tenant_${userData.tenant_id}_${serviceName}`,
            },
          };
        }
      }
      return node;
    });

    // 3.7 Auto-inject webhook trigger for manual execution
    const hasWebhook = nodes.some((n: Record<string, unknown>) =>
      (n.type as string)?.includes("webhook")
    );
    if (!hasWebhook) {
      const triggerNode = nodes.find((n: Record<string, unknown>) => {
        const t = n.type as string;
        return t?.includes("Trigger") || t?.includes("trigger");
      });
      if (triggerNode) {
        const triggerName = triggerNode.name as string;
        const triggerConns = workflowJson.connections?.[triggerName];
        if (triggerConns?.main?.[0]?.[0]) {
          const nextNodeName = triggerConns.main[0][0].node;
          const webhookPlaceholder = crypto.randomUUID().slice(0, 8);
          nodes.push({
            id: "webhook_auto",
            name: "手動実行",
            type: "n8n-nodes-base.webhook",
            typeVersion: 2,
            position: [-200, 500],
            parameters: {
              path: webhookPlaceholder,
              httpMethod: "POST",
              responseMode: "onReceived",
              options: {},
            },
            webhookId: webhookPlaceholder,
          } as unknown as Record<string, unknown>);
          workflowJson.connections["手動実行"] = {
            main: [[{ node: nextNodeName, type: "main", index: 0 }]],
          };
        }
      }
    }

    // 4. Create workflow in n8n
    const n8nCreateRes = await fetch(`${n8nBaseUrl}/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-N8N-API-KEY": n8nApiKey!,
      },
      body: JSON.stringify({
        name: `${userData.tenant_id}_${template.title}`,
        nodes,
        connections: workflowJson.connections || {},
        settings: workflowJson.settings || {},
      }),
    });

    if (!n8nCreateRes.ok) {
      const errBody = await n8nCreateRes.text();
      return new Response(JSON.stringify({ error: "n8n workflow creation failed", detail: errBody }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const n8nWorkflow = await n8nCreateRes.json();

    // 4.5 Update webhook path to use n8n workflow ID (predictable URL)
    const webhookNode = nodes.find((n: Record<string, unknown>) => n.id === "webhook_auto");
    if (webhookNode) {
      const webhookPath = `trigger-${n8nWorkflow.id}`;
      (webhookNode.parameters as Record<string, unknown>).path = webhookPath;
      (webhookNode as Record<string, unknown>).webhookId = webhookPath;
      await fetch(`${n8nBaseUrl}/workflows/${n8nWorkflow.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-N8N-API-KEY": n8nApiKey! },
        body: JSON.stringify({
          name: `${userData.tenant_id}_${template.title}`,
          nodes,
          connections: workflowJson.connections || {},
          settings: workflowJson.settings || {},
        }),
      });
    }

    // 5. Activate the workflow
    await fetch(`${n8nBaseUrl}/workflows/${n8nWorkflow.id}/activate`, {
      method: "POST",
      headers: { "X-N8N-API-KEY": n8nApiKey! },
    });

    // 6. Save to workflows table
    const { data: workflow, error: insertError } = await supabase
      .from("workflows")
      .insert({
        tenant_id: userData.tenant_id,
        template_id,
        n8n_workflow_id: String(n8nWorkflow.id),
        parameters,
        status: "active",
      })
      .select()
      .single();

    if (insertError) {
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(workflow), {
      status: 201,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
