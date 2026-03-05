import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("FRONTEND_URL") || "https://myriagon.app";
const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
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

    // Use service client to bypass RLS for the join query (tenant_id already verified)
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: workflows, error } = await serviceClient
      .from("workflows")
      .select("*, templates(title, services, description)")
      .eq("tenant_id", userData.tenant_id)
      .order("created_at", { ascending: false });

    if (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Sync with n8n (best-effort, don't block response)
    try {
      const n8nApiKey = Deno.env.get("N8N_API_KEY") || "";
      const n8nBaseUrl = Deno.env.get("N8N_BASE_URL") || "";
      if (n8nApiKey && n8nBaseUrl) {
        for (const wf of workflows || []) {
          if (!wf.n8n_workflow_id) continue;
          try {
            const res = await fetch(`${n8nBaseUrl}/workflows/${wf.n8n_workflow_id}`, {
              headers: { "X-N8N-API-KEY": n8nApiKey },
              signal: AbortSignal.timeout(3000),
            });
            if (res.ok) {
              const n8nWf = await res.json();
              const newStatus = n8nWf.active ? "active" : "inactive";
              if (newStatus !== wf.status) {
                await serviceClient
                  .from("workflows")
                  .update({ status: newStatus })
                  .eq("id", wf.id);
                wf.status = newStatus;
              }
            }
          } catch {
            // n8n unreachable for this workflow — skip
          }
        }
      }
    } catch (syncErr) {
      console.warn("n8n sync skipped:", (syncErr as Error).message);
    }

    return new Response(JSON.stringify(workflows), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
