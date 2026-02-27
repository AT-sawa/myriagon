-- ====================================
-- OAuth トークン暗号化保存 + CSRF State管理
-- ====================================

-- credentials テーブルにトークン保存カラム追加
alter table credentials
  add column if not exists encrypted_tokens bytea,
  add column if not exists token_iv bytea,
  add column if not exists scopes text[],
  add column if not exists token_expires_at timestamptz,
  add column if not exists credential_type text not null default 'oauth2'
    check (credential_type in ('oauth2', 'api_key'));

-- OAuth State管理テーブル（CSRF防止用、一時的）
create table if not exists oauth_states (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null,
  service_name text not null,
  state_token text unique not null,
  redirect_uri text not null,
  scopes text[],
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '10 minutes')
);

create index if not exists idx_oauth_states_token on oauth_states(state_token);
create index if not exists idx_oauth_states_expires on oauth_states(expires_at);

-- oauth_statesはEdge Function（service_role_key）からのみアクセス
alter table oauth_states enable row level security;
-- RLSポリシーなし = anon keyではアクセス不可、service_role_keyのみバイパス
