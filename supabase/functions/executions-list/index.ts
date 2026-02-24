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

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

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

    // Get executions with workflow info
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") || "50");
    const offset = parseInt(url.searchParams.get("offset") || "0");

    const { data: executions, error, count } = await supabase
      .from("executions")
      .select("*, workflows(template_id, templates(title, services))", { count: "exact" })
      .eq("tenant_id", userData.tenant_id)
      .order("started_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Sync running executions with n8n
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: vaultData } = await serviceClient.rpc("vault_read", {
      secret_name: "n8n_api_key",
    });
    const n8nApiKey = vaultData?.[0]?.secret || Deno.env.get("N8N_API_KEY");
    const n8nBaseUrl = Deno.env.get("N8N_BASE_URL") || "https://api.n8n.cloud/api/v1";

    for (const exec of executions || []) {
      if (exec.status !== "running") continue;
      try {
        const wfId = exec.workflows?.n8n_workflow_id;
        if (!wfId) continue;
        const res = await fetch(`${n8nBaseUrl}/executions?workflowId=${wfId}&status=running`, {
          headers: { "X-N8N-API-KEY": n8nApiKey! },
        });
        if (res.ok) {
          const n8nExecs = await res.json();
          const stillRunning = n8nExecs.data?.some((e: any) => e.status === "running");
          if (!stillRunning) {
            const lastExec = n8nExecs.data?.[0];
            const newStatus = lastExec?.status === "success" ? "success" : "error";
            await supabase
              .from("executions")
              .update({
                status: newStatus,
                finished_at: new Date().toISOString(),
                error_log: lastExec?.status === "error" ? lastExec.data?.resultData?.error?.message : null,
              })
              .eq("id", exec.id);
            exec.status = newStatus;
          }
        }
      } catch {
        // n8n unreachable — keep local status
      }
    }

    return new Response(JSON.stringify({ data: executions, total: count }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
