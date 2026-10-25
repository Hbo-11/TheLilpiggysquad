// Background job processing. Jobs are claimed with FOR UPDATE SKIP LOCKED so
// several workers can run safely; handlers are idempotent (dedupe keys), so a
// retried job never produces duplicate notifications.

import {
  APP_EVENT_KINDS,
  SECURITY_EVENT_KINDS,
  appEventText,
  articleText,
  collapseKeys,
  collapsedArticleText,
  dedupeKeys,
  resultsText,
  retryDelayMs,
  scheduleChangeText,
  securityText,
  sessionLiveText,
  type AppEventKind,
  type NotificationCategory,
  type SecurityEventKind,
  type SessionType,
} from '@apex/notifications-core'
import { heartbeat, inTransaction, type Db } from './db.ts'
import { fanOut, type FanOutResult } from './fanout.ts'
import type { SessionChangePayload } from './ingest.ts'
import { cancelObsoleteReminders } from './reminders.ts'

export const MAX_JOB_ATTEMPTS = 5
const STUCK_JOB_MS = 10 * 60_000

interface JobRow {
  id: string
  job_type: string
  payload: Record<string, unknown>
  attempts: number
}

export interface JobRunSummary {
  claimed: number
  done: number
  retried: number
  failed: number
}

export async function processJobs(db: Db, opts: { now: Date; limit?: number }): Promise<JobRunSummary> {
  const { now } = opts
  const summary: JobRunSummary = { claimed: 0, done: 0, retried: 0, failed: 0 }
  // Jobs whose worker died mid-run go back to the queue.
  await db`
    update public.notification_jobs set status = 'queued', locked_at = null
     where status = 'processing' and locked_at < ${new Date(now.getTime() - STUCK_JOB_MS)}`

  const jobs = await db<JobRow[]>`
    update public.notification_jobs j
       set status = 'processing', locked_at = ${now}, attempts = j.attempts + 1
      from (select id from public.notification_jobs
             where status = 'queued' and run_after <= ${now}
             order by run_after limit ${opts.limit ?? 50}
             for update skip locked) c
     where j.id = c.id
    returning j.id, j.job_type, j.payload, j.attempts`
  summary.claimed = jobs.length

  for (const job of jobs) {
    try {
      const result = await inTransaction(db, (tx) => runJob(tx, job, now))
      await db`
        update public.notification_jobs set status = 'done', completed_at = ${now}, last_error = null, result = ${db.json(result as never)}
         where id = ${job.id}`
      summary.done++
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err).slice(0, 1000)
      if (job.attempts >= MAX_JOB_ATTEMPTS) {
        await db`update public.notification_jobs set status = 'failed', last_error = ${message}, completed_at = ${now} where id = ${job.id}`
        summary.failed++
      } else {
        const runAfter = new Date(now.getTime() + retryDelayMs(job.attempts))
        await db`update public.notification_jobs set status = 'queued', last_error = ${message}, run_after = ${runAfter}, locked_at = null where id = ${job.id}`
        summary.retried++
      }
    }
  }
  await heartbeat(db, 'jobs', { ...summary }, now)
  return summary
}

async function runJob(db: Db, job: JobRow, now: Date): Promise<Record<string, unknown>> {
  switch (job.job_type) {
    case 'session_change':
      return handleSessionChange(db, job.payload as unknown as SessionChangePayload, now)
    case 'results_published':
      return handleResults(db, String(job.payload.sessionId), now)
    case 'article':
      return handleArticle(db, String(job.payload.articleId), now)
    case 'app_event':
      return handleAppEvent(db, job.payload, now)
    case 'security_event':
      return handleSecurityEvent(db, job.id, job.payload, now)
    default:
      throw new Error(`Unknown job type ${job.job_type}`)
  }
}

interface SessionDetail {
  id: string
  name: string
  session_type: SessionType
  starts_at: Date | null
  status: string
  event_id: string
  event_name: string
}

async function loadSession(db: Db, sessionId: string): Promise<SessionDetail | null> {
  const [s] = await db<SessionDetail[]>`
    select s.id, s.name, s.session_type, s.starts_at, s.status, e.id as event_id, e.name as event_name
      from public.event_sessions s join public.events e on e.id = s.event_id
     where s.id = ${sessionId}`
  return s ?? null
}

async function sessionAudience(db: Db, sessionId: string): Promise<string[]> {
  const rows = await db<{ user_id: string }[]>`select user_id from public.session_audience(${sessionId})`
  return rows.map((r) => r.user_id)
}

async function handleSessionChange(db: Db, p: SessionChangePayload, now: Date): Promise<Record<string, unknown>> {
  const s = await loadSession(db, p.sessionId)
  if (!s) return { skipped: 'session_missing' }

  if (p.change === 'live') {
    // "Session started": only for users who asked for an at-start reminder and have
    // not already had one for this start time (no double alert).
    const startsAtIso = s.starts_at?.toISOString() ?? null
    const reminderKey = startsAtIso ? dedupeKeys.sessionReminder(s.id, startsAtIso, 0) : ''
    const users = await db<{ user_id: string }[]>`
      select a.user_id from public.session_audience(${s.id}) a
        join public.notification_preferences p on p.user_id = a.user_id
       where 0 = any(p.reminder_offsets) and ${s.session_type} = any(p.reminder_session_types)
         and not exists (select 1 from public.notifications n where n.user_id = a.user_id and n.dedupe_key = ${reminderKey})`
    const r = await fanOut(
      db,
      {
        category: 'race_reminders',
        kind: 'session_live',
        dedupeKey: dedupeKeys.sessionStatus(s.id, 'live'),
        deepLink: `/events/${s.event_id}`,
        relatedSessionId: s.id,
        data: { type: 'session_live', sessionId: s.id, eventId: s.event_id },
        text: () => sessionLiveText({ sessionName: s.name, sessionType: s.session_type, eventName: s.event_name }),
      },
      users.map((u) => u.user_id),
      { now },
    )
    return { ...r }
  }

  const cancelled = await cancelObsoleteReminders(db, s.id, s.starts_at, s.status === 'scheduled')
  const previous = p.previousStartsAt ? new Date(p.previousStartsAt) : null
  const startsAt = p.startsAt ? new Date(p.startsAt) : null
  const r = await fanOut(
    db,
    {
      category: 'schedule_changes',
      kind: 'schedule_change',
      dedupeKey: dedupeKeys.scheduleChange(s.id, p.scheduleVersion),
      deepLink: `/events/${s.event_id}`,
      relatedSessionId: s.id,
      sessionStartsAt: startsAt,
      // Not collapsed: every confirmed change carries a new time the user needs to see.
      data: { type: 'schedule_change', change: p.change, sessionId: s.id, eventId: s.event_id, startsAt: p.startsAt, previousStartsAt: p.previousStartsAt },
      text: ({ timeZone }) =>
        scheduleChangeText({
          sessionName: s.name,
          sessionType: s.session_type,
          eventName: s.event_name,
          timeZone,
          change: p.change as 'rescheduled' | 'postponed' | 'cancelled' | 'time_confirmed',
          previousStartsAt: previous,
          startsAt,
        }),
    },
    await sessionAudience(db, s.id),
    { now },
  )
  return { ...r, cancelledReminders: cancelled }
}

async function handleResults(db: Db, sessionId: string, now: Date): Promise<Record<string, unknown>> {
  const s = await loadSession(db, sessionId)
  if (!s) return { skipped: 'session_missing' }
  if (s.session_type === 'practice') return { skipped: 'practice_results_not_notified' }
  const r = await fanOut(
    db,
    {
      category: 'race_results',
      kind: 'results_published',
      dedupeKey: dedupeKeys.resultsPublished(s.id),
      deepLink: `/events/${s.event_id}`,
      relatedSessionId: s.id,
      data: { type: 'results_published', sessionId: s.id, eventId: s.event_id },
      text: () => resultsText({ sessionName: s.name, sessionType: s.session_type, eventName: s.event_name }),
    },
    await sessionAudience(db, s.id),
    { now },
  )
  return { ...r }
}

interface ArticleRow {
  id: string
  source_id: string
  source_name: string
  external_ref: string
  kind: 'news' | 'announcement'
  importance: 'breaking' | 'major' | 'minor' | null
  verification: string
  headline: string
  summary: string
  url: string | null
  story_key: string | null
  championship_ids: string[]
  driver_ids: string[]
  team_ids: string[]
}

async function handleArticle(db: Db, articleId: string, now: Date): Promise<Record<string, unknown>> {
  const [a] = await db<ArticleRow[]>`
    select a.*, ds.name as source_name from public.articles a join public.data_sources ds on ds.id = a.source_id where a.id = ${articleId}`
  if (!a) return { skipped: 'article_missing' }
  if (a.verification !== 'confirmed') return { skipped: 'not_confirmed' }
  if (a.kind === 'news' && a.importance === 'minor') return { skipped: 'minor_story' }

  const base = {
    kind: a.kind === 'announcement' ? 'announcement' : 'news',
    dedupeKey: dedupeKeys.article(a.source_id, a.external_ref),
    deepLink: `/news/${a.id}`,
    sourceId: a.source_id,
    sourceUrl: a.url,
    collapseKey: a.story_key ? collapseKeys.story(a.story_key) : null,
    data: { type: a.kind, articleId: a.id },
    text: () => articleText({ headline: a.headline, summary: a.summary, sourceName: a.source_name }),
    collapsedText: ({ count }: { count: number }) => collapsedArticleText({ headline: a.headline, count, sourceName: a.source_name }),
  }

  const followers = async (entityType: string, ids: string[]) =>
    ids.length
      ? (await db<{ user_id: string }[]>`select distinct user_id from public.user_follows where entity_type = ${entityType} and entity_id = any(${ids}::text[])`).map((r) => r.user_id)
      : []

  const results: Record<string, FanOutResult> = {}
  if (a.kind === 'announcement') {
    // Users following both a driver and the team get it once (same dedupe key);
    // driver follows are tried first, then team follows.
    results.drivers = await fanOut(db, { ...base, category: 'driver_updates' }, await followers('driver', a.driver_ids), { now })
    results.teams = await fanOut(db, { ...base, category: 'team_updates' }, await followers('team', a.team_ids), { now })
    return results
  }

  const category: NotificationCategory = a.importance === 'breaking' ? 'news_breaking' : 'news_major'
  const related = [
    ...(await followers('championship', a.championship_ids)),
    ...(await followers('driver', a.driver_ids)),
    ...(await followers('team', a.team_ids)),
  ]
  // Stories not tied to anything specific go to everyone who opted into that news level.
  const audience =
    a.championship_ids.length + a.driver_ids.length + a.team_ids.length > 0
      ? related
      : (await db<{ user_id: string }[]>`select user_id from public.notification_preferences where (categories ->> ${category})::boolean`).map((r) => r.user_id)
  results.news = await fanOut(db, { ...base, category }, audience, { now })
  return results
}

const APP_EVENT_ROUTES: Record<AppEventKind, { category: NotificationCategory; path: (id: string) => string }> = {
  race_summary_ready: { category: 'ai_tasks', path: (id) => `/ai/reports/${id}` },
  analysis_completed: { category: 'ai_tasks', path: (id) => `/ai/analyses/${id}` },
  report_ready: { category: 'ai_tasks', path: (id) => `/ai/reports/${id}` },
  export_ready: { category: 'ai_tasks', path: (id) => `/ai/reports/${id}` },
  ai_job_failed: { category: 'ai_tasks', path: (id) => `/ai/analyses/${id}` },
  track_design_ready: { category: 'track_lab', path: (id) => `/track-lab/projects/${id}` },
  track_export_ready: { category: 'track_lab', path: (id) => `/track-lab/projects/${id}` },
  track_job_failed: { category: 'track_lab', path: (id) => `/track-lab/projects/${id}` },
}

async function handleAppEvent(db: Db, p: Record<string, unknown>, now: Date): Promise<Record<string, unknown>> {
  const kind = p.kind as AppEventKind
  if (!(APP_EVENT_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown app event ${String(p.kind)}`)
  const resourceId = String(p.resourceId)
  const route = APP_EVENT_ROUTES[kind]
  const r = await fanOut(
    db,
    {
      category: route.category,
      kind,
      dedupeKey: dedupeKeys.appEvent(kind, resourceId),
      deepLink: route.path(resourceId),
      data: { type: kind, resourceId },
      text: () => appEventText(kind),
    },
    [String(p.userId)],
    { now },
  )
  return { ...r }
}

async function handleSecurityEvent(db: Db, jobId: string, p: Record<string, unknown>, now: Date): Promise<Record<string, unknown>> {
  const kind = p.kind as SecurityEventKind
  if (!(SECURITY_EVENT_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown security event ${String(p.kind)}`)
  const r = await fanOut(
    db,
    {
      category: 'account_security',
      kind,
      dedupeKey: dedupeKeys.security(kind, jobId),
      deepLink: '/account/security',
      data: { type: kind },
      text: () => securityText(kind),
    },
    [String(p.userId)],
    { now },
  )
  return { ...r }
}

/** Queue a notification for a finished/failed Apex AI or Track Lab job (trusted server code only). */
export async function queueAppEvent(db: Db, input: { userId: string; kind: AppEventKind; resourceId: string; now?: Date }): Promise<boolean> {
  const now = input.now ?? new Date()
  if (!(APP_EVENT_KINDS as readonly string[]).includes(input.kind)) throw new Error('Unknown app event kind')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.resourceId)) throw new Error('Invalid resource id')
  if (!/^[0-9a-f-]{36}$/i.test(input.userId)) throw new Error('Invalid user id')
  const rows = await db`
    insert into public.notification_jobs (job_type, payload, idempotency_key, run_after, created_at)
    values ('app_event', ${db.json({ userId: input.userId, kind: input.kind, resourceId: input.resourceId } as never)},
            ${dedupeKeys.appEvent(input.kind, input.resourceId)}, ${now}, ${now})
    on conflict (idempotency_key) do nothing returning id`
  return rows.length > 0
}
