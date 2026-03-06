import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticate, corsHeaders, errorResponse, jsonResponse } from "../_shared/common.ts";

const SYSTEM_PROMPT = `あなたはワークフロー自動化プラットフォーム「MYRIAGON」のアシスタントです。
ユーザーが自然言語で記述した業務自動化の要望に対して、利用可能なテンプレートの中から最適なものを提案してください。

以下のJSON形式で必ず回答してください:
{
  "matches": [
    {
      "template_id": "テンプレートのUUID",
      "score": 0.0〜1.0の関連度スコア,
      "reason": "このテンプレートが適している理由（日本語で1〜2文）"
    }
  ],
  "has_match": true または false,
  "suggestion": "ユーザーへの一言メッセージ（日本語）"
}

ルール:
- scoreが0.5以上のテンプレートのみmatchesに含めてください
- matchesはscore降順で最大3件まで
- 該当するテンプレートがない場合はmatches=[]、has_match=falseにしてください
- has_match=falseの場合、suggestionに「お探しの自動化はまだテンプレートにありません。リクエストとして保存できます。」と記載してください
- ユーザーの要望が曖昧でも、部分的に合致するテンプレートがあれば提案してください
- テンプレートの説明文とサービス名をよく参照して判断してください`;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const ctx = await authenticate(req);
    const { description, save_request } = await req.json();

    if (!description || !description.trim()) {
      return jsonResponse({ error: "description is required" }, 400);
    }

    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Save mode: store flow request
    if (save_request) {
      const { error: insertErr } = await serviceClient
        .from("flow_requests")
        .insert({
          tenant_id: ctx.tenantId,
          auth_uid: ctx.userId,
          description: description.trim(),
        });
      if (insertErr) throw insertErr;
      return jsonResponse({ saved: true, message: "リクエストを保存しました" });
    }

    // Search mode: AI matching
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return jsonResponse({ error: "OpenAI API key not configured" }, 500);
    }

    const { data: templates, error: tplErr } = await serviceClient
      .from("templates")
      .select("id, title, description, category, services")
      .eq("status", "active");

    if (tplErr) throw tplErr;

    if (!templates || templates.length === 0) {
      return jsonResponse({ matches: [], has_match: false, suggestion: "テンプレートがまだ登録されていません。" });
    }

    const templateList = templates.map((t, i) =>
      `[${i + 1}] ID: ${t.id}\nタイトル: ${t.title}\n説明: ${t.description || ""}\nカテゴリ: ${t.category || ""}\nサービス: ${(t.services || []).join(", ")}`
    ).join("\n\n");

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `ユーザーの要望:\n${description.trim()}\n\n利用可能なテンプレート:\n${templateList}` },
        ],
        temperature: 0.3,
        max_tokens: 1500,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content;
    const result = JSON.parse(content);

    return jsonResponse(result);
  } catch (err) {
    console.error("flow-suggest error:", err);
    return errorResponse(err);
  }
});
