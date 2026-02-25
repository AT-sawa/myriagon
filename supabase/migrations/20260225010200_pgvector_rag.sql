-- 012_pgvector_rag.sql
-- Enable pgvector and add embedding infrastructure for RAG

-- Enable the vector extension
create extension if not exists vector with schema extensions;

-- Document chunks with embeddings
create table knowledge_chunks (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  document_id uuid not null references knowledge_documents(id) on delete cascade,
  kb_id       uuid references knowledge_bases(id) on delete set null,
  chunk_index integer not null default 0,
  content     text not null,
  metadata    jsonb default '{}',
  embedding   extensions.vector(1536),  -- OpenAI text-embedding-3-small dimension
  token_count integer default 0,
  created_at  timestamptz not null default now()
);

create index idx_chunks_tenant on knowledge_chunks(tenant_id);
create index idx_chunks_document on knowledge_chunks(document_id);
create index idx_chunks_kb on knowledge_chunks(kb_id);

-- HNSW index for fast similarity search (cosine distance)
create index idx_chunks_embedding on knowledge_chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- RLS for knowledge_chunks
alter table knowledge_chunks enable row level security;

create policy "Users can view own tenant chunks"
  on knowledge_chunks for select
  using (tenant_id = public.get_tenant_id());

create policy "Users can insert own tenant chunks"
  on knowledge_chunks for insert
  with check (tenant_id = public.get_tenant_id());

create policy "Users can delete own tenant chunks"
  on knowledge_chunks for delete
  using (tenant_id = public.get_tenant_id());

-- Similarity search function (bypasses RLS for service role, filtered by tenant)
create or replace function match_chunks(
  query_embedding extensions.vector(1536),
  match_tenant_id uuid,
  match_kb_id uuid default null,
  match_threshold float default 0.7,
  match_count int default 5
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  similarity float
)
language plpgsql security definer
as $$
begin
  return query
  select
    kc.id,
    kc.document_id,
    kc.content,
    kc.metadata,
    1 - (kc.embedding <=> query_embedding) as similarity
  from knowledge_chunks kc
  where kc.tenant_id = match_tenant_id
    and (match_kb_id is null or kc.kb_id = match_kb_id)
    and 1 - (kc.embedding <=> query_embedding) > match_threshold
  order by kc.embedding <=> query_embedding
  limit match_count;
end;
$$;
