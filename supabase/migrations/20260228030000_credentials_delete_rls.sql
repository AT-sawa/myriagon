-- Add DELETE policy for credentials table (was missing)
create policy "Users can delete own tenant credentials"
  on credentials for delete
  using (tenant_id = public.get_tenant_id());
