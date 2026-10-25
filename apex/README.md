# Apex AI notification system

The notification system for Apex AI:

- an in-app notification centre and notification settings in an Expo (React Native) app
- push notifications through Expo
- session reminders that handle timezones and DST
- a Supabase backend that enforces preferences, quiet hours, rate limits and deduplication on the server

Read **[docs/NOTIFICATIONS.md](docs/NOTIFICATIONS.md)** for the architecture, setup and deployment guide, device test checklist, provider integration contract and an honest status table.

```
apex/
├── packages/notifications-core     shared logic (app + server): preferences, timezones, reminders, quiet hours, rate limits, deep links, Expo client
├── packages/notifications-server   pipeline: verified ingest, jobs, reminder scan, fan-out, dispatch, receipts, Edge Function handlers
├── supabase/migrations             schema, RLS, RPCs, triggers
├── supabase/functions              Edge Functions (Deno) + cron.sql
├── mobile/                         Expo Router app: bell + notification centre, Settings > Notifications, push registration, local reminders
├── scripts/test-db.sh              throwaway Postgres for the database/pipeline tests
└── docs/NOTIFICATIONS.md
```

## Quick start

```bash
npm install
npm test            # 105 tests: core logic, mobile logic, database security + end-to-end pipeline (local Postgres 16)
npm run typecheck
cd mobile && npx expo start   # without .env.local the app runs in clearly labelled demo mode
```

## What is real and what isn't

- **Working and tested**:
  - notification centre and preferences (verified in a browser)
  - the full server pipeline against a real Postgres database, using a stand-in for the Expo push service
  - RLS and token security
  - Edge Functions type-checked with Deno, with one run under Deno against the database
- **Demonstration only**: the "Sample:" notifications shown when no backend is configured. They are labelled, stored on the device and never pushed.
- **Not connected here**:
  - live motorsport data: no provider or licence is configured, and no schedules or results are bundled or invented
  - real push delivery, which needs an EAS project, APNs/FCM credentials and physical devices; not yet run on a device
  - a hosted Supabase project

Each of these comes with step-by-step setup instructions in the guide.

> This workspace sits inside the Li'l Piggy Squad repository, but it is self-contained and does not touch the website at the repository root.
