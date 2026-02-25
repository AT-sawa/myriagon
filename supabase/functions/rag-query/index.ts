import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticate, corsHeaders, errorResponse, jsonResponse } from "../_shared/common.ts";

// ─── Get Embedding for query ─────────────────────────────────
async function getQueryEmbedding(text: string, apiKey: string): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI Embeddings API error: ${err}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

// ─── Generate answer with context ────────────────────────────
async function generateAnswer(
  query: string,
  contexts: { content: string; metadata: Record<string, unknown> }[],
  apiKey: string
): Promise<string> {
  const contextText = contexts
    .map((c, i) => `[${i + 1}] ${c.content}`)
    .join("\n\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `あなたはナレッジベースの情報に基づいて質問に回答するアシスタントです。
以下のコンテキスト情報のみを使って回答してください。
コンテキストに情報がない場合は「この情報はナレッジベースに見つかりませんでした」と回答してください。
回答は日本語で、簡潔かつ正確にしてください。`,
        },
        {
          role: "user",
          content: `コンテキスト:\n${contextText}\n\n質問: ${query}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 1000,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI Chat API error: ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { supabase, tenantId } = await authenticate(req);

    const {
      query,
      kb_id,
      threshold = 0.7,
      top_k = 5,
      generate_answer = true,
    } = await req.json();

    if (!query) {
      return jsonResponse({ error: "query is required" }, 400);
    }

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return jsonResponse({ error: "OpenAI API key not configured" }, 500);
    }

    // Service role client for RPC call
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get query embedding
    const queryEmbedding = await getQueryEmbedding(query, openaiKey);

    // Similarity search via the match_chunks function
    const { data: matches, error: matchErr } = await serviceClient.rpc(
      "match_chunks",
      {
        query_embedding: JSON.stringify(queryEmbedding),
        match_tenant_id: tenantId,
        match_kb_id: kb_id || null,
        match_threshold: threshold,
        match_count: top_k,
      }
    );

    if (matchErr) throw matchErr;

    const results = (matches || []).map((m: {
      id: string;
      document_id: string;
      content: string;
      metadata: Record<string, unknown>;
      similarity: number;
    }) => ({
      chunk_id: m.id,
      document_id: m.document_id,
      content: m.content,
      metadata: m.metadata,
      similarity: m.similarity,
    }));

    // Optionally generate an answer using GPT
    let answer: string | null = null;
    if (generate_answer && results.length > 0) {
      answer = await generateAnswer(query, results, openaiKey);
    } else if (generate_answer && results.length === 0) {
      answer = "この質問に関連する情報がナレッジベースに見つかりませんでした。";
    }

    return jsonResponse({
      query,
      answer,
      sources: results,
      total_matches: results.length,
    });
  } catch (err) {
    return errorResponse(err);
  }
});
