-- 004_workflows.sql
-- User-created workflows from templates

create type workflow_status as enum ('active', 'inactive', 'error');

create table workflows (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  template_id     uuid references templates(id) on delete set null,
  n8n_workflow_id text,
  parameters      jsonb not null default '{}',
  status          workflow_status not null default 'inactive',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_workflows_tenant on workflows(tenant_id);
create index idx_workflows_template on workflows(template_id);
create index idx_workflows_status on workflows(status);

create trigger trg_workflows_updated_at
  before update on workflows
  for each row execute function update_updated_at();
