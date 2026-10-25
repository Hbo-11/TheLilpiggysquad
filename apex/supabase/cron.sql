-- Schedules for the notification workers. Run once per project (SQL editor) after
-- deploying the Edge Functions. Not a migration: it needs project-specific values
-- and the pg_cron + pg_net extensions (Database > Extensions in the dashboard).
--
-- 1. Store the function base URL and internal secret in Vault:
--      select vault.create_secret('https://<project-ref>.supabase.co/functions/v1', 'apex_functions_url');
--      select vault.create_secret('<same value as APEX_INTERNAL_SECRET>', 'apex_internal_secret');
-- 2. Run this file.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.call_notification_worker(fn text) returns bigint
language sql security definer set search_path = public as $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'apex_functions_url') || '/' || fn,
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'apex_internal_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  )
$$;
revoke execute on function public.call_notification_worker(text) from public, anon, authenticated;

select cron.schedule('apex-process-notifications', '* * * * *', $$select public.call_notification_worker('process-notifications')$$);
select cron.schedule('apex-check-push-receipts', '*/15 * * * *', $$select public.call_notification_worker('check-push-receipts')$$);
-- Housekeeping: keep 90 days of delivery attempts and ingest logs.
select cron.schedule('apex-notification-cleanup', '17 3 * * *', $$
  delete from public.notification_deliveries where created_at < now() - interval '90 days';
  delete from public.ingest_log where received_at < now() - interval '90 days';
  delete from public.notification_jobs where status = 'done' and completed_at < now() - interval '30 days';
$$);
