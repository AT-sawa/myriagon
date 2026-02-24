-- 003_templates.sql
-- Workflow templates (global, not tenant-specific but tenant_id kept for custom templates)

create type template_status as enum ('active', 'maintenance', 'deprecated');

create table templates (
  id                uuid primary key default gen_random_uuid(),
  title             text not null,
  description       text,
  category          text,
  services          text[] not null default '{}',
  parameters_schema jsonb not null default '{}',
  workflow_json     jsonb not null default '{}',
  status            template_status not null default 'active',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index idx_templates_status on templates(status);
create index idx_templates_category on templates(category);

create trigger trg_templates_updated_at
  before update on templates
  for each row execute function update_updated_at();
