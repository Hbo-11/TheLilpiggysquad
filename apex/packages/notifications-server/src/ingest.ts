// Applies validated updates from trusted motorsport data providers and queues
// notification jobs for changes users need to hear about. Each job has an
// idempotency key, so a provider re-sending the same update never re-notifies.

import {
  checkSourceAllowed,
  canNotifyVerification,
  validateIngestUpdate,
  type IngestUpdate,
  type TrustLevel,
} from '@apex/notifications-core'
import { inTransaction, type Db } from './db.ts'
import { cancelObsoleteReminders } from './reminders.ts'

export type IngestOutcome =
  | { outcome: 'applied'; jobsQueued: number; detail?: Record<string, unknown> }
  | { outcome: 'unchanged'; jobsQueued: 0 }
  | { outcome: 'rejected'; errors: string[] }

/** Only notify about schedule changes this close to the session; further-out calendar moves are news. */
export const SCHEDULE_CHANGE_NOTIFY_WINDOW_MS = 21 * 86_400_000

export type SessionChange = 'rescheduled' | 'postponed' | 'cancelled' | 'time_confirmed' | 'live'

export interface SessionChangePayload {
  sessionId: string
  change: SessionChange
  previousStartsAt: string | null
  startsAt: string | null
  scheduleVersion: number
}

async function queueJob(db: Db, jobType: string, payload: Record<string, unknown>, idempotencyKey: string, now: Date): Promise<number> {
  const rows = await db`
    insert into public.notification_jobs (job_type, payload, idempotency_key, run_after, created_at)
    values (${jobType}, ${db.json(payload as never)}, ${idempotencyKey}, ${now}, ${now})
    on conflict (idempotency_key) do nothing
    returning id`
  return rows.length
}

async function log(db: Db, sourceId: string | null, kind: string | null, ref: string | null, result: IngestOutcome) {
  const detail = result.outcome === 'rejected' ? { errors: result.errors } : { jobsQueued: result.jobsQueued, ...('detail' in result ? result.detail : {}) }
  await db`
    insert into public.ingest_log (source_id, kind, external_ref, outcome, detail)
    values (${sourceId}, ${kind}, ${ref}, ${result.outcome}, ${db.json(detail as never)})`
}

function refOf(u: IngestUpdate): string {
  return 'externalRef' in u ? u.externalRef : u.sessionExternalRef
}

export async function ingestUpdate(db: Db, input: { sourceId: string; payload: unknown; now: Date }): Promise<IngestOutcome> {
  const validation = validateIngestUpdate(input.payload)
  const kind = typeof (input.payload as { kind?: unknown })?.kind === 'string' ? String((input.payload as { kind: string }).kind).slice(0, 40) : null
  if (!validation.ok) {
    const r: IngestOutcome = { outcome: 'rejected', errors: validation.errors }
    await log(db, null, kind, null, r)
    return r
  }
  const update = validation.update
  return inTransaction(db, async (tx) => {
    const [source] = await tx<{ id: string; trust_level: TrustLevel; active: boolean }[]>`
      select id, trust_level, active from public.data_sources where id = ${input.sourceId}`
    const check = checkSourceAllowed(source ? { id: source.id, trustLevel: source.trust_level, active: source.active } : null, update.kind)
    const result: IngestOutcome = check.ok ? await apply(tx, input.sourceId, update, input.now) : { outcome: 'rejected', errors: [check.reason] }
    await log(tx, source ? source.id : null, update.kind, refOf(update), result)
    return result
  })
}

async function apply(db: Db, sourceId: string, u: IngestUpdate, now: Date): Promise<IngestOutcome> {
  switch (u.kind) {
    case 'event.upsert':
      return applyEvent(db, sourceId, u, now)
    case 'session.upsert':
      return applySession(db, sourceId, u, now)
    case 'session.status':
      return applySessionStatus(db, sourceId, u, now)
    case 'results.published':
      return applyResults(db, sourceId, u, now)
    case 'announcement':
    case 'news':
      return applyArticle(db, sourceId, u, now)
  }
}

async function applyEvent(db: Db, sourceId: string, u: Extract<IngestUpdate, { kind: 'event.upsert' }>, now: Date): Promise<IngestOutcome> {
  const [champ] = await db<{ supported: boolean }[]>`select supported from public.championships where id = ${u.championshipId}`
  if (!champ) return { outcome: 'rejected', errors: ['unknown_championship'] }
  if (!champ.supported) return { outcome: 'rejected', errors: ['championship_not_supported'] }

  const [existing] = await db<{ id: string; status: string; source_updated_at: Date | null }[]>`
    select id, status, source_updated_at from public.events where source_id = ${sourceId} and external_ref = ${u.externalRef} for update`
  if (isStale(existing?.source_updated_at, u.sourceUpdatedAt)) return { outcome: 'rejected', errors: ['stale_update'] }
  const [event] = await db<{ id: string }[]>`
    insert into public.events (source_id, external_ref, championship_id, name, circuit_name, country, timezone, status, source_updated_at)
    values (${sourceId}, ${u.externalRef}, ${u.championshipId}, ${u.name}, ${u.circuitName}, ${u.country}, ${u.timezone}, ${u.status}, ${u.sourceUpdatedAt})
    on conflict (source_id, external_ref) do update
      set championship_id = excluded.championship_id, name = excluded.name, circuit_name = excluded.circuit_name,
          country = excluded.country, timezone = excluded.timezone, status = excluded.status,
          source_updated_at = coalesce(excluded.source_updated_at, events.source_updated_at), updated_at = now()
    returning id`

  if (u.entries) {
    await db`delete from public.event_entries where event_id = ${event.id}`
    for (const e of u.entries) {
      let teamId: string | null = null
      if (e.teamRef) {
        const [team] = await db<{ id: string }[]>`
          insert into public.teams (source_id, external_ref, championship_id, name)
          values (${sourceId}, ${e.teamRef}, ${u.championshipId}, ${e.teamName ?? e.teamRef})
          on conflict (source_id, external_ref) do update set name = excluded.name, updated_at = now()
          returning id`
        teamId = team.id
      }
      const [driver] = await db<{ id: string }[]>`
        insert into public.drivers (source_id, external_ref, championship_id, team_id, name)
        values (${sourceId}, ${e.driverRef}, ${u.championshipId}, ${teamId}, ${e.driverName})
        on conflict (source_id, external_ref) do update set name = excluded.name, team_id = excluded.team_id, updated_at = now()
        returning id`
      await db`insert into public.event_entries (event_id, driver_id, team_id) values (${event.id}, ${driver.id}, ${teamId}) on conflict do nothing`
    }
  }

  // A whole event being cancelled or postponed cascades to its scheduled sessions.
  let jobsQueued = 0
  if ((u.status === 'cancelled' || u.status === 'postponed') && existing?.status !== u.status) {
    const sessions = await db<{ id: string; starts_at: Date | null; schedule_version: number }[]>`
      update public.event_sessions set status = ${u.status}, schedule_version = schedule_version + 1, updated_at = now()
       where event_id = ${event.id} and status = 'scheduled'
      returning id, starts_at, schedule_version`
    for (const s of sessions) jobsQueued += await queueSessionChange(db, s, u.status, s.starts_at, null, now)
  }
  return { outcome: 'applied', jobsQueued, detail: { eventId: event.id } }
}

/**
 * Providers may re-deliver or reorder updates. When they include their own
 * modification time, anything older than what we already applied is rejected,
 * so a late copy can never put back an old session time.
 */
function isStale(stored: Date | null | undefined, incoming: string | null): boolean {
  return !!stored && !!incoming && new Date(incoming).getTime() < stored.getTime()
}

async function queueSessionChange(
  db: Db,
  s: { id: string; schedule_version: number },
  change: SessionChange,
  previousStartsAt: Date | null,
  startsAt: Date | null,
  now: Date,
): Promise<number> {
  if (change !== 'cancelled' && change !== 'postponed' && change !== 'live') {
    const soonest = Math.min(...[previousStartsAt, startsAt].filter((d): d is Date => !!d).map((d) => d.getTime()))
    if (!Number.isFinite(soonest) || soonest - now.getTime() > SCHEDULE_CHANGE_NOTIFY_WINDOW_MS) return 0
  }
  const payload: SessionChangePayload = {
    sessionId: s.id,
    change,
    previousStartsAt: previousStartsAt?.toISOString() ?? null,
    startsAt: startsAt?.toISOString() ?? null,
    scheduleVersion: s.schedule_version,
  }
  const key = change === 'live' ? `session_live:${s.id}` : `session_change:${s.id}:v${s.schedule_version}`
  return queueJob(db, 'session_change', payload as unknown as Record<string, unknown>, key, now)
}

async function applySession(db: Db, sourceId: string, u: Extract<IngestUpdate, { kind: 'session.upsert' }>, now: Date): Promise<IngestOutcome> {
  const [event] = await db<{ id: string; timezone: string }[]>`
    select id, timezone from public.events where source_id = ${sourceId} and external_ref = ${u.eventExternalRef}`
  if (!event) return { outcome: 'rejected', errors: ['unknown_event'] }
  const startsAt = u.startsAt ? new Date(u.startsAt) : null

  const [existing] = await db<{ id: string; starts_at: Date | null; time_status: string; status: string; schedule_version: number; session_type: string; name: string; source_updated_at: Date | null }[]>`
    select id, starts_at, time_status, status, schedule_version, session_type, name, source_updated_at from public.event_sessions
     where source_id = ${sourceId} and external_ref = ${u.externalRef} for update`

  if (!existing) {
    await db`
      insert into public.event_sessions (event_id, source_id, external_ref, session_type, name, starts_at, local_start, timezone, time_status, source_updated_at)
      values (${event.id}, ${sourceId}, ${u.externalRef}, ${u.sessionType}, ${u.name}, ${startsAt}, ${u.localStart}, ${u.timezone}, ${u.timeStatus}, ${u.sourceUpdatedAt})`
    return { outcome: 'applied', jobsQueued: 0 }
  }
  if (isStale(existing.source_updated_at, u.sourceUpdatedAt)) return { outcome: 'rejected', errors: ['stale_update'] }

  const timeChanged = (existing.starts_at?.getTime() ?? null) !== (startsAt?.getTime() ?? null)
  const statusChanged = existing.time_status !== u.timeStatus
  const metaChanged = existing.name !== u.name || existing.session_type !== u.sessionType
  if (!timeChanged && !statusChanged && !metaChanged) {
    await db`update public.event_sessions set last_verified_at = now() where id = ${existing.id}`
    return { outcome: 'unchanged', jobsQueued: 0 }
  }

  let change: SessionChange | null = null
  // A cancelled session stays cancelled until the provider says otherwise (session.status).
  if (timeChanged && startsAt && u.timeStatus === 'confirmed' && existing.status !== 'cancelled') {
    change = existing.starts_at && existing.time_status === 'confirmed' ? 'rescheduled' : 'time_confirmed'
  }
  // A postponed session that gets a new confirmed time is back on.
  const reinstated = existing.status === 'postponed' && change !== null
  const [s] = await db<{ id: string; schedule_version: number }[]>`
    update public.event_sessions
       set session_type = ${u.sessionType}, name = ${u.name}, starts_at = ${startsAt}, local_start = ${u.localStart},
           timezone = ${u.timezone}, time_status = ${u.timeStatus},
           status = case when ${reinstated} then 'scheduled' else status end,
           schedule_version = schedule_version + case when ${timeChanged || statusChanged} then 1 else 0 end,
           source_updated_at = coalesce(${u.sourceUpdatedAt}::timestamptz, source_updated_at),
           last_verified_at = now(), updated_at = now()
     where id = ${existing.id}
    returning id, schedule_version`
  // The time is no longer confirmed: reminders built on it must not go out. The app
  // shows the session as provisional/TBC; no push claims a time we can't vouch for.
  const lostConfirmation = existing.time_status === 'confirmed' && u.timeStatus !== 'confirmed'
  const cancelled = lostConfirmation ? await cancelObsoleteReminders(db, s.id, null, false) : 0
  const jobsQueued = change ? await queueSessionChange(db, s, change, existing.starts_at, startsAt, now) : 0
  return cancelled ? { outcome: 'applied', jobsQueued, detail: { cancelledReminders: cancelled } } : { outcome: 'applied', jobsQueued }
}

async function applySessionStatus(db: Db, sourceId: string, u: Extract<IngestUpdate, { kind: 'session.status' }>, now: Date): Promise<IngestOutcome> {
  const [existing] = await db<{ id: string; status: string; starts_at: Date | null; time_status: string; source_updated_at: Date | null }[]>`
    select id, status, starts_at, time_status, source_updated_at from public.event_sessions where source_id = ${sourceId} and external_ref = ${u.externalRef} for update`
  if (!existing) return { outcome: 'rejected', errors: ['unknown_session'] }
  if (isStale(existing.source_updated_at, u.sourceUpdatedAt)) return { outcome: 'rejected', errors: ['stale_update'] }
  if (existing.status === u.status) return { outcome: 'unchanged', jobsQueued: 0 }
  const bumpVersion = u.status === 'cancelled' || u.status === 'postponed' || (u.status === 'scheduled' && existing.status !== 'live')
  const [s] = await db<{ id: string; schedule_version: number }[]>`
    update public.event_sessions
       set status = ${u.status}, schedule_version = schedule_version + ${bumpVersion ? 1 : 0},
           source_updated_at = coalesce(${u.sourceUpdatedAt}::timestamptz, source_updated_at), last_verified_at = now(), updated_at = now()
     where id = ${existing.id}
    returning id, schedule_version`
  let jobsQueued = 0
  if (u.status === 'cancelled' || u.status === 'postponed') {
    jobsQueued = await queueSessionChange(db, s, u.status, existing.starts_at, null, now)
  } else if (u.status === 'live') {
    jobsQueued = await queueSessionChange(db, s, 'live', null, existing.starts_at, now)
  } else if (u.status === 'scheduled' && (existing.status === 'postponed' || existing.status === 'cancelled') && existing.starts_at && existing.time_status === 'confirmed') {
    jobsQueued = await queueSessionChange(db, s, 'rescheduled', null, existing.starts_at, now)
  }
  return { outcome: 'applied', jobsQueued }
}

async function applyResults(db: Db, sourceId: string, u: Extract<IngestUpdate, { kind: 'results.published' }>, now: Date): Promise<IngestOutcome> {
  const [s] = await db<{ id: string; results_published_at: Date | null }[]>`
    select id, results_published_at from public.event_sessions where source_id = ${sourceId} and external_ref = ${u.sessionExternalRef} for update`
  if (!s) return { outcome: 'rejected', errors: ['unknown_session'] }
  if (s.results_published_at) return { outcome: 'unchanged', jobsQueued: 0 }
  await db`update public.event_sessions set results_published_at = now(), results_url = ${u.resultsUrl}, status = 'finished', updated_at = now() where id = ${s.id}`
  const jobsQueued = await queueJob(db, 'results_published', { sessionId: s.id }, `results:${s.id}`, now)
  return { outcome: 'applied', jobsQueued }
}

async function applyArticle(db: Db, sourceId: string, u: Extract<IngestUpdate, { kind: 'announcement' | 'news' }>, now: Date): Promise<IngestOutcome> {
  const drivers = u.driverRefs.length
    ? await db<{ id: string }[]>`select id from public.drivers where source_id = ${sourceId} and external_ref = any(${u.driverRefs}::text[])`
    : []
  const teams = u.teamRefs.length
    ? await db<{ id: string }[]>`select id from public.teams where source_id = ${sourceId} and external_ref = any(${u.teamRefs}::text[])`
    : []
  const [prev] = await db<{ verification: string }[]>`
    select verification from public.articles where source_id = ${sourceId} and external_ref = ${u.externalRef}`
  const [article] = await db<{ id: string }[]>`
    insert into public.articles (source_id, external_ref, kind, announcement_type, importance, verification, headline, summary, url,
                                 story_key, championship_ids, driver_ids, team_ids, published_at)
    values (${sourceId}, ${u.externalRef}, ${u.kind}, ${u.kind === 'announcement' ? u.announcementType : null},
            ${u.kind === 'news' ? u.importance : null}, ${u.verification}, ${u.headline}, ${u.summary}, ${u.url},
            ${u.storyKey}, ${u.championshipIds}::text[], ${drivers.map((d) => d.id)}::uuid[], ${teams.map((t) => t.id)}::uuid[], ${u.publishedAt})
    on conflict (source_id, external_ref) do update
      set announcement_type = excluded.announcement_type, importance = excluded.importance, verification = excluded.verification,
          headline = excluded.headline, summary = excluded.summary, url = excluded.url, story_key = excluded.story_key,
          championship_ids = excluded.championship_ids, driver_ids = excluded.driver_ids, team_ids = excluded.team_ids,
          updated_at = now()
    returning id`

  // Notify once, when an item first becomes confirmed. Edits never re-notify; rumours never notify.
  const newlyConfirmed = canNotifyVerification(u.verification) && prev?.verification !== 'confirmed'
  const worthNotifying = u.kind === 'announcement' || u.importance !== 'minor'
  const jobsQueued = newlyConfirmed && worthNotifying ? await queueJob(db, 'article', { articleId: article.id }, `article:${article.id}`, now) : 0
  return { outcome: 'applied', jobsQueued, detail: { articleId: article.id } }
}
