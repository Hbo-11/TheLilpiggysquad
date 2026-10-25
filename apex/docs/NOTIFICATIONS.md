# Apex AI notification system

This guide covers how the system works, how to configure and deploy it, how to test it on devices, and what has and hasn't been verified.

- [Architecture](#architecture)
- [Data model and security](#data-model-and-security)
- [Processing pipeline](#processing-pipeline)
- [Delivery rules](#delivery-rules): preferences, reminders, timezones, quiet hours, rate limits, dedupe
- [Mobile app](#mobile-app)
- [Setup and deployment](#setup-and-deployment)
- [Connecting a motorsport data provider](#connecting-a-motorsport-data-provider)
- [Sending Apex AI and Track Lab notifications](#sending-apex-ai-and-track-lab-notifications)
- [Testing](#testing)
- [Operations and monitoring](#operations-and-monitoring)
- [Status: what works today](#status-what-works-today)

---

## Architecture

```
 Trusted data provider ──HMAC──▶ ingest-motorsport-update ─┐
 Other Apex AI services ─secret─▶ notify-app-event ────────┤   notification_jobs (queue)
 auth.users trigger (password/email change) ───────────────┘            │
                                                                        ▼
 pg_cron (every minute) ──▶ process-notifications: 1. process jobs  2. scan due reminders
                                                   3. fan-out per user (preferences, quiet hours,
                                                      rate limits, collapse, dedupe)
                                                   4. send due deliveries ──▶ Expo Push ──▶ APNs / FCM
 pg_cron (every 15 min) ──▶ check-push-receipts: delivered / failed / invalid tokens
                                                                        │
 Mobile app ◀── RLS-protected reads (notifications, preferences, events) ┘
            ──▶ RPCs: register/unregister device, mark all read, report timezone
```

| Part | Location | Runs on |
|---|---|---|
| Shared logic (categories, preferences, timezone/DST maths, reminder planning, quiet hours, rate limits, dedupe keys, deep-link allow-list, source trust, ingest validation, notification text, Expo client) | `packages/notifications-core` | App (Hermes), Edge Functions (Deno), tests (Node) |
| Pipeline (ingest, jobs, reminder scan, fan-out, dispatch, receipts, HTTP handlers) | `packages/notifications-server` | Supabase Edge Functions (Deno); tests (Node) |
| Schema, RLS, RPCs, triggers | `supabase/migrations/` | Supabase Postgres |
| Edge Function entry points and cron schedule | `supabase/functions/`, `supabase/cron.sql` | Supabase |
| App: notification centre, settings, push registration, local reminders, deep links | `mobile/` | iOS / Android (Expo), web preview |

The core package contains no platform code. The same rules (for example "is this category enabled?", or "when do quiet hours end on a DST night?") run identically on the server, which enforces them, and in the app, which displays them.

## Data model and security

Main tables (see the migration for every column and constraint):

| Table | Purpose | Client access |
|---|---|---|
| `notification_preferences` | One row per user: categories, push switch, reminder timings and session types, timezone mode, quiet hours. Created on sign-up with recommended defaults. | Own row: read/insert/update |
| `user_follows`, `saved_events` | Followed championships, drivers and teams; events the user asked to be reminded about | Own rows |
| `push_devices` | Expo push tokens bound to users | None. Only via RPCs; tokens are never readable |
| `notifications` | The in-app record. `UNIQUE (user_id, dedupe_key)` makes creation idempotent | Read own; update only `read_at` and `archived_at` |
| `notification_deliveries` | One row per notification per device: status, attempts, Expo ticket, receipt, error | None |
| `notification_jobs` | Background queue with unique idempotency keys | None |
| `events`, `event_sessions`, `event_entries`, `drivers`, `teams`, `articles`, `championships`, `data_sources` | Verified motorsport data | Read-only |
| `ingest_log`, `system_heartbeats`, `reminder_scan_state` | Audit and monitoring | None |

Security properties (each covered by `packages/notifications-server/test/database-security.test.ts`):

- RLS is enabled on every table. Server-only tables have all privileges revoked from `anon` and `authenticated`, on top of Supabase's broad defaults.
- Clients cannot insert, rewrite or delete notifications. They can only mark their own as read or archived.
- Push tokens are written only by `register_push_device`, which binds the token to `auth.uid()`. If the token was registered to another account, it moves and that account's queued pushes are cancelled. `my_push_devices` shows only the last 4 characters of each token.
- Sending is server-only. Edge Functions authenticate with `APEX_INTERNAL_SECRET` (workers and services) or a per-provider HMAC signature (ingest). The test-notification function sends only to the caller's own devices and is rate limited.
- No secrets ship in the app: only the Supabase URL and anon key, which RLS protects.
- Deep links are checked against an allow-list in the database (`CHECK` constraint), in the server (`fanOut` refuses invalid links) and in the app (`resolveNotificationPath`).
- Deleting an account cascades to all of its notification data.

## Processing pipeline

`process-notifications` runs every minute:

1. **Jobs.** Claims queued jobs with `FOR UPDATE SKIP LOCKED`, so several workers are safe. Failures retry with exponential backoff up to 5 attempts, then the job is marked `failed` with its error. A crashed worker's jobs are re-queued after 10 minutes.
   - `session_change`: rescheduled, time confirmed, postponed, cancelled or live. It cancels obsolete reminders, then notifies the session's audience.
   - `results_published`: notifies the audience once (practice sessions are skipped).
   - `article`: confirmed announcements go to driver and team followers. Breaking and major news go to opted-in users. Minor news is never notified.
   - `app_event`: AI and Track Lab job finished or failed.
   - `security_event`: password or email changed.
2. **Reminder scan.** `reminder_candidates(from, to)` finds every (user, session, offset) whose fire time falls in the window since the last scan. It always uses the session's current start time, so a rescheduled session needs no per-user schedule maintenance. Reminders more than 10 minutes late (for example after an outage) are skipped and recorded in the heartbeat rather than sent stale.
3. **Fan-out** (`fanOut`, used by every path), for each recipient:
   preferences → timezone → quiet hours → rate limit → collapse → insert the notification (`ON CONFLICT DO NOTHING`) → create a delivery per active device.
4. **Dispatch.** Sends due deliveries in batches of 100. At send time it re-checks preferences, the push switch, whether the user already read or dismissed the notification in the app, and whether the device is still valid.
   - Transient errors (network, 429, 5xx) retry with backoff.
   - `DeviceNotRegistered` invalidates the device.
   - A send whose result was never recorded is marked `UNKNOWN_OUTCOME` rather than resent, to avoid duplicates.

`check-push-receipts` reads Expo receipts 15 minutes after sending. It records `delivered` or the error code (for example `InvalidCredentials`, which means APNs/FCM is misconfigured) and invalidates devices that report `DeviceNotRegistered`.

## Delivery rules

**Categories**: session reminders, schedule changes, official results, followed drivers, followed teams, major headlines, breaking news, Apex AI tasks, Track Lab, sim racing, weekly summary and Apex AI updates are optional. Account security is always on and is never delayed, rate limited or silenced by the push switch. Ordinary chat replies are not a notification type: `notify-app-event` rejects them.

**Recommended defaults**: reminders, schedule changes, results, drivers, teams, AI tasks and Track Lab are on. News, sim racing, weekly summary and product updates are off. Reminders arrive 30 minutes before qualifying, sprint and race. Quiet hours are off, set to 23:00 to 07:00 with the "hold" policy when turned on.

**Session reminders**
- Timings: 24 hours, 1 hour, 30 minutes or 15 minutes before, or at the start. Any combination can be chosen.
- One reminder per (session, start time, timing) for each user, whichever follows matched. Duplicate timings never produce two reminders for the same moment.
- Only sessions whose `time_status` is `confirmed` get reminders. Provisional and TBC times are labelled as such in the app and never trigger an alert.
- **Reschedule**: a new start time means new dedupe keys. Held reminders for the old time are cancelled and unread ones archived, and followers get a "rescheduled" notification showing the new and old times in their timezone. Changes are pushed for sessions within 21 days; further-out calendar moves are treated as news.
- **Postponed or cancelled**: no further reminders, and followers are notified. Cancelling a whole event cascades to its sessions.
- **Session started**: sent only to users who chose "at session start" and haven't already had that reminder.
- Each device gets reminders through exactly one mechanism. Registered devices get them from the server. Devices with permission but no server registration use local scheduling, reconciled whenever the app opens or a schedule-change push arrives. Devices without permission see them in the app only.

**Timezones**
- Sessions store an absolute instant (`timestamptz`) plus the venue's IANA zone and the wall time exactly as published. Offsets are never stored.
- Providers may send either an instant with an offset or a venue-local wall time plus zone. The wall time is converted with the zone rules for that date. A time that doesn't exist (spring-forward gap) or occurs twice (autumn overlap) without an explicit offset is rejected rather than guessed. So is a mismatch between the instant and the wall time.
- Users choose device time or a preferred timezone. Every time shown names its zone (for example "Sat 4 Jul, 15:00 BST"), and the event page shows both the user's time and circuit time.
- If the device timezone changes, for example while travelling, the app shows a notice and offers to keep the previous zone instead of switching silently. Reminder instants never move.

**Quiet hours**, evaluated in the user's timezone and correct across DST:
- News, results and AI updates are created in-app immediately; the push is held until quiet hours end.
- Session reminders and schedule changes follow the user's policy. "Hold until morning" is the default, and never holds past the session start: in that case the reminder stays in-app only. The alternatives are "Still deliver" and "In-app only".
- Security alerts are always immediate.
- Nothing is silently discarded: anything not pushed is still in the notification centre, with a note explaining why.

**Rate limits** (per user, rolling hour): at most 8 pushes overall, plus per-category caps, for example 2 major headlines and 6 session reminders. Over the limit, the notification is still created in-app with the note "Not pushed: notification limit reached". Security and system messages are exempt.

**Collapsing**: news items with the same `storyKey` within 6 hours update one notification ("3 updates on this story") instead of adding more, with one push. Schedule changes are never collapsed, because each carries a new time.

**Content**: titles are at most 65 characters and bodies at most 178. Copy is factual with no emoji. Nothing user-generated or sensitive appears on the lock screen: AI and Track Lab texts are generic, and security alerts never include the email address, codes or passwords. Articles name their source, and the article screen links to it (https only).

## Mobile app

Expo Router app in `mobile/`.

- **Header bell** on every screen, showing the unread count. It updates through Supabase Realtime, on foreground, and when a notification is received.
- **Notification centre** (`app/notifications.tsx`):
  - Filters: All, Unread, Race weekend, Results, Drivers & teams, News, Apex AI, Account.
  - Tap opens the destination and marks the notification read. Long press marks it read. × dismisses (archives) it. "Mark all as read".
  - Keyset pagination (20 per page) and pull to refresh.
  - Loading, empty, error, signed-out and demo states.
- **Settings > Notifications** (`app/settings/notifications.tsx`):
  - Status panel separating four things: notifications enabled in Apex AI, device permission, server delivery, and live motorsport data.
  - Enable all, Disable all optional and Restore recommended.
  - Every category; reminder timings and session types; championship, driver and team follows; quiet hours and policy; timezone mode and search; account security.
  - Test notification: a server push, or a labelled local one when the server isn't set up.
  - Add or remove sample notifications.
  - Changes auto-save, with visible saving, saved and error-with-retry states.
- **Permission**: never requested at launch. "Turn on device notifications" first shows an explanation (`PermissionPrimer`), and only then the OS dialog. If the user declines, the app keeps working and Settings explains how to re-enable notifications in system settings.
- **Registration**: Android channels are created first. The app then gets an Expo token with the EAS project ID and calls `register_push_device`. It re-registers on token rotation and on sign-in.
- **Sign-out**: unregister the token while still authenticated, cancel local reminders, then sign out. If that happens offline, the token is released on the next launch with `release_push_token`.
- **Deep links**: tapping a notification (including from a cold start) goes through `resolveNotificationPath`, so only allow-listed paths open. Destinations:
  - `/events/:id`: sessions in your time and circuit time, unconfirmed times labelled, "remind me about this event"
  - `/drivers/:id`, `/teams/:id`: follow toggle
  - `/news/:id`: source and verification shown
  - `/ai/analyses/:id`, `/ai/reports/:id`, `/track-lab/projects/:id`
  - `/account/security`: devices list with remove, sign out
  - `/settings/notifications`

  Anything invalid opens the notification centre, never Home.
- **Demo mode**: if `EXPO_PUBLIC_SUPABASE_URL` and the key are not set, the app runs with five sample notifications, each titled "Sample:" and marked SAMPLE, stored on the device and never pushed. Preferences are saved locally, and the status panel says nothing is connected.

The Apex AI analysis and Track Lab viewers are not part of this repository. Their notification destinations open a screen that says so and shows the item reference, instead of falling back to Home.

## Setup and deployment

### 1. Supabase

```bash
cd apex
supabase link --project-ref <ref>
supabase db push                              # applies supabase/migrations
```

If Apex AI already has a `supabase/` directory, copy the migration and function folders into it rather than replacing its `config.toml`.

### 2. Edge Function secrets

```bash
supabase secrets set \
  APEX_INTERNAL_SECRET="$(openssl rand -hex 32)" \
  INGEST_SOURCE_SECRETS='{"<source-id>":"<long random secret shared with that provider>"}'
# Only if "Enhanced security for push notifications" is enabled in your Expo project:
supabase secrets set EXPO_ACCESS_TOKEN=<expo access token>
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_DB_URL` are provided to functions automatically. `APEX_INTERNAL_SECRET` must be at least 32 characters, or the internal endpoints refuse every request.

### 3. Deploy the functions

```bash
supabase functions deploy process-notifications check-push-receipts \
  ingest-motorsport-update notify-app-event send-test-notification
```

The functions import the shared packages through `supabase/functions/deno.json`, which points at `../../packages/...`. `deno check` passes for every function, and `process-notifications` was run under Deno against Postgres. However, deployment to a hosted project has not been tried. If your CLI version refuses imports outside `supabase/functions`, copy `packages/notifications-core/src` and `packages/notifications-server/src` into `supabase/functions/_shared/` and update the two paths in `deno.json`.

### 4. Schedule the workers

In the SQL editor, enable `pg_cron` and `pg_net`, store the functions URL and the internal secret in Vault (see the header of `supabase/cron.sql`), then run `supabase/cron.sql`. This schedules processing every minute, receipts every 15 minutes, and daily clean-up.

### 5. Expo / EAS (push credentials)

Push notifications need a development or store build; Expo Go is not enough. Since SDK 53, Expo Go on Android cannot receive remote pushes.

```bash
cd apex/mobile
eas init                         # creates the EAS project; put its id in EAS_PROJECT_ID
cp .env.example .env.local       # fill in EXPO_PUBLIC_SUPABASE_URL / ANON_KEY and EAS_PROJECT_ID
```

- **iOS**:
  - Needs an Apple Developer account.
  - `eas credentials` (or the first `eas build`) creates the APNs key.
  - Enable the Push Notifications and Time Sensitive Notifications capabilities for the bundle ID (`APEX_IOS_BUNDLE_ID`, default `ai.apex.app`).
- **Android**:
  - Create a Firebase project, add the Android app (`APEX_ANDROID_PACKAGE`) and download `google-services.json`. Point `APEX_GOOGLE_SERVICES_JSON` at it; it is ignored by git.
  - Upload an FCM V1 service-account key with `eas credentials`.
- **Build**:
  - Development build: `eas build --profile development --platform ios|android`, then install it on a physical device.
  - Local alternative: `npx expo run:ios --device` or `npx expo run:android`.

### 6. Physical-device checklist

Run this on at least one iPhone and one Android phone. Simulators can't receive remote pushes, and the app reports "Not available on simulators".

1. Fresh install: you are not asked for permission at launch.
2. Settings > Notifications > "Turn on device notifications": the explanation appears first, then the OS dialog. The status panel shows "Allowed" and "Active – this device is registered".
3. "Send a test notification": it arrives with the app in the foreground, the background, and killed. Tapping it opens Settings > Notifications.
4. Decline the permission on a second install: the app keeps working and the status says how to enable it in system settings.
5. Follow a supported championship. Ingest a confirmed session about 35 minutes ahead, with the reminder timing set to 30 minutes. The reminder arrives once, shows the time in your zone, and opens the event page.
6. Reschedule that session through ingest: you get a "rescheduled" notification, and the old reminder does not fire.
7. Quiet hours covering now, then queue a `report_ready` app event: it appears in the centre straight away and the push arrives when quiet hours end.
8. Sign out: the device disappears from `push_devices`, and no further pushes arrive for that account.
9. Android: check each channel in system settings (Session reminders, Schedule changes, News and so on) and turn one off.

## Connecting a motorsport data provider

No provider is connected in this repository, and no schedule, result or announcement data is bundled. Check the provider's licence, including any commercial-use restrictions, before connecting it.

1. Register the source and switch on the championships it covers:
   ```sql
   insert into data_sources (id, name, trust_level, licence_notes, homepage_url)
   values ('acme-timing', 'Acme Timing (licensed)', 'licensed_provider', 'Commercial licence #123, expires 2027-12', 'https://acme.example');
   update championships set supported = true where id in ('f1');
   ```
   Trust levels:
   - `official` or `licensed_provider`: may publish schedules, session status and results.
   - `trusted_media`: may publish announcements and news only.
   - `unverified`: rejected.
2. Give the provider their secret (from `INGEST_SOURCE_SECRETS`) and the endpoint `https://<ref>.supabase.co/functions/v1/ingest-motorsport-update`.
3. Each request is a JSON update, or an array of up to 200. Headers:
   - `x-apex-source: <source id>`
   - `x-apex-signature: sha256=<hex HMAC-SHA256 of the raw body>`

```bash
BODY='{"kind":"session.upsert","externalRef":"2026-gbr-q","eventExternalRef":"2026-gbr","sessionType":"qualifying","name":"Qualifying","localStart":"2026-07-04T15:00","timezone":"Europe/London","timeStatus":"confirmed"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST "$URL/ingest-motorsport-update" -H "x-apex-source: acme-timing" -H "x-apex-signature: sha256=$SIG" -d "$BODY"
```

| kind | Required fields | Effect |
|---|---|---|
| `event.upsert` | `externalRef, championshipId, name, timezone, status` and optional `circuitName, country, entries[{driverRef, driverName, teamRef?, teamName?}]` | Creates or updates the event, drivers, teams and entries. A cancelled or postponed event notifies followers of each session. |
| `session.upsert` | `externalRef, eventExternalRef, sessionType, name, timeStatus` plus `startsAt` (ISO with offset) and/or `localStart` with `timezone` | Creates the session. A changed confirmed time triggers a "rescheduled" notification, and a newly confirmed time triggers "time confirmed". |
| `session.status` | `externalRef, status` (`scheduled, live, finished, cancelled, postponed`) | Notifies on cancelled and postponed, and sends "has started" for live. |
| `results.published` | `sessionExternalRef, official: true`, optional `resultsUrl` | Sends "Official results are available" once. |
| `announcement` | `externalRef, announcementType, headline, summary, verification, publishedAt`, and `driverRefs` and/or `teamRefs` | Followers are notified when it is `confirmed`; rumours never are. |
| `news` | `externalRef, headline, summary, importance (breaking, major or minor), verification, publishedAt`, optional `championshipIds, driverRefs, teamRefs, url, storyKey` | Confirmed breaking and major news goes to opted-in users. Minor news is stored only. |

Every request is written to `ingest_log`, including rejected ones and the reason. Re-sending an identical update is a no-op.

Results with finishing positions, penalties and standings are not modelled yet. Notifications about them can only be added once a provider supplies that data; the system will not infer it.

## Sending Apex AI and Track Lab notifications

When a long-running job finishes, the service that owns it calls:

```bash
curl -X POST "$URL/notify-app-event" -H "authorization: Bearer $APEX_INTERNAL_SECRET" \
  -d '{"userId":"<auth user uuid>","kind":"analysis_completed","resourceId":"<analysis id>"}'
```

Supported kinds:

| Kind | Opens |
|---|---|
| `race_summary_ready`, `report_ready`, `export_ready` | `/ai/reports/:id` |
| `analysis_completed`, `ai_job_failed` | `/ai/analyses/:id` |
| `track_design_ready`, `track_export_ready`, `track_job_failed` | `/track-lab/projects/:id` |

The call is idempotent per (kind, resourceId). Chat replies are deliberately not supported. Collaboration and invitation notifications are not implemented, because Track Lab collaboration doesn't exist yet.

## Testing

```bash
cd apex
npm install
npm test               # core + mobile logic + database/pipeline tests (starts local Postgres 16)
npm run typecheck      # core, server and the Expo app
npm run check:functions   # deno check of every Edge Function (needs deno on PATH)
cd mobile && npx expo export --platform web   # or android / ios: verifies the app bundles
```

`npm run test:db` creates a throwaway database, loads `supabase/tests/supabase_stub.sql` (the Supabase roles, `auth.users`, `auth.uid()` and default grants) and the migration, then runs the server tests. Set `APEX_TEST_DATABASE_ADMIN_URL` to use another Postgres 15+ server.

Coverage of the required test areas:

| Requirement | Tests |
|---|---|
| Preference filtering, enforced server-side | `delivery-rules` › recipient decisions; `pipeline` › session reminders (muted user), preference changes after a push was held |
| Timezone conversion | `time` › converts event-local wall time, formats with the timezone named, resolves the effective timezone |
| DST transitions | `time` › spring-forward gap, autumn overlap, hourly round-trip across a year; `delivery-rules` › quiet hours across DST; `reminders` › DST between scheduling and session; `push-ingest` › rejects ambiguous/impossible times |
| Reminder scheduling | `reminders` (planning, offsets, past reminders); `pipeline` › reminders reach followers once, at the right time |
| Rescheduled sessions | `reminders` › rescheduled; `pipeline` › rescheduled session cancels held reminders and reminds at the new time; mobile `logic` › local reminders moved |
| Cancelled events | `reminders` › cancelled and postponed; `pipeline` › cancelled sessions |
| Duplicate prevention | `reminders` › same moment and stable keys; `pipeline` › re-running the window, overlapping follows, re-processing jobs, results once; `database-security` › unique dedupe key |
| Quiet hours | `delivery-rules` › quiet hours tests; `pipeline` › held reminders, security bypass |
| Rate limits | `delivery-rules` › rate limits; `pipeline` › rate limits suppress the push but keep the in-app notification; test notifications rate limited |
| Invalid or expired tokens | `pipeline` › invalid tokens are deregistered; receipt errors; `push-ingest` › token validation |
| Permission denial | mobile `logic` › never prompts on start-up, permission denial is handled |
| Logout and token cleanup | mobile `logic` › logout order, offline logout; `database-security` › unregistering, release by token, account deletion; `pipeline` › logout removes the device |
| Deep-link navigation | `preferences-links-content` › allow-listed destinations, never Home; mobile `logic` › local reminder deep link; Playwright run of the web build (below) |
| Database access control | `database-security` (16 tests) |
| Retry behaviour | `pipeline` › temporary push failures are retried with backoff; failed jobs are retried |
| Failed delivery logging | `pipeline` › receipt errors are logged; `push-ingest` › transport failures |

The web build was also driven in Chromium with Playwright, in demo mode:
- unread badge, opening a notification marks it read, filters, dismiss, "Mark all as read", persistence across reload
- deep link from a notification to Settings
- preference toggles, Enable all, Disable all optional and Restore recommended saved to storage
- reminder timings, quiet hours, timezone search
- the unknown-route and destination screens

There were no console errors.

## Operations and monitoring

```sql
-- Are the workers running? (also shown in the app's status panel)
select name, last_run_at, detail from system_heartbeats;
-- Delivery health over the last day
select status, error_code, count(*) from notification_deliveries
 where created_at > now() - interval '1 day' group by 1, 2 order by 3 desc;
-- Stuck or failed jobs
select job_type, status, attempts, last_error from notification_jobs where status in ('failed', 'processing');
-- What providers sent, and what was rejected
select received_at, source_id, kind, outcome, detail from ingest_log order by received_at desc limit 50;
```

Alert on any of these:
- the `dispatch` heartbeat older than 5 minutes
- any `InvalidCredentials` or `MismatchSenderId` receipt error (APNs/FCM setup)
- failed jobs
- a `missedWindow` in the `reminders` heartbeat, which means reminders were skipped after an outage

Push delivery depends on Apple and Google, the network and the device's power-saving and Focus settings. Apex AI does not promise delivery to the second.

## Status: what works today

| Definition of done | Status |
|---|---|
| 1. Open the notification centre | **Works.** Verified in the web build (demo mode); server mode type-checked, and its database side tested. |
| 2. Read and dismiss notifications | **Works.** Read, unread, mark all and dismiss verified in the browser; RLS-tested on the database. |
| 3–4. Change and save preferences | **Works.** Saved locally (verified in the browser) or to `notification_preferences` (RLS and constraints tested) and enforced by the server (pipeline tests). |
| 5. Schedule a race reminder from verified event data | **Works with a connected provider.** Ingest, validation and the reminder scan are tested end-to-end against Postgres. No provider is connected here, so there is no live data. |
| 6. Receive a supported local reminder | **Implemented, not device-tested.** Scheduling and reconciliation are unit tested and the iOS/Android bundles compile. It needs a physical-device run. |
| 7. Register for push when permission and backend allow | **Implemented, not device-tested.** Registration logic is unit tested and the RPC is tested on Postgres. It needs an EAS build, APNs/FCM credentials and a device. |
| 8. Open the correct screen from a notification | **Works.** Allow-list unit tested; in-app navigation verified in the browser. Tap handling for OS notifications needs a device run. |
| 9. No duplicate alerts for the same reminder | **Works.** Database uniqueness plus server and local reconciliation, all tested. |
| 10. App keeps working without push | **Works.** Demo/web run with no push; denial and "not configured" states unit tested. |

Not implemented, on purpose:
- new sign-in alerts: Supabase Auth has no safe new-sign-in hook wired up here
- weekly summary and sim-racing generators: preferences are stored and shown as "later"
- Track Lab collaboration notifications: the feature doesn't exist
- result positions, penalties and standings: they need provider data
