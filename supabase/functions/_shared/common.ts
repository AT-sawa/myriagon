import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── Types ───────────────────────────────────────────────────
export interface AuthContext {
  supabase: SupabaseClient;
  userId: string;
  tenantId: string;
  plan: "free" | "starter" | "growth" | "enterprise";
}

// ─── Plan Limits ─────────────────────────────────────────────
export const PLAN_LIMITS: Record<string, { maxWorkflows: number; maxExecutionsPerMonth: number; maxServices: number }> = {
  free:       { maxWorkflows: 2,       maxExecutionsPerMonth: 50,    maxServices: 2 },
  starter:    { maxWorkflows: 5,       maxExecutionsPerMonth: 1000,  maxServices: 5 },
  growth:     { maxWorkflows: Infinity, maxExecutionsPerMonth: 10000, maxServices: Infinity },
  enterprise: { maxWorkflows: Infinity, maxExecutionsPerMonth: Infinity, maxServices: Infinity },
};

export class PlanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanLimitError";
  }
}

// ─── CORS Headers ────────────────────────────────────────────
const ALLOWED_ORIGIN = Deno.env.get("FRONTEND_URL") || "https://myriagon.app";
export const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Rate Limiter (tenant-level, 100 req/min) ────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(tenantId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(tenantId);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(tenantId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= 100) return false;
  entry.count++;
  return true;
}

// ─── Auth Middleware ──────────────────────────────────────────
export async function authenticate(req: Request): Promise<AuthContext> {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: req.headers.get("Authorization")! } } }
  );

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) throw new AuthError("Unauthorized");

  const { data: userData } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("auth_uid", user.id)
    .single();

  if (!userData) throw new AuthError("User not found in tenant");

  if (!checkRateLimit(userData.tenant_id)) {
    throw new RateLimitError("Rate limit exceeded (100 req/min)");
  }

  // Fetch tenant plan
  const serviceClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const { data: tenant } = await serviceClient
    .from("tenants")
    .select("plan")
    .eq("id", userData.tenant_id)
    .single();

  const plan = (tenant?.plan || "free") as AuthContext["plan"];

  return { supabase, userId: user.id, tenantId: userData.tenant_id, plan };
}

// ─── Retry Helper (3 attempts) ──────────────────────────────
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delayMs = 500
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delayMs * attempt));
      }
    }
  }
  throw lastError;
}

// ─── Logging ─────────────────────────────────────────────────
export async function logExecution(
  supabase: SupabaseClient,
  tenantId: string,
  workflowId: string,
  status: "running" | "success" | "error",
  errorLog?: string
) {
  await supabase.from("executions").insert({
    tenant_id: tenantId,
    workflow_id: workflowId,
    status,
    started_at: new Date().toISOString(),
    finished_at: status !== "running" ? new Date().toISOString() : null,
    error_log: errorLog || null,
  });
}

// ─── Error Classes ───────────────────────────────────────────
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

// ─── Error Response Builder ──────────────────────────────────
export function errorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (err instanceof RateLimitError) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (err instanceof PlanLimitError) {
    return new Response(JSON.stringify({ error: err.message, code: "PLAN_LIMIT" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const message = err instanceof Error ? err.message : "Internal Server Error";
  return new Response(JSON.stringify({ error: message }), {
    status: 500,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ─── JSON Response Builder ───────────────────────────────────
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
