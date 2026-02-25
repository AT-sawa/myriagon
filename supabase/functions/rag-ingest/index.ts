import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticate, corsHeaders, errorResponse, jsonResponse } from "../_shared/common.ts";

// ─── Text Chunking ───────────────────────────────────────────
function chunkText(text: string, chunkSize = 500, overlap = 50): string[] {
  const chunks: string[] = [];
  const sentences = text.split(/(?<=[。．.！!？?\n])/);
  let current = "";

  for (const sentence of sentences) {
    if ((current + sentence).length > chunkSize && current.length > 0) {
      chunks.push(current.trim());
      // Keep overlap from end of previous chunk
      const words = current.split("");
      current = words.slice(-overlap).join("") + sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// ─── Get Embeddings via OpenAI ───────────────────────────────
async function getEmbeddings(texts: string[], apiKey: string): Promise<number[][]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenAI Embeddings API error: ${err}`);
  }

  const data = await response.json();
  return data.data.map((d: { embedding: number[] }) => d.embedding);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { supabase, tenantId } = await authenticate(req);

    const { document_id, kb_id, content, filename, file_type } = await req.json();

    if (!content || !filename) {
      return jsonResponse({ error: "content and filename are required" }, 400);
    }

    // Service role client for bypassing RLS on chunk inserts
    const serviceClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Get OpenAI key from Supabase Vault or env
    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return jsonResponse({ error: "OpenAI API key not configured" }, 500);
    }

    // Create or use existing document record
    let docId = document_id;
    if (!docId) {
      const { data: doc, error: docErr } = await serviceClient
        .from("knowledge_documents")
        .insert({
          tenant_id: tenantId,
          filename,
          file_type: file_type || "text/plain",
          status: "processing",
        })
        .select("id")
        .single();

      if (docErr) throw docErr;
      docId = doc.id;
    } else {
      await serviceClient
        .from("knowledge_documents")
        .update({ status: "processing" })
        .eq("id", docId);
    }

    // Chunk the text
    const chunks = chunkText(content);

    // Generate embeddings in batches of 20
    const batchSize = 20;
    let totalInserted = 0;
    let totalTokens = 0;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const embeddings = await getEmbeddings(batch, openaiKey);

      const rows = batch.map((text, j) => ({
        tenant_id: tenantId,
        document_id: docId,
        kb_id: kb_id || null,
        chunk_index: i + j,
        content: text,
        embedding: JSON.stringify(embeddings[j]),
        token_count: Math.ceil(text.length / 3), // rough estimate
        metadata: { filename, chunk: i + j, total_chunks: chunks.length },
      }));

      const { error: insertErr } = await serviceClient
        .from("knowledge_chunks")
        .insert(rows);

      if (insertErr) throw insertErr;
      totalInserted += rows.length;
      totalTokens += rows.reduce((sum, r) => sum + r.token_count, 0);
    }

    // Update document status
    await serviceClient
      .from("knowledge_documents")
      .update({
        status: "ready",
        chunk_count: totalInserted,
        file_size: new TextEncoder().encode(content).length,
      })
      .eq("id", docId);

    // Update KB stats if linked
    if (kb_id) {
      const { data: kbChunks } = await serviceClient
        .from("knowledge_chunks")
        .select("id", { count: "exact", head: true })
        .eq("kb_id", kb_id);

      const { data: kbDocs } = await serviceClient
        .from("knowledge_chunks")
        .select("document_id")
        .eq("kb_id", kb_id);

      const uniqueDocs = new Set(kbDocs?.map((c) => c.document_id) || []);

      await serviceClient
        .from("knowledge_bases")
        .update({
          vector_count: kbChunks?.length || totalInserted,
          doc_count: uniqueDocs.size,
          status: "ready",
        })
        .eq("id", kb_id);
    }

    return jsonResponse({
      success: true,
      document_id: docId,
      chunks_created: totalInserted,
      estimated_tokens: totalTokens,
    });
  } catch (err) {
    return errorResponse(err);
  }
});
