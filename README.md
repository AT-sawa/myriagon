# MYRIAGON

AI workflow automation platform powered by Supabase, n8n, and Stripe.

## Tech Stack

- **Frontend**: HTML / CSS / Vanilla JS (single-page)
- **Backend**: Supabase (DB, Auth, Edge Functions, Vault, Cron)
- **Workflow Engine**: n8n Cloud
- **Payments**: Stripe
- **Auth**: Google OAuth via Supabase Auth
- **Deploy**: Vercel

## Setup

1. Copy `.env.example` to `.env` and fill in your keys
2. Run Supabase migrations in order (`supabase/migrations/001_tenants.sql` ... `008_rls_policies.sql`)
3. Deploy Edge Functions to Supabase
4. Deploy frontend to Vercel

## Project Structure

```
myriagon/
├── index.html                  # Full SPA frontend
├── .env.example
├── vercel.json
├── README.md
└── supabase/
    ├── migrations/             # SQL schema (run in order)
    └── functions/              # Supabase Edge Functions
        ├── workflows-create/
        ├── workflows-list/
        ├── credentials-create/
        ├── executions-list/
        ├── health-monitor/
        └── mcp/                # MCP tool integrations
            ├── _shared/
            ├── google-sheets/
            ├── gmail/
            └── slack/
```

## Multi-Tenant Architecture

All tables enforce tenant isolation via Row Level Security (RLS). Every query automatically filters by `tenant_id` derived from the authenticated user's JWT.
