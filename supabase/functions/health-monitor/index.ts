import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Health check endpoints for each service
const SERVICE_ENDPOINTS: Record<string, string> = {
  google_sheets: "https://www.googleapis.com/oauth2/v1/tokeninfo",
  gmail: "https://www.googleapis.com/oauth2/v1/tokeninfo",
  google_drive: "https://www.googleapis.com/oauth2/v1/tokeninfo",
  slack: "https://slack.com/api/api.test",
  openai: "https://api.openai.com/v1/models",
  anthropic: "https://api.anthropic.com/v1/messages",
  notion: "https://api.notion.com/v1/users/me",
  hubspot: "https://api.hubapi.com/crm/v3/objects/contacts?limit=1",
  supabase: "https://api.supabase.com/v1/projects",
  stripe: "https://api.stripe.com/v1/balance",
};

serve(async (_req) => {
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const failedServices: string[] = [];

    // 1. Ping each service
    for (const [service, url] of Object.entries(SERVICE_ENDPOINTS)) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, {
          method: "HEAD",
          signal: controller.signal,
        });
        clearTimeout(timeout);
        // We only check if the endpoint is reachable (even 401 = service is up)
        if (res.status >= 500) {
          failedServices.push(service);
        }
      } catch {
        failedServices.push(service);
      }
    }

    // 2. Mark templates using failed services as "maintenance"
    if (failedServices.length > 0) {
      const { data: templates } = await supabase
        .from("templates")
        .select("id, services, status")
        .eq("status", "active");

      for (const tpl of templates || []) {
        const affected = (tpl.services as string[]).some((s: string) =>
          failedServices.includes(s)
        );
        if (affected) {
          await supabase
            .from("templates")
            .update({ status: "maintenance" })
            .eq("id", tpl.id);
        }
      }

      // 3. Send Slack alert
      const slackWebhookUrl = Deno.env.get("SLACK_WEBHOOK_URL");
      if (slackWebhookUrl) {
        await fetch(slackWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: `[MYRIAGON Health Alert] Services down: ${failedServices.join(", ")}. Affected templates moved to maintenance.`,
          }),
        });
      }
    }

    // Restore templates whose services are all back up
    const { data: maintenanceTemplates } = await supabase
      .from("templates")
      .select("id, services")
      .eq("status", "maintenance");

    for (const tpl of maintenanceTemplates || []) {
      const allUp = (tpl.services as string[]).every(
        (s: string) => !failedServices.includes(s)
      );
      if (allUp) {
        await supabase
          .from("templates")
          .update({ status: "active" })
          .eq("id", tpl.id);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        checked_at: new Date().toISOString(),
        failed_services: failedServices,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
