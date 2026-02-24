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

    const { service_name, credential_data } = await req.json();

    // Get n8n API key
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: vaultData } = await serviceClient.rpc("vault_read", {
      secret_name: "n8n_api_key",
    });
    const n8nApiKey = vaultData?.[0]?.secret || Deno.env.get("N8N_API_KEY");
    const n8nBaseUrl = Deno.env.get("N8N_BASE_URL") || "https://api.n8n.cloud/api/v1";

    // 1. Create credential in n8n
    const credName = `tenant_${user.id}_${service_name}`;
    const n8nRes = await fetch(`${n8nBaseUrl}/credentials`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-N8N-API-KEY": n8nApiKey!,
      },
      body: JSON.stringify({
        name: credName,
        type: service_name,
        data: credential_data,
      }),
    });

    if (!n8nRes.ok) {
      const errBody = await n8nRes.text();
      return new Response(JSON.stringify({ error: "n8n credential creation failed", detail: errBody }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const n8nCred = await n8nRes.json();

    // 2. Save to credentials table (upsert)
    const { data: credential, error: insertError } = await supabase
      .from("credentials")
      .upsert(
        {
          tenant_id: userData.tenant_id,
          service_name,
          n8n_credential_id: String(n8nCred.id),
          status: "connected",
        },
        { onConflict: "tenant_id,service_name" }
      )
      .select()
      .single();

    if (insertError) {
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(credential), {
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
