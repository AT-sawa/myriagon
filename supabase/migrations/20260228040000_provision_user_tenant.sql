-- Auto-provision tenant + user record for auth users who don't have one yet.
-- This handles users who signed up before the on_auth_user_created trigger was deployed.
-- Returns the new tenant_id.

create or replace function public.provision_user_tenant()
returns uuid as $$
declare
  v_auth_uid uuid;
  v_email text;
  v_name text;
  v_tenant_id uuid;
  v_existing_tenant_id uuid;
begin
  -- Get current auth user info
  v_auth_uid := auth.uid();
  if v_auth_uid is null then
    raise exception 'Not authenticated';
  end if;

  -- Check if user record already exists
  select tenant_id into v_existing_tenant_id
    from public.users
    where auth_uid = v_auth_uid;

  if v_existing_tenant_id is not null then
    return v_existing_tenant_id;
  end if;

  -- Get email from auth.users
  select email into v_email
    from auth.users
    where id = v_auth_uid;

  v_name := split_part(v_email, '@', 1);

  -- Create tenant
  insert into public.tenants (name, plan)
  values (v_name || '''s Workspace', 'starter')
  returning id into v_tenant_id;

  -- Create user record
  insert into public.users (tenant_id, email, role, auth_uid)
  values (v_tenant_id, v_email, 'owner', v_auth_uid);

  return v_tenant_id;
end;
$$ language plpgsql security definer;
