-- flow_requests: ユーザーの自然言語フローリクエストを保存
create table flow_requests (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  auth_uid    uuid not null,
  description text not null,
  status      text not null default 'pending',
  created_at  timestamptz not null default now()
);

create index idx_flow_requests_tenant on flow_requests(tenant_id);

alter table flow_requests enable row level security;

create policy "tenant isolation"
  on flow_requests for all
  using (tenant_id = public.get_tenant_id());
