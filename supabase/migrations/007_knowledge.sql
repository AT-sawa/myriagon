-- 007_knowledge.sql
-- Knowledge documents and vector knowledge bases

create type doc_status as enum ('uploading', 'processing', 'ready', 'error');
create type kb_status  as enum ('building', 'ready', 'error');

create table knowledge_documents (
  id          uuid primary key default uuid_generate_v4(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  filename    text not null,
  file_type   text not null,
  chunk_count integer default 0,
  file_size   bigint default 0,
  status      doc_status not null default 'uploading',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_knowledge_docs_tenant on knowledge_documents(tenant_id);

create table knowledge_bases (
  id          uuid primary key default uuid_generate_v4(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  engine      text not null default 'supabase_pgvector',
  vector_count integer default 0,
  dimensions   integer default 1536,
  doc_count    integer default 0,
  status       kb_status not null default 'building',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index idx_knowledge_bases_tenant on knowledge_bases(tenant_id);

create trigger trg_knowledge_docs_updated_at
  before update on knowledge_documents
  for each row execute function update_updated_at();

create trigger trg_knowledge_bases_updated_at
  before update on knowledge_bases
  for each row execute function update_updated_at();
