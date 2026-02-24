-- 009_cron_health_monitor.sql
-- Schedule health-monitor Edge Function to run every hour via pg_cron

create extension if not exists pg_cron;

-- Invoke the health-monitor Edge Function every hour
select cron.schedule(
  'health-monitor-hourly',
  '0 * * * *',
  $$
  select net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/health-monitor',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
