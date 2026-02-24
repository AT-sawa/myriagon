-- 002_users.sql
-- Users linked to tenants with role-based access

create type user_role as enum ('owner', 'admin', 'member');

create table users (
  id          uuid primary key default uuid_generate_v4(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  email       text not null,
  role        user_role not null default 'member',
  auth_uid    uuid unique,  -- links to auth.users.id
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index idx_users_email_tenant on users(email, tenant_id);
create index idx_users_tenant on users(tenant_id);
create index idx_users_auth_uid on users(auth_uid);

create trigger trg_users_updated_at
  before update on users
  for each row execute function update_updated_at();
