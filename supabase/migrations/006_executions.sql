-- 006_executions.sql
-- Workflow execution history

create type execution_status as enum ('running', 'success', 'error');

create table executions (
  id          uuid primary key default uuid_generate_v4(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  workflow_id uuid not null references workflows(id) on delete cascade,
  status      execution_status not null default 'running',
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  error_log   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_executions_tenant on executions(tenant_id);
create index idx_executions_workflow on executions(workflow_id);
create index idx_executions_status on executions(status);
create index idx_executions_started_at on executions(started_at desc);

create trigger trg_executions_updated_at
  before update on executions
  for each row execute function update_updated_at();
