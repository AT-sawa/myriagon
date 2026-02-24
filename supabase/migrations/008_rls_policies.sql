-- 008_rls_policies.sql
-- Row Level Security: complete tenant isolation

-- Helper: get current user's tenant_id from JWT
create or replace function auth.tenant_id()
returns uuid as $$
  select tenant_id from public.users where auth_uid = auth.uid() limit 1;
$$ language sql security definer stable;

-- ═══════════════════════════════════════════
-- TENANTS
-- ═══════════════════════════════════════════
alter table tenants enable row level security;

create policy "Users can view own tenant"
  on tenants for select
  using (id = auth.tenant_id());

create policy "Owners can update own tenant"
  on tenants for update
  using (id = auth.tenant_id())
  with check (id = auth.tenant_id());

-- ═══════════════════════════════════════════
-- USERS
-- ═══════════════════════════════════════════
alter table users enable row level security;

create policy "Users can view own tenant members"
  on users for select
  using (tenant_id = auth.tenant_id());

create policy "Admins can insert tenant members"
  on users for insert
  with check (
    tenant_id = auth.tenant_id()
    and exists (
      select 1 from users
      where auth_uid = auth.uid()
        and role in ('owner', 'admin')
    )
  );

create policy "Admins can update tenant members"
  on users for update
  using (tenant_id = auth.tenant_id())
  with check (
    tenant_id = auth.tenant_id()
    and exists (
      select 1 from users
      where auth_uid = auth.uid()
        and role in ('owner', 'admin')
    )
  );

-- ═══════════════════════════════════════════
-- TEMPLATES (public read for active templates)
-- ═══════════════════════════════════════════
alter table templates enable row level security;

create policy "Anyone can view active templates"
  on templates for select
  using (status = 'active');

-- ═══════════════════════════════════════════
-- WORKFLOWS
-- ═══════════════════════════════════════════
alter table workflows enable row level security;

create policy "Users can view own tenant workflows"
  on workflows for select
  using (tenant_id = auth.tenant_id());

create policy "Users can insert own tenant workflows"
  on workflows for insert
  with check (tenant_id = auth.tenant_id());

create policy "Users can update own tenant workflows"
  on workflows for update
  using (tenant_id = auth.tenant_id())
  with check (tenant_id = auth.tenant_id());

create policy "Users can delete own tenant workflows"
  on workflows for delete
  using (tenant_id = auth.tenant_id());

-- ═══════════════════════════════════════════
-- CREDENTIALS
-- ═══════════════════════════════════════════
alter table credentials enable row level security;

create policy "Users can view own tenant credentials"
  on credentials for select
  using (tenant_id = auth.tenant_id());

create policy "Users can insert own tenant credentials"
  on credentials for insert
  with check (tenant_id = auth.tenant_id());

create policy "Users can update own tenant credentials"
  on credentials for update
  using (tenant_id = auth.tenant_id())
  with check (tenant_id = auth.tenant_id());

-- ═══════════════════════════════════════════
-- EXECUTIONS
-- ═══════════════════════════════════════════
alter table executions enable row level security;

create policy "Users can view own tenant executions"
  on executions for select
  using (tenant_id = auth.tenant_id());

create policy "Users can insert own tenant executions"
  on executions for insert
  with check (tenant_id = auth.tenant_id());

create policy "Users can update own tenant executions"
  on executions for update
  using (tenant_id = auth.tenant_id())
  with check (tenant_id = auth.tenant_id());

-- ═══════════════════════════════════════════
-- KNOWLEDGE DOCUMENTS
-- ═══════════════════════════════════════════
alter table knowledge_documents enable row level security;

create policy "Users can view own tenant documents"
  on knowledge_documents for select
  using (tenant_id = auth.tenant_id());

create policy "Users can insert own tenant documents"
  on knowledge_documents for insert
  with check (tenant_id = auth.tenant_id());

create policy "Users can update own tenant documents"
  on knowledge_documents for update
  using (tenant_id = auth.tenant_id())
  with check (tenant_id = auth.tenant_id());

create policy "Users can delete own tenant documents"
  on knowledge_documents for delete
  using (tenant_id = auth.tenant_id());

-- ═══════════════════════════════════════════
-- KNOWLEDGE BASES
-- ═══════════════════════════════════════════
alter table knowledge_bases enable row level security;

create policy "Users can view own tenant KBs"
  on knowledge_bases for select
  using (tenant_id = auth.tenant_id());

create policy "Users can insert own tenant KBs"
  on knowledge_bases for insert
  with check (tenant_id = auth.tenant_id());

create policy "Users can update own tenant KBs"
  on knowledge_bases for update
  using (tenant_id = auth.tenant_id())
  with check (tenant_id = auth.tenant_id());

create policy "Users can delete own tenant KBs"
  on knowledge_bases for delete
  using (tenant_id = auth.tenant_id());

-- ═══════════════════════════════════════════
-- Enable Realtime for executions
-- ═══════════════════════════════════════════
alter publication supabase_realtime add table executions;
