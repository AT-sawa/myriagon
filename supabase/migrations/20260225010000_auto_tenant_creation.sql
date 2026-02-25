-- 010_auto_tenant_creation.sql
-- Automatically create tenant + user when a new auth user signs up
-- Uses SECURITY DEFINER to bypass RLS during signup

create or replace function public.handle_new_user()
returns trigger as $$
declare
  new_tenant_id uuid;
  user_name text;
begin
  -- Extract display name from metadata or email
  user_name := coalesce(
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    split_part(new.email, '@', 1)
  );

  -- Create a new tenant for the user
  insert into public.tenants (name, plan)
  values (user_name || '''s Workspace', 'starter')
  returning id into new_tenant_id;

  -- Create the user record linked to the tenant
  insert into public.users (tenant_id, email, role, auth_uid)
  values (new_tenant_id, new.email, 'owner', new.id);

  return new;
end;
$$ language plpgsql security definer;

-- Trigger on auth.users insert (drop first to avoid conflict)
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
