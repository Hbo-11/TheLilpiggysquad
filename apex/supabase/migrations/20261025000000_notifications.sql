-- Apex AI notification system.
--
-- Security model
--   * Users read and edit only their own preferences, follows, saved events and
--     notifications (RLS on auth.uid()).
--   * Clients can never insert notifications or read push tokens. Push tokens are
--     only written through security-definer RPCs that bind them to auth.uid().
--   * Notifications, deliveries and jobs are created by trusted server code
--     (Edge Functions using the service role / database connection).
--
-- Values mirrored from packages/notifications-core (categories, session types,
-- reminder offsets, default preferences). A DB test checks they stay in sync.

-- ============================================================================
-- Helpers
-- ============================================================================

create or replace function public.is_valid_timezone(tz text) returns boolean
language sql stable as $$
  select tz is not null and length(tz) <= 64 and exists (select 1 from pg_timezone_names where name = tz)
$$;

-- Preferences categories: only known optional categories, and only JSON booleans.
-- Server queries rely on this (a bad value must never break delivery for others).
create or replace function public.valid_notification_categories(c jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(c) = 'object' and not exists (
    select 1 from jsonb_each(c) e
     where jsonb_typeof(e.value) <> 'boolean'
        or e.key not in ('race_reminders', 'schedule_changes', 'race_results', 'driver_updates', 'team_updates',
                         'news_major', 'news_breaking', 'ai_tasks', 'track_lab', 'sim_racing', 'weekly_summary',
                         'product_updates')
  )
$$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ============================================================================
-- Reference data
-- ============================================================================

create table public.notification_categories (
  id text primary key,
  label text not null,
  optional boolean not null,
  priority text not null check (priority in ('critical', 'time_sensitive', 'normal', 'low')),
  sort_order int not null
);

insert into public.notification_categories (id, label, optional, priority, sort_order) values
  ('race_reminders',   'Session reminders',  true,  'time_sensitive', 10),
  ('schedule_changes', 'Schedule changes',   true,  'time_sensitive', 20),
  ('race_results',     'Official results',   true,  'normal',         30),
  ('driver_updates',   'Followed drivers',   true,  'normal',         40),
  ('team_updates',     'Followed teams',     true,  'normal',         50),
  ('news_major',       'Major headlines',    true,  'low',            60),
  ('news_breaking',    'Breaking news',      true,  'normal',         70),
  ('ai_tasks',         'Apex AI tasks',      true,  'normal',         80),
  ('track_lab',        'Track Lab',          true,  'normal',         90),
  ('sim_racing',       'Sim racing',         true,  'low',           100),
  ('weekly_summary',   'Weekly summary',     true,  'low',           110),
  ('product_updates',  'Apex AI updates',    true,  'low',           120),
  ('account_security', 'Account security',   false, 'critical',      130),
  ('system',           'Apex AI',            false, 'normal',        140);

-- Trusted providers of motorsport data. Credentials for each source live in the
-- Edge Function environment (INGEST_SOURCE_SECRETS), never in this table.
create table public.data_sources (
  id text primary key check (id ~ '^[a-z0-9_-]{1,40}$'),
  name text not null,
  trust_level text not null check (trust_level in ('official', 'licensed_provider', 'trusted_media', 'unverified')),
  active boolean not null default true,
  licence_notes text,
  homepage_url text check (homepage_url ~ '^https://'),
  created_at timestamptz not null default now()
);

-- Championships Apex AI knows about. `supported` is switched on by an operator only
-- once a verified data source for it is connected; nothing is notified otherwise.
create table public.championships (
  id text primary key check (id ~ '^[a-z0-9_-]{1,40}$'),
  name text not null,
  discipline text not null check (discipline in ('single_seater', 'stock_car', 'endurance', 'sports_car', 'rally', 'motorcycle', 'karting', 'other')),
  supported boolean not null default false,
  sort_order int not null default 1000,
  created_at timestamptz not null default now()
);

insert into public.championships (id, name, discipline, sort_order) values
  ('f1',        'Formula 1',                         'single_seater', 10),
  ('f2',        'FIA Formula 2',                     'single_seater', 20),
  ('f3',        'FIA Formula 3',                     'single_seater', 30),
  ('formula-e', 'Formula E',                         'single_seater', 40),
  ('indycar',   'IndyCar Series',                    'single_seater', 50),
  ('nascar',    'NASCAR Cup Series',                 'stock_car',     60),
  ('wec',       'FIA World Endurance Championship',  'endurance',     70),
  ('imsa',      'IMSA WeatherTech SportsCar',        'sports_car',    80),
  ('wrc',       'FIA World Rally Championship',      'rally',         90),
  ('motogp',    'MotoGP',                            'motorcycle',   100),
  ('wsbk',      'WorldSBK',                          'motorcycle',   110),
  ('world-rx',  'FIA World Rallycross',              'rally',        120),
  ('karting',   'FIA Karting',                       'karting',      130);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public.data_sources (id),
  external_ref text not null,
  championship_id text references public.championships (id),
  name text not null,
  updated_at timestamptz not null default now(),
  unique (source_id, external_ref)
);

create table public.drivers (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public.data_sources (id),
  external_ref text not null,
  championship_id text references public.championships (id),
  team_id uuid references public.teams (id) on delete set null,
  name text not null,
  updated_at timestamptz not null default now(),
  unique (source_id, external_ref)
);

create table public.events (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public.data_sources (id),
  external_ref text not null,
  championship_id text not null references public.championships (id),
  name text not null,
  circuit_name text,
  country text,
  -- IANA timezone of the venue. Times are never stored as fixed offsets.
  timezone text not null check (public.is_valid_timezone(timezone)),
  status text not null default 'scheduled' check (status in ('scheduled', 'postponed', 'cancelled', 'completed')),
  -- The provider's own timestamp for this record; older updates are rejected as stale.
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_ref)
);
create index events_championship_idx on public.events (championship_id);

create table public.event_sessions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  source_id text not null references public.data_sources (id),
  external_ref text not null,
  session_type text not null check (session_type in ('practice', 'qualifying', 'sprint_qualifying', 'sprint', 'race', 'other')),
  name text not null,
  -- Absolute start instant. Null while the time is to be confirmed.
  starts_at timestamptz,
  -- The wall time and zone exactly as the source published them (audit/display).
  local_start text,
  timezone text check (timezone is null or public.is_valid_timezone(timezone)),
  time_status text not null check (time_status in ('confirmed', 'provisional', 'tbc')),
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'finished', 'cancelled', 'postponed')),
  -- Bumped whenever the start time or status changes, for schedule-change dedupe keys.
  schedule_version int not null default 1,
  results_published_at timestamptz,
  results_url text check (results_url ~ '^https://'),
  last_verified_at timestamptz not null default now(),
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_ref),
  check (time_status = 'tbc' or starts_at is not null)
);
create index event_sessions_event_idx on public.event_sessions (event_id);
create index event_sessions_upcoming_idx on public.event_sessions (starts_at)
  where status = 'scheduled' and time_status = 'confirmed';

create table public.event_entries (
  event_id uuid not null references public.events (id) on delete cascade,
  driver_id uuid not null references public.drivers (id) on delete cascade,
  team_id uuid references public.teams (id) on delete set null,
  primary key (event_id, driver_id)
);
create index event_entries_driver_idx on public.event_entries (driver_id);
create index event_entries_team_idx on public.event_entries (team_id);

create table public.articles (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public.data_sources (id),
  external_ref text not null,
  kind text not null check (kind in ('news', 'announcement')),
  announcement_type text check (announcement_type in ('signing', 'team_change', 'injury', 'absence', 'penalty', 'disqualification', 'technical', 'general')),
  importance text check (importance in ('breaking', 'major', 'minor')),
  verification text not null check (verification in ('confirmed', 'reported', 'rumour')),
  headline text not null check (char_length(headline) <= 140),
  summary text not null check (char_length(summary) <= 600),
  url text check (url ~ '^https://'),
  story_key text,
  championship_ids text[] not null default '{}',
  driver_ids uuid[] not null default '{}',
  team_ids uuid[] not null default '{}',
  published_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_ref)
);
create index articles_published_idx on public.articles (published_at desc);

-- Audit trail of everything a provider sent us, accepted or not.
create table public.ingest_log (
  id bigint generated always as identity primary key,
  source_id text,
  kind text,
  external_ref text,
  outcome text not null check (outcome in ('applied', 'unchanged', 'rejected')),
  detail jsonb not null default '{}',
  received_at timestamptz not null default now()
);
create index ingest_log_received_idx on public.ingest_log (received_at desc);

-- ============================================================================
-- Per-user data
-- ============================================================================

create table public.notification_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade default auth.uid(),
  categories jsonb not null default '{
    "race_reminders": true, "schedule_changes": true, "race_results": true,
    "driver_updates": true, "team_updates": true, "news_major": false,
    "news_breaking": false, "ai_tasks": true, "track_lab": true,
    "sim_racing": false, "weekly_summary": false, "product_updates": false
  }'::jsonb check (public.valid_notification_categories(categories)),
  push_enabled boolean not null default true,
  reminder_offsets int[] not null default '{30}'
    check (reminder_offsets <@ array[1440, 60, 30, 15, 0] and cardinality(reminder_offsets) <= 5),
  reminder_session_types text[] not null default '{qualifying,sprint,race}'
    check (reminder_session_types <@ array['practice', 'qualifying', 'sprint_qualifying', 'sprint', 'race', 'other']),
  timezone_mode text not null default 'device' check (timezone_mode in ('device', 'preferred')),
  preferred_timezone text check (preferred_timezone is null or public.is_valid_timezone(preferred_timezone)),
  -- Last timezone reported by the user's most recently active device.
  device_timezone text check (device_timezone is null or public.is_valid_timezone(device_timezone)),
  quiet_hours_enabled boolean not null default false,
  quiet_hours_start time not null default '23:00',
  quiet_hours_end time not null default '07:00',
  quiet_hours_reminder_policy text not null default 'defer'
    check (quiet_hours_reminder_policy in ('deliver', 'defer', 'in_app_only')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (timezone_mode = 'device' or preferred_timezone is not null),
  check (quiet_hours_start <> quiet_hours_end)
);
create trigger notification_preferences_touch before update on public.notification_preferences
  for each row execute function public.touch_updated_at();

create table public.user_follows (
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  entity_type text not null check (entity_type in ('championship', 'driver', 'team')),
  entity_id text not null check (entity_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  created_at timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id)
);
create index user_follows_entity_idx on public.user_follows (entity_type, entity_id);

-- Events a user explicitly asked to be reminded about.
create table public.saved_events (
  user_id uuid not null references auth.users (id) on delete cascade default auth.uid(),
  event_id uuid not null references public.events (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, event_id)
);
create index saved_events_event_idx on public.saved_events (event_id);

create table public.push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  expo_push_token text not null unique
    check (expo_push_token ~ '^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{8,200}\]$'),
  platform text not null check (platform in ('ios', 'android')),
  device_name text check (char_length(device_name) <= 100),
  app_version text check (char_length(app_version) <= 40),
  timezone text check (timezone is null or public.is_valid_timezone(timezone)),
  last_registered_at timestamptz not null default now(),
  invalidated_at timestamptz,
  invalid_reason text,
  created_at timestamptz not null default now()
);
create index push_devices_user_active_idx on public.push_devices (user_id) where invalidated_at is null;

-- ============================================================================
-- Notifications, deliveries and jobs
-- ============================================================================

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  category text not null references public.notification_categories (id),
  kind text not null check (kind ~ '^[a-z_]{1,40}$'),
  title text not null check (char_length(title) between 1 and 65),
  body text not null check (char_length(body) <= 178),
  -- Internal app path only (see core deepLinks.ts). Never an external URL.
  deep_link text check (deep_link ~ '^/[A-Za-z0-9/_-]{0,150}$' and deep_link !~ '//'),
  data jsonb not null default '{}' check (jsonb_typeof(data) = 'object'),
  source_id text references public.data_sources (id),
  source_url text check (source_url ~ '^https://'),
  dedupe_key text not null check (char_length(dedupe_key) <= 200),
  collapse_key text check (char_length(collapse_key) <= 200),
  group_count int not null default 1 check (group_count >= 1),
  is_demo boolean not null default false,
  related_session_id uuid references public.event_sessions (id) on delete set null,
  -- Why a push was or was not sent, so the app can explain (e.g. quiet hours).
  push_state text not null default 'none'
    check (push_state in ('none', 'scheduled', 'sent', 'suppressed', 'failed', 'cancelled')),
  push_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  read_at timestamptz,
  archived_at timestamptz,
  unique (user_id, dedupe_key)
);
create index notifications_user_feed_idx on public.notifications (user_id, created_at desc, id desc) where archived_at is null;
create index notifications_user_unread_idx on public.notifications (user_id) where read_at is null and archived_at is null;
create index notifications_collapse_idx on public.notifications (user_id, collapse_key, created_at desc) where collapse_key is not null;
create index notifications_session_idx on public.notifications (related_session_id) where related_session_id is not null;
create trigger notifications_touch before update on public.notifications
  for each row execute function public.touch_updated_at();

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null references public.push_devices (id) on delete cascade,
  category text not null references public.notification_categories (id),
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'delivered', 'failed', 'cancelled')),
  send_after timestamptz not null default now(),
  attempts int not null default 0,
  last_attempt_at timestamptz,
  ticket_id text,
  receipt_checked_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (notification_id, device_id)
);
create index notification_deliveries_due_idx on public.notification_deliveries (send_after) where status = 'pending';
create index notification_deliveries_receipts_idx on public.notification_deliveries (last_attempt_at)
  where status = 'sent' and receipt_checked_at is null;
create index notification_deliveries_rate_idx on public.notification_deliveries (user_id, created_at desc);
create trigger notification_deliveries_touch before update on public.notification_deliveries
  for each row execute function public.touch_updated_at();

create table public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null check (job_type in ('session_change', 'results_published', 'article', 'app_event', 'security_event')),
  payload jsonb not null,
  idempotency_key text not null unique,
  status text not null default 'queued' check (status in ('queued', 'processing', 'done', 'failed')),
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index notification_jobs_queue_idx on public.notification_jobs (run_after) where status = 'queued';

create table public.reminder_scan_state (
  id int primary key default 1 check (id = 1),
  scanned_until timestamptz not null
);

-- Heartbeats from the scheduled workers, used for monitoring and the app's status panel.
create table public.system_heartbeats (
  name text primary key,
  last_run_at timestamptz not null,
  detail jsonb not null default '{}'
);

-- ============================================================================
-- Triggers on auth.users
-- ============================================================================

create or replace function public.handle_new_user_notifications() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.notification_preferences (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created_notifications after insert on auth.users
  for each row execute function public.handle_new_user_notifications();

-- Users who signed up before this migration get the recommended defaults too.
insert into public.notification_preferences (user_id)
select id from auth.users
on conflict (user_id) do nothing;

-- Password and email changes queue an account-security notification.
create or replace function public.handle_auth_user_security_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  kinds text[] := '{}';
  k text;
begin
  if new.encrypted_password is distinct from old.encrypted_password and old.encrypted_password is not null then
    kinds := kinds || 'password_changed'::text;
  end if;
  if new.email is distinct from old.email and old.email is not null then
    kinds := kinds || 'email_changed'::text;
  end if;
  foreach k in array kinds loop
    insert into public.notification_jobs (job_type, payload, idempotency_key)
    values ('security_event',
            jsonb_build_object('userId', new.id, 'kind', k, 'occurredAt', now()),
            'security:' || k || ':' || new.id || ':' || gen_random_uuid());
  end loop;
  return new;
end $$;

create trigger on_auth_user_security_change after update on auth.users
  for each row execute function public.handle_auth_user_security_change();

-- ============================================================================
-- Client RPCs
-- ============================================================================

-- Bind an Expo push token to the signed-in user. If the token was registered to
-- another account on this device (sign-out without cleanup, account switch), it
-- moves to the caller so the previous account stops receiving pushes here.
create or replace function public.register_push_device(
  p_token text,
  p_platform text,
  p_device_name text default null,
  p_app_version text default null,
  p_timezone text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  v_device_id uuid;
  tz text := case when public.is_valid_timezone(p_timezone) then p_timezone end;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  insert into public.push_devices (user_id, expo_push_token, platform, device_name, app_version, timezone)
  values (uid, p_token, p_platform, left(p_device_name, 100), left(p_app_version, 40), tz)
  on conflict (expo_push_token) do update
    set user_id = excluded.user_id,
        platform = excluded.platform,
        device_name = excluded.device_name,
        app_version = excluded.app_version,
        timezone = excluded.timezone,
        last_registered_at = now(),
        invalidated_at = null,
        invalid_reason = null
  returning id into v_device_id;
  -- Deliveries still queued for the previous owner must not reach this device.
  update public.notification_deliveries
     set status = 'cancelled', error_code = 'DEVICE_REASSIGNED'
   where device_id = v_device_id and status in ('pending', 'sending') and user_id <> uid;
  if tz is not null then
    insert into public.notification_preferences (user_id, device_timezone) values (uid, tz)
    on conflict (user_id) do update set device_timezone = excluded.device_timezone;
  end if;
  return v_device_id;
end $$;

-- Called on sign-out (before the session is cleared) or when the user turns push off.
create or replace function public.unregister_push_device(p_token text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  removed int;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  delete from public.push_devices where expo_push_token = p_token and user_id = auth.uid();
  get diagnostics removed = row_count;
  return removed > 0;
end $$;

-- Release a token by possession. Used when sign-out happened offline and the app can
-- no longer authenticate as the previous user: only the device holding the token can
-- call this, and the worst a leaked token allows is stopping pushes to that device.
create or replace function public.release_push_token(p_token text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  removed int;
begin
  delete from public.push_devices where expo_push_token = p_token;
  get diagnostics removed = row_count;
  return removed > 0;
end $$;

-- Remove one of the caller's devices by id (e.g. a lost phone, from Account security).
create or replace function public.remove_push_device(p_device_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  removed int;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  delete from public.push_devices where id = p_device_id and user_id = auth.uid();
  get diagnostics removed = row_count;
  return removed > 0;
end $$;

-- The caller's devices without exposing full tokens.
create or replace function public.my_push_devices()
returns table (id uuid, platform text, device_name text, app_version text, last_registered_at timestamptz,
               invalidated_at timestamptz, invalid_reason text, token_hint text)
language sql stable security definer set search_path = public as $$
  select d.id, d.platform, d.device_name, d.app_version, d.last_registered_at, d.invalidated_at, d.invalid_reason,
         '…' || right(rtrim(d.expo_push_token, ']'), 4)
    from public.push_devices d
   where d.user_id = auth.uid()
   order by d.last_registered_at desc
$$;

-- Report the device timezone (keeps server-side quiet hours and reminder text correct).
create or replace function public.report_device_timezone(p_timezone text) returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_valid_timezone(p_timezone) then raise exception 'invalid timezone' using errcode = '22023'; end if;
  insert into public.notification_preferences (user_id, device_timezone) values (auth.uid(), p_timezone)
  on conflict (user_id) do update set device_timezone = excluded.device_timezone;
end $$;

create or replace function public.mark_all_notifications_read() returns int
language plpgsql security invoker set search_path = public as $$
declare
  n int;
begin
  update public.notifications set read_at = now()
   where user_id = auth.uid() and read_at is null and archived_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

-- Stage 1 demonstration data. Clearly labelled, never pushed, and removable.
create or replace function public.seed_demo_notifications() returns int
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  n int;
begin
  if uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  insert into public.notifications (user_id, category, kind, title, body, deep_link, dedupe_key, is_demo, created_at, read_at)
  values
    (uid, 'race_reminders', 'demo', 'Sample: Qualifying starts in 30 minutes', 'Demonstration only, not a real session. Real reminders use verified event times.', '/notifications', 'demo:1', true, now() - interval '5 minutes', null),
    (uid, 'race_results', 'demo', 'Sample: Official race results are available', 'Demonstration only. Real result alerts are sent when official classifications are published.', '/notifications', 'demo:2', true, now() - interval '2 hours', null),
    (uid, 'track_lab', 'demo', 'Sample: Your circuit design is ready', 'Demonstration only. Track Lab sends this when a generation task you started finishes.', '/notifications', 'demo:3', true, now() - interval '1 day', now() - interval '20 hours'),
    (uid, 'schedule_changes', 'demo', 'Sample: Race session rescheduled', 'Demonstration only. Schedule alerts are sent only for confirmed changes from trusted sources.', '/notifications', 'demo:4', true, now() - interval '3 days', null),
    (uid, 'system', 'demo', 'Sample: Notification settings', 'Demonstration only. Open settings to choose what you are notified about.', '/settings/notifications', 'demo:5', true, now() - interval '4 days', now() - interval '4 days')
  on conflict (user_id, dedupe_key) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.clear_demo_notifications() returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  delete from public.notifications where user_id = auth.uid() and is_demo;
  get diagnostics n = row_count;
  return n;
end $$;

-- What the app's status panel shows. Contains no per-user or secret data.
create or replace function public.get_notification_system_status() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'dispatcher_last_run_at', (select last_run_at from public.system_heartbeats where name = 'dispatch'),
    'reminder_scan_last_run_at', (select last_run_at from public.system_heartbeats where name = 'reminders'),
    'push_provider_configured', coalesce((select (detail ->> 'pushConfigured')::boolean from public.system_heartbeats where name = 'dispatch'), false),
    'live_sources', (select count(*) from public.data_sources where active and trust_level in ('official', 'licensed_provider')),
    'supported_championships', (select coalesce(jsonb_agg(id order by sort_order), '[]'::jsonb) from public.championships where supported),
    'last_ingest_at', (select max(received_at) from public.ingest_log where outcome = 'applied')
  )
$$;

-- ============================================================================
-- Server-only functions
-- ============================================================================

-- Users who should get a session reminder whose fire time falls in (p_from, p_to].
-- Combines championship/driver/team follows and saved events, then applies the
-- user's reminder settings. Quiet hours, rate limits and dedupe are applied by the
-- server pipeline afterwards.
create or replace function public.reminder_candidates(p_from timestamptz, p_to timestamptz)
returns table (user_id uuid, session_id uuid, offset_minutes int, fire_at timestamptz)
language sql stable security definer set search_path = public as $$
  with offsets(o) as (values (1440), (60), (30), (15), (0)),
  due as (
    select s.id as session_id, s.event_id, e.championship_id, s.session_type, o.o as offset_minutes,
           s.starts_at - make_interval(mins => o.o) as fire_at
      from offsets o
      join public.event_sessions s
        on s.starts_at > p_from + make_interval(mins => o.o)
       and s.starts_at <= p_to + make_interval(mins => o.o)
      join public.events e on e.id = s.event_id
      join public.championships c on c.id = e.championship_id
     where s.status = 'scheduled' and s.time_status = 'confirmed' and e.status = 'scheduled' and c.supported
  ),
  interested as (
    select d.*, f.user_id from due d
      join public.user_follows f on f.entity_type = 'championship' and f.entity_id = d.championship_id
    union
    select d.*, f.user_id from due d
      join public.event_entries ee on ee.event_id = d.event_id
      join public.user_follows f on f.entity_type = 'driver' and f.entity_id = ee.driver_id::text
    union
    select d.*, f.user_id from due d
      join public.event_entries ee on ee.event_id = d.event_id
      join public.user_follows f on f.entity_type = 'team' and f.entity_id = ee.team_id::text
    union
    select d.*, se.user_id from due d
      join public.saved_events se on se.event_id = d.event_id
  )
  select distinct i.user_id, i.session_id, i.offset_minutes, i.fire_at
    from interested i
    join public.notification_preferences p on p.user_id = i.user_id
   where p.categories -> 'race_reminders' = 'true'::jsonb
     and i.offset_minutes = any (p.reminder_offsets)
     and i.session_type = any (p.reminder_session_types)
$$;

-- Users following anything connected to a session (for schedule changes and results).
create or replace function public.session_audience(p_session_id uuid)
returns table (user_id uuid)
language sql stable security definer set search_path = public as $$
  with s as (
    select s.id, s.event_id, e.championship_id from public.event_sessions s
      join public.events e on e.id = s.event_id where s.id = p_session_id
  )
  select f.user_id from s join public.user_follows f on f.entity_type = 'championship' and f.entity_id = s.championship_id
  union
  select f.user_id from s join public.event_entries ee on ee.event_id = s.event_id
    join public.user_follows f on f.entity_type = 'driver' and f.entity_id = ee.driver_id::text
  union
  select f.user_id from s join public.event_entries ee on ee.event_id = s.event_id
    join public.user_follows f on f.entity_type = 'team' and f.entity_id = ee.team_id::text
  union
  select se.user_id from s join public.saved_events se on se.event_id = s.event_id
$$;

-- ============================================================================
-- Row-level security and grants
-- ============================================================================

alter table public.notification_categories enable row level security;
alter table public.data_sources enable row level security;
alter table public.championships enable row level security;
alter table public.teams enable row level security;
alter table public.drivers enable row level security;
alter table public.events enable row level security;
alter table public.event_sessions enable row level security;
alter table public.event_entries enable row level security;
alter table public.articles enable row level security;
alter table public.ingest_log enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.user_follows enable row level security;
alter table public.saved_events enable row level security;
alter table public.push_devices enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.notification_jobs enable row level security;
alter table public.reminder_scan_state enable row level security;
alter table public.system_heartbeats enable row level security;

-- Public reference data: read-only for everyone.
do $$
declare t text;
begin
  foreach t in array array['notification_categories', 'data_sources', 'championships', 'teams', 'drivers',
                           'events', 'event_sessions', 'event_entries', 'articles'] loop
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to anon, authenticated', t);
    execute format('create policy %I on public.%I for select to anon, authenticated using (true)', t || '_read', t);
  end loop;
end $$;

-- Server-only tables: no client access at all.
revoke all on public.ingest_log, public.push_devices, public.notification_deliveries,
              public.notification_jobs, public.reminder_scan_state, public.system_heartbeats
  from anon, authenticated;

-- Preferences: own row only.
revoke all on public.notification_preferences from anon, authenticated;
grant select, insert, update on public.notification_preferences to authenticated;
create policy notification_preferences_own on public.notification_preferences
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Follows and saved events: own rows only.
revoke all on public.user_follows, public.saved_events from anon, authenticated;
grant select, insert, delete on public.user_follows, public.saved_events to authenticated;
create policy user_follows_own on public.user_follows
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy saved_events_own on public.saved_events
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Notifications: read own; only read/archived state can be changed; no inserts or deletes.
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
grant update (read_at, archived_at) on public.notifications to authenticated;
create policy notifications_select_own on public.notifications
  for select to authenticated using (user_id = auth.uid());
create policy notifications_update_own on public.notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Functions: clients may call only the RPCs meant for them.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.is_valid_timezone(text) to anon, authenticated;
grant execute on function public.valid_notification_categories(jsonb) to authenticated;
grant execute on function public.register_push_device(text, text, text, text, text) to authenticated;
grant execute on function public.unregister_push_device(text) to authenticated;
grant execute on function public.remove_push_device(uuid) to authenticated;
grant execute on function public.release_push_token(text) to anon, authenticated;
grant execute on function public.my_push_devices() to authenticated;
grant execute on function public.report_device_timezone(text) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;
grant execute on function public.seed_demo_notifications() to authenticated;
grant execute on function public.clear_demo_notifications() to authenticated;
grant execute on function public.get_notification_system_status() to anon, authenticated;

-- Realtime updates for the notification centre (Supabase only).
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;
