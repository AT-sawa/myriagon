import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "https://esm.sh/stripe@14?target=deno";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, stripe-signature",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");

  if (!stripeKey || !webhookSecret) {
    return new Response(JSON.stringify({ error: "Stripe not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const stripe = new Stripe(stripeKey, { apiVersion: "2023-10-16" });
  const body = await req.text();
  const signature = req.headers.get("stripe-signature");

  if (!signature) {
    return new Response(JSON.stringify({ error: "Missing signature" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch (err) {
    console.error("Webhook signature verification failed:", (err as Error).message);
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  try {
    switch (event.type) {
      // ─── Checkout completed → activate subscription ───
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        const tenantId = session.metadata?.tenant_id;
        const plan = session.metadata?.plan;

        if (tenantId && plan) {
          await supabase
            .from("tenants")
            .update({
              plan,
              stripe_subscription_id: session.subscription as string,
              stripe_customer_id: session.customer as string,
            })
            .eq("id", tenantId);

          console.log(`Tenant ${tenantId} upgraded to ${plan}`);
        }
        break;
      }

      // ─── Subscription updated (plan change) ───
      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        const { data: tenant } = await supabase
          .from("tenants")
          .select("id")
          .eq("stripe_customer_id", customerId)
          .single();

        if (tenant) {
          const status = subscription.status;
          if (status === "active" || status === "trialing") {
            // Keep current plan
          } else if (status === "past_due" || status === "unpaid") {
            console.warn(`Tenant ${tenant.id} subscription ${status}`);
          }
        }
        break;
      }

      // ─── Subscription cancelled → downgrade to starter ───
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const customerId = subscription.customer as string;

        const { data: tenant } = await supabase
          .from("tenants")
          .select("id")
          .eq("stripe_customer_id", customerId)
          .single();

        if (tenant) {
          await supabase
            .from("tenants")
            .update({
              plan: "starter",
              stripe_subscription_id: null,
            })
            .eq("id", tenant.id);

          console.log(`Tenant ${tenant.id} downgraded to starter (subscription cancelled)`);
        }
        break;
      }

      // ─── Payment failed ───
      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        const customerId = invoice.customer as string;
        console.warn(`Payment failed for customer ${customerId}`);
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Webhook handler error:", (err as Error).message);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
