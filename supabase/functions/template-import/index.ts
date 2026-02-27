import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import {
  authenticate,
  corsHeaders,
  errorResponse,
  jsonResponse,
} from "../_shared/common.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * template-import: n8nワークフローJSONをインポートしてテンプレート登録
 *
 * POST body:
 * {
 *   "n8n_template_id": number (optional - n8nテンプレートIDから自動取得),
 *   "workflow_json": object (optional - 直接JSONを渡す場合),
 *   "title": string,
 *   "description": string,
 *   "category": string,
 *   "parameters_schema": object (optional)
 * }
 */

// n8n node type → MYRIAGONサービス名マッピング
const NODE_TO_SERVICE: Record<string, string> = {
  "n8n-nodes-base.gmail": "gmail",
  "n8n-nodes-base.googleSheets": "google_sheets",
  "n8n-nodes-base.googleDrive": "google_drive",
  "n8n-nodes-base.googleDriveTrigger": "google_drive",
  "n8n-nodes-base.slack": "slack",
  "n8n-nodes-base.hubspot": "hubspot",
  "n8n-nodes-base.notion": "notion",
  "n8n-nodes-base.stripe": "stripe",
  "@n8n/n8n-nodes-langchain.openAi": "openai",
  "@n8n/n8n-nodes-langchain.lmChatOpenAi": "openai",
  "@n8n/n8n-nodes-langchain.lmOpenAi": "openai",
  "@n8n/n8n-nodes-langchain.lmChatAnthropic": "anthropic",
  "n8n-nodes-base.anthropic": "anthropic",
  "@n8n/n8n-nodes-langchain.agent": "openai",
};

// Sticky Note等の非実行ノードを除外
const EXCLUDED_NODE_TYPES = new Set([
  "n8n-nodes-base.stickyNote",
]);

function extractServices(nodes: Array<Record<string, unknown>>): string[] {
  const services = new Set<string>();
  for (const node of nodes) {
    const nodeType = node.type as string;
    if (EXCLUDED_NODE_TYPES.has(nodeType)) continue;
    const svc = NODE_TO_SERVICE[nodeType];
    if (svc) services.add(svc);
  }
  return Array.from(services);
}

function cleanWorkflow(workflowJson: Record<string, unknown>): Record<string, unknown> {
  // ノードからStickyNoteを除外し、クレデンシャル情報をクリア
  const nodes = (workflowJson.nodes as Array<Record<string, unknown>> || [])
    .filter((n) => !EXCLUDED_NODE_TYPES.has(n.type as string))
    .map((n) => {
      // クレデンシャルIDをプレースホルダーに置換（デプロイ時に自動注入される）
      if (n.credentials) {
        const creds = n.credentials as Record<string, Record<string, string>>;
        for (const key of Object.keys(creds)) {
          creds[key] = { id: "", name: "" };
        }
      }
      return n;
    });

  return {
    nodes,
    connections: workflowJson.connections || {},
    settings: workflowJson.settings || {},
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const ctx = await authenticate(req);
    const body = await req.json();

    let workflowData: Record<string, unknown>;

    if (body.n8n_template_id) {
      // n8nテンプレートAPIから取得
      const res = await fetch(
        `https://api.n8n.io/api/templates/workflows/${body.n8n_template_id}`
      );
      if (!res.ok) {
        return jsonResponse(
          { error: `n8n template fetch failed: ${res.status}` },
          502
        );
      }
      const templateData = await res.json();
      const wf = templateData.workflow;

      // n8nテンプレートにはネストされた workflow プロパティがある場合がある
      workflowData = wf.workflow || wf;
    } else if (body.workflow_json) {
      workflowData = body.workflow_json;
    } else {
      return jsonResponse(
        { error: "n8n_template_id or workflow_json is required" },
        400
      );
    }

    const allNodes = (workflowData.nodes as Array<Record<string, unknown>>) || [];
    const services = extractServices(allNodes);
    const cleanedWorkflow = cleanWorkflow(workflowData);

    const title = body.title || (workflowData as Record<string, unknown>).name || "Imported Workflow";
    const description = body.description || "";
    const category = body.category || "インポート";
    const parametersSchema = body.parameters_schema || { properties: {} };

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: template, error: insertError } = await serviceClient
      .from("templates")
      .insert({
        title,
        description,
        category,
        services,
        parameters_schema: parametersSchema,
        workflow_json: cleanedWorkflow,
        status: "active",
      })
      .select()
      .single();

    if (insertError) {
      return jsonResponse({ error: insertError.message }, 500);
    }

    return jsonResponse(template, 201);
  } catch (err) {
    return errorResponse(err);
  }
});
