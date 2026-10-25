// Timezone-aware conversions built on Intl (available in Node, Deno and Hermes).
// Event times are stored as absolute instants (timestamptz) plus the event's IANA
// timezone. We never store a recurring schedule as a fixed UTC offset: offsets are
// always derived from the IANA zone for the specific instant, so DST is handled.

export interface WallTime {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  second?: number
}

export type WallTimeResolution = 'exact' | 'ambiguous' | 'skipped'

export interface ResolvedWallTime {
  instant: Date
  /**
   * exact: the wall time occurs once.
   * ambiguous: the wall time occurs twice (clocks went back); `disambiguation` picked one.
   * skipped: the wall time does not exist (clocks went forward); shifted forward by the gap.
   */
  resolution: WallTimeResolution
}

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    formatterCache.set(timeZone, f)
  }
  return f
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export interface ZonedParts extends Required<WallTime> {
  /** 0 = Sunday */
  weekday: number
  /** Minutes since local midnight. */
  minutesOfDay: number
}

/** The wall-clock time an instant shows in a timezone. */
export function wallTimeInZone(instant: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(instant)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  let hour = Number(get('hour'))
  if (hour === 24) hour = 0 // some engines emit 24 for midnight
  const result = {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS.indexOf(get('weekday')),
    minutesOfDay: 0,
  }
  result.minutesOfDay = result.hour * 60 + result.minute
  return result
}

function wallAsUtcMs(w: WallTime): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second ?? 0)
}

/** Offset of the zone from UTC at the given instant, in minutes (e.g. +60 for BST). */
export function offsetMinutesAt(instant: Date, timeZone: string): number {
  const w = wallTimeInZone(instant, timeZone)
  const asUtc = wallAsUtcMs(w)
  const instantSeconds = Math.floor(instant.getTime() / 1000) * 1000
  return Math.round((asUtc - instantSeconds) / 60000)
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    (a.second ?? 0) === (b.second ?? 0)
  )
}

/**
 * Convert a wall-clock time in an IANA timezone to an absolute instant.
 * Handles DST gaps (shifted forward, like Temporal's "compatible") and overlaps
 * (earlier occurrence by default).
 */
export function zonedWallTimeToInstant(
  wall: WallTime,
  timeZone: string,
  disambiguation: 'earlier' | 'later' = 'earlier',
): ResolvedWallTime {
  if (!isValidTimeZone(timeZone)) throw new RangeError(`Unknown timezone: ${timeZone}`)
  const guess = wallAsUtcMs(wall)
  const DAY = 86_400_000
  const offsets = new Set([
    offsetMinutesAt(new Date(guess - DAY), timeZone),
    offsetMinutesAt(new Date(guess), timeZone),
    offsetMinutesAt(new Date(guess + DAY), timeZone),
  ])
  const matches: number[] = []
  for (const off of offsets) {
    const candidate = guess - off * 60000
    if (sameWall(wallTimeInZone(new Date(candidate), timeZone), wall)) matches.push(candidate)
  }
  const unique = [...new Set(matches)].sort((a, b) => a - b)
  if (unique.length === 1) return { instant: new Date(unique[0]), resolution: 'exact' }
  if (unique.length > 1) {
    return {
      instant: new Date(disambiguation === 'earlier' ? unique[0] : unique[unique.length - 1]),
      resolution: 'ambiguous',
    }
  }
  // Skipped wall time: interpret using the offset in force before the transition,
  // which lands the same distance after the gap (01:30 in a 01:00->02:00 gap -> 02:30).
  const before = offsetMinutesAt(new Date(guess - DAY), timeZone)
  return { instant: new Date(guess - before * 60000), resolution: 'skipped' }
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/

/** Parse "YYYY-MM-DDTHH:mm[:ss]" with no offset (a wall time). */
export function parseLocalDateTime(value: string): WallTime | null {
  const m = LOCAL_DATE_TIME.exec(value)
  if (!m) return null
  const w = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: m[6] ? Number(m[6]) : 0,
  }
  if (w.month < 1 || w.month > 12 || w.day < 1 || w.day > 31 || w.hour > 23 || w.minute > 59 || w.second > 59) {
    return null
  }
  // Reject impossible calendar dates such as 2026-02-30.
  const check = new Date(Date.UTC(w.year, w.month - 1, w.day))
  if (check.getUTCMonth() !== w.month - 1) return null
  return w
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/

/** Parse an ISO-8601 instant that carries an explicit offset or Z. Bare wall times are rejected. */
export function parseInstant(value: unknown): Date | null {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function shortZoneName(instant: Date, timeZone: string, locale = 'en-GB'): string {
  const parts = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' }).formatToParts(instant)
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone
}

/** e.g. "14:00 BST" */
export function formatTimeInZone(instant: Date, timeZone: string, locale = 'en-GB'): string {
  const time = new Intl.DateTimeFormat(locale, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    instant,
  )
  return `${time} ${shortZoneName(instant, timeZone, locale)}`
}

/** e.g. "Sun 29 Mar, 14:00 BST" */
export function formatDateTimeInZone(instant: Date, timeZone: string, locale = 'en-GB'): string {
  const date = new Intl.DateTimeFormat(locale, { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(
    instant,
  )
  return `${date.replace(',', '')}, ${formatTimeInZone(instant, timeZone, locale)}`
}

/** "in 30 minutes", "in 1 hour", "in 24 hours", "now" */
export function describeLeadTime(minutes: number): string {
  if (minutes <= 0) return 'now'
  if (minutes % 60 === 0) {
    const h = minutes / 60
    return `in ${h} hour${h === 1 ? '' : 's'}`
  }
  return `in ${minutes} minute${minutes === 1 ? '' : 's'}`
}

export type TimezoneMode = 'device' | 'preferred'

/**
 * The timezone used for display, quiet hours and reminder text.
 * Falls back to UTC (and says so) rather than guessing.
 */
export function resolveEffectiveTimezone(input: {
  mode: TimezoneMode
  preferredTimezone: string | null | undefined
  deviceTimezone: string | null | undefined
}): { timeZone: string; source: 'device' | 'preferred' | 'fallback_utc' } {
  if (input.mode === 'preferred' && isValidTimeZone(input.preferredTimezone)) {
    return { timeZone: input.preferredTimezone, source: 'preferred' }
  }
  if (isValidTimeZone(input.deviceTimezone)) return { timeZone: input.deviceTimezone, source: 'device' }
  if (isValidTimeZone(input.preferredTimezone)) return { timeZone: input.preferredTimezone, source: 'preferred' }
  return { timeZone: 'UTC', source: 'fallback_utc' }
}

/**
 * When the device timezone changes (e.g. the user travels) and they follow device time,
 * we surface a notice instead of silently changing how event times are shown.
 * Reminder instants never move: they are relative to the absolute session start.
 */
export function detectTimezoneChange(input: {
  mode: TimezoneMode
  lastKnownDeviceTimezone: string | null | undefined
  currentDeviceTimezone: string
}): { changed: false } | { changed: true; from: string; to: string; affectsDisplay: boolean } {
  const from = input.lastKnownDeviceTimezone
  if (!from || from === input.currentDeviceTimezone) return { changed: false }
  return { changed: true, from, to: input.currentDeviceTimezone, affectsDisplay: input.mode === 'device' }
}

/** Parse "HH:MM" into minutes since midnight. */
export function parseClockTime(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::00)?$/.exec(value)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

export function addDaysToWall(w: WallTime, days: number): WallTime {
  const d = new Date(Date.UTC(w.year, w.month - 1, w.day + days))
  return { ...w, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}
