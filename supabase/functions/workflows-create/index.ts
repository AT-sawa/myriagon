import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: vaultData } = await serviceClient.rpc("vault_read", {
      secret_name: "n8n_api_key",
    });
    const n8nApiKey = vaultData?.[0]?.secret || Deno.env.get("N8N_API_KEY");
    const n8nBaseUrl = Deno.env.get("N8N_BASE_URL") || "https://api.n8n.cloud/api/v1";

    // 4. Create workflow in n8n
    const n8nCreateRes = await fetch(`${n8nBaseUrl}/workflows`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-N8N-API-KEY": n8nApiKey!,
      },
      body: JSON.stringify({
        name: `${userData.tenant_id}_${template.title}`,
        nodes: workflowJson.nodes || [],
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
