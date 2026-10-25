import {
  OPTIONAL_CATEGORIES,
  REMINDER_OFFSETS,
  SESSION_TYPES,
  isOptionalCategory,
  isReminderOffset,
  isSessionType,
  type NotificationCategory,
  type OptionalCategory,
  type ReminderOffset,
  type SessionType,
} from './categories.ts'
import { isValidTimeZone, parseClockTime, type TimezoneMode } from './time.ts'

/**
 * What happens to a session reminder that falls inside quiet hours.
 * deliver: push it anyway (race reminders are only useful before the session).
 * defer: push when quiet hours end if the session has not started yet; otherwise keep it in-app only.
 * in_app_only: never push during quiet hours; it still appears in the notification centre.
 */
export type QuietHoursReminderPolicy = 'deliver' | 'defer' | 'in_app_only'

export interface QuietHours {
  enabled: boolean
  /** "HH:MM" in the user's effective timezone. May cross midnight (23:00 -> 07:00). */
  start: string
  end: string
  reminderPolicy: QuietHoursReminderPolicy
}

export interface NotificationPreferences {
  categories: Record<OptionalCategory, boolean>
  /** Account-wide switch for device delivery. In-app notifications are unaffected. */
  pushEnabled: boolean
  reminderOffsets: ReminderOffset[]
  reminderSessionTypes: Record<SessionType, boolean>
  timezoneMode: TimezoneMode
  preferredTimezone: string | null
  quietHours: QuietHours
}

// Keep in sync with the column defaults in supabase/migrations (a DB test checks this).
export function recommendedPreferences(): NotificationPreferences {
  return {
    categories: {
      race_reminders: true,
      schedule_changes: true,
      race_results: true,
      driver_updates: true,
      team_updates: true,
      news_major: false,
      news_breaking: false,
      ai_tasks: true,
      track_lab: true,
      sim_racing: false,
      weekly_summary: false,
      product_updates: false,
    },
    pushEnabled: true,
    reminderOffsets: [30],
    reminderSessionTypes: {
      practice: false,
      qualifying: true,
      sprint_qualifying: false,
      sprint: true,
      race: true,
      other: false,
    },
    timezoneMode: 'device',
    preferredTimezone: null,
    quietHours: { enabled: false, start: '23:00', end: '07:00', reminderPolicy: 'defer' },
  }
}

/** "Enable all notifications": every category and session type on. Timings and quiet hours are kept. */
export function enableAllNotifications(prefs: NotificationPreferences): NotificationPreferences {
  const categories = { ...prefs.categories }
  for (const c of OPTIONAL_CATEGORIES) categories[c] = true
  const reminderSessionTypes = { ...prefs.reminderSessionTypes }
  for (const t of SESSION_TYPES) reminderSessionTypes[t] = true
  return {
    ...prefs,
    categories,
    reminderSessionTypes,
    pushEnabled: true,
    reminderOffsets: prefs.reminderOffsets.length ? prefs.reminderOffsets : [30],
  }
}

/** "Disable all optional notifications". Account security stays on; it is not optional. */
export function disableAllOptionalNotifications(prefs: NotificationPreferences): NotificationPreferences {
  const categories = { ...prefs.categories }
  for (const c of OPTIONAL_CATEGORIES) categories[c] = false
  return { ...prefs, categories }
}

export function isCategoryEnabled(prefs: NotificationPreferences, category: NotificationCategory): boolean {
  if (category === 'account_security' || category === 'system') return true
  return prefs.categories[category] === true
}

export function sortOffsets(offsets: Iterable<ReminderOffset>): ReminderOffset[] {
  return [...new Set(offsets)].sort((a, b) => b - a)
}

export interface PreferencesValidation {
  preferences: NotificationPreferences
  errors: string[]
}

/**
 * Normalise untrusted input (from the app, the database or an API call) into valid
 * preferences. Unknown keys are dropped; invalid values fall back to the recommended
 * default and are reported in `errors`.
 */
export function normalizePreferences(input: unknown): PreferencesValidation {
  const defaults = recommendedPreferences()
  const errors: string[] = []
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>

  const categories = { ...defaults.categories }
  if (src.categories && typeof src.categories === 'object') {
    for (const [key, value] of Object.entries(src.categories as Record<string, unknown>)) {
      if (!isOptionalCategory(key)) {
        if (key !== 'account_security' && key !== 'system') errors.push(`Unknown category "${key}"`)
        continue
      }
      if (typeof value !== 'boolean') errors.push(`Category "${key}" must be true or false`)
      else categories[key] = value
    }
  }

  let reminderOffsets = defaults.reminderOffsets
  if (src.reminderOffsets !== undefined) {
    if (Array.isArray(src.reminderOffsets) && src.reminderOffsets.every(isReminderOffset)) {
      reminderOffsets = sortOffsets(src.reminderOffsets as ReminderOffset[])
    } else {
      errors.push(`Reminder timings must be a list of ${REMINDER_OFFSETS.join(', ')} minutes`)
    }
  }

  const reminderSessionTypes = { ...defaults.reminderSessionTypes }
  if (src.reminderSessionTypes && typeof src.reminderSessionTypes === 'object') {
    for (const [key, value] of Object.entries(src.reminderSessionTypes as Record<string, unknown>)) {
      if (!isSessionType(key)) errors.push(`Unknown session type "${key}"`)
      else if (typeof value !== 'boolean') errors.push(`Session type "${key}" must be true or false`)
      else reminderSessionTypes[key] = value
    }
  }

  let timezoneMode = defaults.timezoneMode
  if (src.timezoneMode !== undefined) {
    if (src.timezoneMode === 'device' || src.timezoneMode === 'preferred') timezoneMode = src.timezoneMode
    else errors.push('Timezone mode must be "device" or "preferred"')
  }

  let preferredTimezone: string | null = null
  if (src.preferredTimezone !== undefined && src.preferredTimezone !== null) {
    if (isValidTimeZone(src.preferredTimezone)) preferredTimezone = src.preferredTimezone
    else errors.push(`Unknown timezone "${String(src.preferredTimezone)}"`)
  }
  if (timezoneMode === 'preferred' && !preferredTimezone) {
    errors.push('Choose a preferred timezone or follow device time')
    timezoneMode = 'device'
  }

  let pushEnabled = defaults.pushEnabled
  if (src.pushEnabled !== undefined) {
    if (typeof src.pushEnabled === 'boolean') pushEnabled = src.pushEnabled
    else errors.push('pushEnabled must be true or false')
  }

  const quietHours = { ...defaults.quietHours }
  if (src.quietHours && typeof src.quietHours === 'object') {
    const q = src.quietHours as Record<string, unknown>
    if (typeof q.enabled === 'boolean') quietHours.enabled = q.enabled
    if (q.start !== undefined) {
      if (parseClockTime(q.start) !== null) quietHours.start = (q.start as string).slice(0, 5)
      else errors.push('Quiet hours start must be HH:MM')
    }
    if (q.end !== undefined) {
      if (parseClockTime(q.end) !== null) quietHours.end = (q.end as string).slice(0, 5)
      else errors.push('Quiet hours end must be HH:MM')
    }
    if (q.reminderPolicy !== undefined) {
      if (q.reminderPolicy === 'deliver' || q.reminderPolicy === 'defer' || q.reminderPolicy === 'in_app_only') {
        quietHours.reminderPolicy = q.reminderPolicy
      } else errors.push('Unknown quiet-hours reminder policy')
    }
    if (quietHours.start === quietHours.end) {
      errors.push('Quiet hours start and end must differ')
      quietHours.enabled = false
    }
  }

  return {
    preferences: { categories, pushEnabled, reminderOffsets, reminderSessionTypes, timezoneMode, preferredTimezone, quietHours },
    errors,
  }
}

// ---- Database row mapping (notification_preferences table) ----

export interface PreferencesRow {
  categories: Record<string, boolean>
  push_enabled: boolean
  reminder_offsets: number[]
  reminder_session_types: string[]
  timezone_mode: string
  preferred_timezone: string | null
  quiet_hours_enabled: boolean
  quiet_hours_start: string
  quiet_hours_end: string
  quiet_hours_reminder_policy: string
}

export function preferencesToRow(p: NotificationPreferences): PreferencesRow {
  return {
    categories: { ...p.categories },
    push_enabled: p.pushEnabled,
    reminder_offsets: sortOffsets(p.reminderOffsets),
    reminder_session_types: SESSION_TYPES.filter((t) => p.reminderSessionTypes[t]),
    timezone_mode: p.timezoneMode,
    preferred_timezone: p.preferredTimezone,
    quiet_hours_enabled: p.quietHours.enabled,
    quiet_hours_start: p.quietHours.start,
    quiet_hours_end: p.quietHours.end,
    quiet_hours_reminder_policy: p.quietHours.reminderPolicy,
  }
}

export function preferencesFromRow(row: Partial<PreferencesRow> | null | undefined): PreferencesValidation {
  if (!row) return { preferences: recommendedPreferences(), errors: [] }
  const types = Array.isArray(row.reminder_session_types) ? row.reminder_session_types : undefined
  return normalizePreferences({
    categories: row.categories,
    pushEnabled: row.push_enabled,
    reminderOffsets: row.reminder_offsets,
    reminderSessionTypes: types
      ? Object.fromEntries(SESSION_TYPES.map((t) => [t, types.includes(t)]))
      : undefined,
    timezoneMode: row.timezone_mode,
    preferredTimezone: row.preferred_timezone,
    quietHours:
      row.quiet_hours_start !== undefined
        ? {
            enabled: row.quiet_hours_enabled,
            start: String(row.quiet_hours_start).slice(0, 5),
            end: String(row.quiet_hours_end).slice(0, 5),
            reminderPolicy: row.quiet_hours_reminder_policy,
          }
        : undefined,
  })
}
