import { CATEGORY_INFO, type NotificationCategory } from './categories.ts'
import type { QuietHours } from './preferences.ts'
import { addDaysToWall, parseClockTime, wallTimeInZone, zonedWallTimeToInstant } from './time.ts'

/** True when `instant` falls inside the user's quiet hours, evaluated in their timezone. */
export function isInQuietHours(instant: Date, quiet: QuietHours, timeZone: string): boolean {
  if (!quiet.enabled) return false
  const start = parseClockTime(quiet.start)
  const end = parseClockTime(quiet.end)
  if (start === null || end === null || start === end) return false
  const m = wallTimeInZone(instant, timeZone).minutesOfDay
  return start < end ? m >= start && m < end : m >= start || m < end
}

/**
 * The next instant quiet hours end, computed on the local calendar so it stays
 * correct across DST changes (07:00 local is 07:00 local on both sides of a change).
 */
export function quietHoursEndAfter(instant: Date, quiet: QuietHours, timeZone: string): Date {
  const end = parseClockTime(quiet.end) ?? 0
  const local = wallTimeInZone(instant, timeZone)
  const today = { year: local.year, month: local.month, day: local.day, hour: Math.floor(end / 60), minute: end % 60, second: 0 }
  const candidate = zonedWallTimeToInstant(today, timeZone).instant
  if (candidate.getTime() > instant.getTime()) return candidate
  return zonedWallTimeToInstant(addDaysToWall(today, 1), timeZone).instant
}

export type DeliveryDecision =
  | { action: 'send_now' }
  | { action: 'defer'; until: Date; reason: 'quiet_hours' }
  | { action: 'in_app_only'; reason: 'quiet_hours' | 'quiet_hours_session_started' }

/**
 * How quiet hours affect a push. The in-app notification is always created; this only
 * decides when (or whether) the device push goes out.
 * - Account security is never delayed.
 * - Session reminders and schedule changes follow the user's reminder policy, and are
 *   never deferred to a time after the session has started.
 * - Everything else is held until quiet hours end.
 */
export function decideQuietHours(input: {
  category: NotificationCategory
  now: Date
  quietHours: QuietHours
  timeZone: string
  /** For session-linked notifications: when the session starts. */
  sessionStartsAt?: Date | null
}): DeliveryDecision {
  const { category, now, quietHours, timeZone } = input
  const priority = CATEGORY_INFO[category].priority
  // Security alerts, and test notifications the user just asked for, are never held.
  if (priority === 'critical' || category === 'system') return { action: 'send_now' }
  if (!isInQuietHours(now, quietHours, timeZone)) return { action: 'send_now' }

  const until = quietHoursEndAfter(now, quietHours, timeZone)
  if (priority === 'time_sensitive') {
    switch (quietHours.reminderPolicy) {
      case 'deliver':
        return { action: 'send_now' }
      case 'in_app_only':
        return { action: 'in_app_only', reason: 'quiet_hours' }
      case 'defer': {
        const startsAt = input.sessionStartsAt
        if (startsAt && until.getTime() >= startsAt.getTime()) {
          return { action: 'in_app_only', reason: 'quiet_hours_session_started' }
        }
        return { action: 'defer', until, reason: 'quiet_hours' }
      }
    }
  }
  return { action: 'defer', until, reason: 'quiet_hours' }
}

/** Plain-language explanation shown in Settings > Notifications > Quiet hours. */
export function describeQuietHoursPolicy(quiet: QuietHours): string {
  if (!quiet.enabled) return 'Quiet hours are off. Notifications arrive as soon as they are ready.'
  const window = `between ${quiet.start} and ${quiet.end}`
  const base = `News, results and Apex AI updates that arrive ${window} are held and delivered when quiet hours end. They still appear in your notification centre straight away.`
  const reminders = {
    deliver: 'Session reminders and schedule changes are still delivered during quiet hours.',
    defer:
      'Session reminders and schedule changes are held until quiet hours end. If the session will already have started by then, the reminder stays in your notification centre instead of being pushed.',
    in_app_only: 'Session reminders and schedule changes during quiet hours only appear in your notification centre.',
  }[quiet.reminderPolicy]
  return `${base} ${reminders} Account security alerts are always delivered immediately.`
}
