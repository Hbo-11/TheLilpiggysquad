import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  detectTimezoneChange,
  formatDateTimeInZone,
  formatTimeInZone,
  isValidTimeZone,
  offsetMinutesAt,
  parseInstant,
  parseLocalDateTime,
  resolveEffectiveTimezone,
  wallTimeInZone,
  zonedWallTimeToInstant,
} from '../src/index.ts'

const wall = (s: string) => {
  const w = parseLocalDateTime(s)
  assert.ok(w, `bad wall time ${s}`)
  return w
}

test('converts event-local wall time to UTC using the zone rules for that date', () => {
  // Silverstone in July is BST (UTC+1); the same wall time in January is GMT.
  assert.equal(zonedWallTimeToInstant(wall('2026-07-05T15:00'), 'Europe/London').instant.toISOString(), '2026-07-05T14:00:00.000Z')
  assert.equal(zonedWallTimeToInstant(wall('2026-01-05T15:00'), 'Europe/London').instant.toISOString(), '2026-01-05T15:00:00.000Z')
  // Melbourne in March is AEDT (UTC+11); Suzuka never observes DST (UTC+9).
  assert.equal(zonedWallTimeToInstant(wall('2026-03-08T15:00'), 'Australia/Melbourne').instant.toISOString(), '2026-03-08T04:00:00.000Z')
  assert.equal(zonedWallTimeToInstant(wall('2026-04-05T14:00'), 'Asia/Tokyo').instant.toISOString(), '2026-04-05T05:00:00.000Z')
  // Half-hour and 45-minute zones.
  assert.equal(zonedWallTimeToInstant(wall('2026-11-01T12:00'), 'Asia/Kolkata').instant.toISOString(), '2026-11-01T06:30:00.000Z')
  assert.equal(zonedWallTimeToInstant(wall('2026-11-01T12:00'), 'Asia/Kathmandu').instant.toISOString(), '2026-11-01T06:15:00.000Z')
})

test('handles the spring-forward gap by shifting forward', () => {
  // UK clocks go 01:00 -> 02:00 on 29 March 2026. 01:30 does not exist.
  const r = zonedWallTimeToInstant(wall('2026-03-29T01:30'), 'Europe/London')
  assert.equal(r.resolution, 'skipped')
  assert.equal(r.instant.toISOString(), '2026-03-29T01:30:00.000Z') // = 02:30 BST
  assert.equal(wallTimeInZone(r.instant, 'Europe/London').hour, 2)
  // US: 8 March 2026, 02:00 -> 03:00 in New York.
  const ny = zonedWallTimeToInstant(wall('2026-03-08T02:15'), 'America/New_York')
  assert.equal(ny.resolution, 'skipped')
  assert.equal(ny.instant.toISOString(), '2026-03-08T07:15:00.000Z') // 03:15 EDT
})

test('handles the autumn overlap and lets the caller choose', () => {
  // UK clocks go back 02:00 -> 01:00 on 25 October 2026, so 01:30 happens twice.
  const earlier = zonedWallTimeToInstant(wall('2026-10-25T01:30'), 'Europe/London', 'earlier')
  const later = zonedWallTimeToInstant(wall('2026-10-25T01:30'), 'Europe/London', 'later')
  assert.equal(earlier.resolution, 'ambiguous')
  assert.equal(earlier.instant.toISOString(), '2026-10-25T00:30:00.000Z')
  assert.equal(later.instant.toISOString(), '2026-10-25T01:30:00.000Z')
  // Southern hemisphere: Melbourne goes back on 5 April 2026 (03:00 -> 02:00).
  const mel = zonedWallTimeToInstant(wall('2026-04-05T02:30'), 'Australia/Melbourne')
  assert.equal(mel.resolution, 'ambiguous')
})

test('round-trips every hour across a DST year without drift', () => {
  for (const tz of ['Europe/London', 'America/Sao_Paulo', 'Australia/Melbourne', 'America/New_York', 'UTC']) {
    for (let h = 0; h < 24 * 366; h += 7) {
      const instant = new Date(Date.UTC(2026, 0, 1) + h * 3_600_000)
      const w = wallTimeInZone(instant, tz)
      const back = zonedWallTimeToInstant(w, tz, offsetMinutesAt(instant, tz) === offsetMinutesAt(new Date(instant.getTime() - 3_600_000), tz) ? 'earlier' : 'later')
      // In an overlap the instant is one of the two candidates; check the wall time round-trips.
      assert.deepEqual(wallTimeInZone(back.instant, tz).minutesOfDay, w.minutesOfDay, `${tz} ${instant.toISOString()}`)
    }
  }
})

test('formats times with the timezone named', () => {
  const instant = new Date('2026-07-05T14:00:00Z')
  assert.equal(formatTimeInZone(instant, 'Europe/London'), '15:00 BST')
  assert.equal(formatTimeInZone(instant, 'UTC'), '14:00 UTC')
  assert.match(formatDateTimeInZone(instant, 'Australia/Melbourne'), /^Mon 6 Jul, 00:00 GMT\+10$/)
  // The same instant is a different calendar day in Sydney than in Los Angeles.
  assert.match(formatDateTimeInZone(instant, 'America/Los_Angeles'), /^Sun 5 Jul, 07:00 (PDT|GMT-7)$/)
})

test('parses only unambiguous inputs', () => {
  assert.equal(parseLocalDateTime('2026-02-30T10:00'), null)
  assert.equal(parseLocalDateTime('2026-02-10 10:00'), null)
  assert.equal(parseInstant('2026-07-05T14:00:00'), null, 'instant without offset is rejected')
  assert.equal(parseInstant('2026-07-05T15:00:00+01:00')?.toISOString(), '2026-07-05T14:00:00.000Z')
  assert.equal(isValidTimeZone('Mars/Olympus_Mons'), false)
  assert.equal(isValidTimeZone('Europe/Monaco'), true)
})

test('resolves the effective timezone from user settings', () => {
  assert.deepEqual(resolveEffectiveTimezone({ mode: 'device', preferredTimezone: 'Asia/Tokyo', deviceTimezone: 'Europe/Paris' }), {
    timeZone: 'Europe/Paris',
    source: 'device',
  })
  assert.deepEqual(resolveEffectiveTimezone({ mode: 'preferred', preferredTimezone: 'Asia/Tokyo', deviceTimezone: 'Europe/Paris' }), {
    timeZone: 'Asia/Tokyo',
    source: 'preferred',
  })
  assert.deepEqual(resolveEffectiveTimezone({ mode: 'device', preferredTimezone: null, deviceTimezone: null }), {
    timeZone: 'UTC',
    source: 'fallback_utc',
  })
})

test('flags device timezone changes instead of silently switching', () => {
  assert.deepEqual(detectTimezoneChange({ mode: 'device', lastKnownDeviceTimezone: 'Europe/London', currentDeviceTimezone: 'Asia/Singapore' }), {
    changed: true,
    from: 'Europe/London',
    to: 'Asia/Singapore',
    affectsDisplay: true,
  })
  const preferred = detectTimezoneChange({ mode: 'preferred', lastKnownDeviceTimezone: 'Europe/London', currentDeviceTimezone: 'Asia/Singapore' })
  assert.equal(preferred.changed && preferred.affectsDisplay, false)
  assert.deepEqual(detectTimezoneChange({ mode: 'device', lastKnownDeviceTimezone: null, currentDeviceTimezone: 'UTC' }), { changed: false })
})
