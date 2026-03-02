-- Add 'free' plan as default for new signups

-- Update handle_new_user trigger to use 'free' as default plan
create or replace function public.handle_new_user()
returns trigger as $$
declare
  new_tenant_id uuid;
  user_name text;
begin
  user_name := coalesce(
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'name',
    split_part(new.email, '@', 1)
  );

  insert into public.tenants (name, plan)
  values (user_name || '''s Workspace', 'free')
  returning id into new_tenant_id;

  insert into public.users (tenant_id, email, role, auth_uid)
  values (new_tenant_id, new.email, 'owner', new.id);

  return new;
end;
$$ language plpgsql security definer;

-- Update provision_user_tenant fallback to use 'free' as default plan
create or replace function public.provision_user_tenant()
returns uuid as $$
declare
  v_auth_uid uuid;
  v_email text;
  v_name text;
  v_tenant_id uuid;
  v_existing_tenant_id uuid;
begin
  v_auth_uid := auth.uid();
  if v_auth_uid is null then
    raise exception 'Not authenticated';
  end if;

  select tenant_id into v_existing_tenant_id
    from public.users
    where auth_uid = v_auth_uid;

  if v_existing_tenant_id is not null then
    return v_existing_tenant_id;
  end if;

  select email into v_email
    from auth.users
    where id = v_auth_uid;

  v_name := split_part(v_email, '@', 1);

  insert into public.tenants (name, plan)
  values (v_name || '''s Workspace', 'free')
  returning id into v_tenant_id;

  insert into public.users (tenant_id, email, role, auth_uid)
  values (v_tenant_id, v_email, 'owner', v_auth_uid);

  return v_tenant_id;
end;
$$ language plpgsql security definer;
