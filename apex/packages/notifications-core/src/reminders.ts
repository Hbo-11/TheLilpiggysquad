import type { ReminderOffset, SessionType } from './categories.ts'
import { dedupeKeys } from './dedupe.ts'
import { sortOffsets, type NotificationPreferences } from './preferences.ts'

export type SessionTimeStatus = 'confirmed' | 'provisional' | 'tbc'
export type SessionStatus = 'scheduled' | 'live' | 'finished' | 'cancelled' | 'postponed'

export interface SessionForReminders {
  id: string
  eventId: string
  sessionType: SessionType
  /** Absolute start instant (ISO-8601 with offset), or null when not yet known. */
  startsAt: string | null
  timeStatus: SessionTimeStatus
  status: SessionStatus
}

export interface PlannedReminder {
  sessionId: string
  eventId: string
  offsetMinutes: ReminderOffset
  fireAt: Date
  sessionStartsAt: string
  dedupeKey: string
}

export type ReminderSkipReason =
  | 'time_unverified'
  | 'no_start_time'
  | 'session_not_scheduled'
  | 'session_type_disabled'
  | 'reminders_disabled'
  | 'no_offsets'
  | 'already_passed'
  | 'duplicate_fire_time'

export interface ReminderPlan {
  reminders: PlannedReminder[]
  skipped: { offsetMinutes?: number; reason: ReminderSkipReason }[]
}

/**
 * Work out which reminders a user should get for one session.
 * - Only sessions with a confirmed time get reminders: provisional or TBC times are
 *   shown in the app with a clear label instead of triggering a misleading alert.
 * - Overlapping settings never produce two reminders for the same moment.
 * - Reminders whose time has already passed (beyond a small grace period) are dropped.
 */
export function planSessionReminders(input: {
  session: SessionForReminders
  prefs: NotificationPreferences
  now: Date
  /** Reminders up to this late are still sent (covers scheduler jitter). Default 2 minutes. */
  graceMs?: number
}): ReminderPlan {
  const { session, prefs, now } = input
  const graceMs = input.graceMs ?? 2 * 60_000
  const skipped: ReminderPlan['skipped'] = []

  if (!prefs.categories.race_reminders) return { reminders: [], skipped: [{ reason: 'reminders_disabled' }] }
  if (session.status !== 'scheduled') return { reminders: [], skipped: [{ reason: 'session_not_scheduled' }] }
  if (!session.startsAt) return { reminders: [], skipped: [{ reason: 'no_start_time' }] }
  if (session.timeStatus !== 'confirmed') return { reminders: [], skipped: [{ reason: 'time_unverified' }] }
  if (!prefs.reminderSessionTypes[session.sessionType]) {
    return { reminders: [], skipped: [{ reason: 'session_type_disabled' }] }
  }
  const offsets = sortOffsets(prefs.reminderOffsets)
  if (offsets.length === 0) return { reminders: [], skipped: [{ reason: 'no_offsets' }] }

  const start = new Date(session.startsAt)
  const seenFireTimes = new Set<number>()
  const reminders: PlannedReminder[] = []
  for (const offsetMinutes of offsets) {
    const fireAt = new Date(start.getTime() - offsetMinutes * 60_000)
    if (fireAt.getTime() < now.getTime() - graceMs) {
      skipped.push({ offsetMinutes, reason: 'already_passed' })
      continue
    }
    if (seenFireTimes.has(fireAt.getTime())) {
      skipped.push({ offsetMinutes, reason: 'duplicate_fire_time' })
      continue
    }
    seenFireTimes.add(fireAt.getTime())
    reminders.push({
      sessionId: session.id,
      eventId: session.eventId,
      offsetMinutes,
      fireAt,
      sessionStartsAt: start.toISOString(),
      dedupeKey: dedupeKeys.sessionReminder(session.id, session.startsAt, offsetMinutes),
    })
  }
  return { reminders, skipped }
}

export interface ScheduledLocalReminder {
  /** The identifier the OS scheduler knows the notification by. */
  identifier: string
  dedupeKey: string | null
}

/**
 * Reconcile the reminders scheduled on the device with what should be scheduled now.
 * Run whenever the app starts, preferences change, follows change or a
 * "schedule changed" push arrives. Rescheduled or cancelled sessions produce a
 * different (or no) dedupe key, so their old reminders are cancelled here.
 */
export function reconcileLocalReminders(
  desired: PlannedReminder[],
  existing: ScheduledLocalReminder[],
): { toCancel: string[]; toSchedule: PlannedReminder[]; unchanged: number } {
  const desiredKeys = new Set(desired.map((r) => r.dedupeKey))
  const keep = new Set<string>()
  const toCancel: string[] = []
  for (const e of existing) {
    if (e.dedupeKey && desiredKeys.has(e.dedupeKey) && !keep.has(e.dedupeKey)) keep.add(e.dedupeKey)
    else toCancel.push(e.identifier) // obsolete, unknown, or a duplicate of one we keep
  }
  const toSchedule = desired.filter((r) => !keep.has(r.dedupeKey))
  return { toCancel, toSchedule, unchanged: keep.size }
}

/** Maximum local notifications iOS keeps scheduled per app. We stay below it. */
export const IOS_PENDING_LOCAL_LIMIT = 64

/** Keep the soonest reminders when there are more than the platform allows. */
export function limitLocalReminders(reminders: PlannedReminder[], limit = IOS_PENDING_LOCAL_LIMIT - 4): PlannedReminder[] {
  return [...reminders].sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime()).slice(0, limit)
}
