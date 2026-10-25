// Server-side session reminders. A scheduled worker (every minute) finds reminders
// whose fire time has arrived since the last scan, always using the session's
// *current* start time, so rescheduled sessions are handled without maintaining a
// per-user schedule table. Dedupe keys make re-scans and overlapping runs harmless.

import { dedupeKeys, sessionReminderText, type ReminderOffset, type SessionType } from '@apex/notifications-core'
import { heartbeat, inTransaction, type Db } from './db.ts'
import { fanOut } from './fanout.ts'

/** Reminders more than this late (e.g. after an outage) are skipped rather than sent stale. */
export const MAX_REMINDER_LATENESS_MS = 10 * 60_000
const SCAN_LOCK_KEY = 4_206_201

export interface ReminderScanResult {
  locked: boolean
  from: string
  to: string
  candidates: number
  created: number
  duplicates: number
  missedWindow: { from: string; to: string } | null
}

export async function scanReminders(db: Db, opts: { now: Date }): Promise<ReminderScanResult> {
  const { now } = opts
  return inTransaction(db, async (tx) => {
    const [{ locked }] = await tx<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(${SCAN_LOCK_KEY}) as locked`
    if (!locked) return { locked: false, from: '', to: '', candidates: 0, created: 0, duplicates: 0, missedWindow: null }

    const [state] = await tx<{ scanned_until: Date }[]>`select scanned_until from public.reminder_scan_state where id = 1 for update`
    const earliest = new Date(now.getTime() - MAX_REMINDER_LATENESS_MS)
    let from = state ? state.scanned_until : new Date(now.getTime() - 2 * 60_000)
    let missedWindow: ReminderScanResult['missedWindow'] = null
    if (from < earliest) {
      missedWindow = { from: from.toISOString(), to: earliest.toISOString() }
      from = earliest
    }
    if (from >= now) return { locked: true, from: from.toISOString(), to: now.toISOString(), candidates: 0, created: 0, duplicates: 0, missedWindow }

    const candidates = await tx<{ user_id: string; session_id: string; offset_minutes: number }[]>`
      select user_id, session_id, offset_minutes from public.reminder_candidates(${from}, ${now})`

    const groups = new Map<string, { sessionId: string; offset: number; users: string[] }>()
    for (const c of candidates) {
      const key = `${c.session_id}:${c.offset_minutes}`
      const g = groups.get(key) ?? { sessionId: c.session_id, offset: c.offset_minutes, users: [] }
      g.users.push(c.user_id)
      groups.set(key, g)
    }

    let created = 0
    let duplicates = 0
    for (const g of groups.values()) {
      const [s] = await tx<{ id: string; name: string; session_type: SessionType; starts_at: Date; event_id: string; event_name: string }[]>`
        select s.id, s.name, s.session_type, s.starts_at, e.id as event_id, e.name as event_name
          from public.event_sessions s join public.events e on e.id = s.event_id
         where s.id = ${g.sessionId}`
      if (!s) continue
      const startsAtIso = s.starts_at.toISOString()
      const r = await fanOut(
        tx,
        {
          category: 'race_reminders',
          kind: 'session_reminder',
          dedupeKey: dedupeKeys.sessionReminder(s.id, startsAtIso, g.offset),
          deepLink: `/events/${s.event_id}`,
          relatedSessionId: s.id,
          sessionStartsAt: s.starts_at,
          data: { type: 'session_reminder', sessionId: s.id, eventId: s.event_id, offsetMinutes: g.offset, sessionStartsAt: startsAtIso },
          text: ({ timeZone }) =>
            sessionReminderText({
              sessionName: s.name,
              sessionType: s.session_type,
              eventName: s.event_name,
              startsAt: s.starts_at,
              timeZone,
              offsetMinutes: g.offset as ReminderOffset,
            }),
        },
        g.users,
        { now },
      )
      created += r.created
      duplicates += r.duplicates
    }

    await tx`
      insert into public.reminder_scan_state (id, scanned_until) values (1, ${now})
      on conflict (id) do update set scanned_until = excluded.scanned_until`
    const result = { locked: true, from: from.toISOString(), to: now.toISOString(), candidates: candidates.length, created, duplicates, missedWindow }
    await heartbeat(tx, 'reminders', result, now)
    return result
  })
}

/**
 * When a session moves or is called off, reminders already created for the old
 * time (e.g. held for quiet hours) must not go out. Pending pushes are cancelled
 * and unread obsolete reminders are archived; the schedule-change notification
 * tells the user what happened.
 */
export async function cancelObsoleteReminders(db: Db, sessionId: string, currentStartsAt: Date | null, stillScheduled: boolean): Promise<number> {
  const current = currentStartsAt?.toISOString() ?? null
  const obsolete = await db<{ id: string }[]>`
    select id from public.notifications
     where related_session_id = ${sessionId} and kind = 'session_reminder'
       and (${!stillScheduled} or (data ->> 'sessionStartsAt') is distinct from ${current})`
  if (obsolete.length === 0) return 0
  const ids = obsolete.map((o) => o.id)
  await db`
    update public.notification_deliveries set status = 'cancelled', error_code = 'SESSION_CHANGED'
     where notification_id = any(${ids}::uuid[]) and status = 'pending'`
  await db`
    update public.notifications
       set push_state = case when push_state = 'scheduled' then 'cancelled' else push_state end,
           archived_at = case when read_at is null then coalesce(archived_at, now()) else archived_at end
     where id = any(${ids}::uuid[])`
  return ids.length
}
