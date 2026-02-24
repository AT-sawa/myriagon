-- 001_tenants.sql
-- Tenant table for multi-tenant isolation

create type plan_type as enum ('starter', 'growth', 'enterprise');

create table tenants (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  plan          plan_type not null default 'starter',
  stripe_customer_id     text,
  stripe_subscription_id text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_tenants_updated_at
  before update on tenants
  for each row execute function update_updated_at();
