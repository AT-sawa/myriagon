-- 005_credentials.sql
-- Service credentials per tenant

create type credential_status as enum ('connected', 'disconnected');

create table credentials (
  id                uuid primary key default uuid_generate_v4(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  service_name      text not null,
  n8n_credential_id text,
  status            credential_status not null default 'disconnected',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index idx_credentials_tenant_service on credentials(tenant_id, service_name);
create index idx_credentials_tenant on credentials(tenant_id);

create trigger trg_credentials_updated_at
  before update on credentials
  for each row execute function update_updated_at();
