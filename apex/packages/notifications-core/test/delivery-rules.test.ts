import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideForRecipient,
  decideQuietHours,
  describeQuietHoursPolicy,
  evaluateRateLimit,
  isInQuietHours,
  quietHoursEndAfter,
  recommendedPreferences,
  type NotificationPreferences,
  type QuietHours,
  type RecentPush,
} from '../src/index.ts'

const quiet: QuietHours = { enabled: true, start: '23:00', end: '07:00', reminderPolicy: 'defer' }
const LONDON = 'Europe/London'

test('quiet hours crossing midnight are evaluated in the user timezone', () => {
  // 23:30 BST = 22:30Z
  assert.equal(isInQuietHours(new Date('2026-07-01T22:30:00Z'), quiet, LONDON), true)
  assert.equal(isInQuietHours(new Date('2026-07-01T05:59:00Z'), quiet, LONDON), true) // 06:59 BST
  assert.equal(isInQuietHours(new Date('2026-07-01T06:00:00Z'), quiet, LONDON), false) // 07:00 BST
  assert.equal(isInQuietHours(new Date('2026-07-01T21:59:00Z'), quiet, LONDON), false)
  // Same instant, different user timezone.
  assert.equal(isInQuietHours(new Date('2026-07-01T22:30:00Z'), quiet, 'America/New_York'), false)
  assert.equal(isInQuietHours(new Date('2026-07-01T22:30:00Z'), { ...quiet, enabled: false }, LONDON), false)
  // Daytime window.
  assert.equal(isInQuietHours(new Date('2026-07-01T12:00:00Z'), { ...quiet, start: '09:00', end: '17:00' }, LONDON), true)
})

test('quiet hours end on local time across a DST change', () => {
  // Night of 24->25 Oct 2026: clocks go back at 02:00 BST. 07:00 GMT = 07:00Z.
  const end = quietHoursEndAfter(new Date('2026-10-24T23:30:00Z'), quiet, LONDON)
  assert.equal(end.toISOString(), '2026-10-25T07:00:00.000Z')
  // Night before spring forward (29 Mar): 07:00 BST = 06:00Z.
  assert.equal(quietHoursEndAfter(new Date('2026-03-28T23:30:00Z'), quiet, LONDON).toISOString(), '2026-03-29T06:00:00.000Z')
})

test('security alerts are never delayed', () => {
  assert.deepEqual(
    decideQuietHours({ category: 'account_security', now: new Date('2026-07-01T23:30:00Z'), quietHours: quiet, timeZone: LONDON }),
    { action: 'send_now' },
  )
})

test('news is deferred to the end of quiet hours', () => {
  const d = decideQuietHours({ category: 'news_breaking', now: new Date('2026-07-01T23:30:00Z'), quietHours: quiet, timeZone: LONDON })
  assert.equal(d.action, 'defer')
  assert.equal(d.action === 'defer' && d.until.toISOString(), '2026-07-02T06:00:00.000Z')
})

test('race reminders follow the user policy and are never deferred past the session start', () => {
  const now = new Date('2026-07-02T02:00:00Z') // 03:00 BST
  const lateSession = new Date('2026-07-02T12:00:00Z')
  const earlySession = new Date('2026-07-02T02:30:00Z') // starts before quiet hours end
  const base = { category: 'race_reminders' as const, now, timeZone: LONDON }
  assert.equal(decideQuietHours({ ...base, quietHours: quiet, sessionStartsAt: lateSession }).action, 'defer')
  assert.deepEqual(decideQuietHours({ ...base, quietHours: quiet, sessionStartsAt: earlySession }), {
    action: 'in_app_only',
    reason: 'quiet_hours_session_started',
  })
  assert.deepEqual(decideQuietHours({ ...base, quietHours: { ...quiet, reminderPolicy: 'deliver' }, sessionStartsAt: earlySession }), {
    action: 'send_now',
  })
  assert.deepEqual(decideQuietHours({ ...base, quietHours: { ...quiet, reminderPolicy: 'in_app_only' }, sessionStartsAt: lateSession }), {
    action: 'in_app_only',
    reason: 'quiet_hours',
  })
  assert.match(describeQuietHoursPolicy(quiet), /already have started/)
})

const push = (category: RecentPush['category'], minutesAgo: number, now: Date): RecentPush => ({
  category,
  at: new Date(now.getTime() - minutesAgo * 60_000),
})

test('rate limits per category and overall, exempting security', () => {
  const now = new Date('2026-07-05T14:00:00Z')
  const twoNews = [push('news_major', 5, now), push('news_major', 10, now)]
  assert.deepEqual(evaluateRateLimit({ category: 'news_major', recentPushes: twoNews, now }), {
    allowed: false,
    reason: 'category_rate_limited',
  })
  // Old pushes outside the window do not count.
  assert.deepEqual(evaluateRateLimit({ category: 'news_major', recentPushes: [push('news_major', 61, now), push('news_major', 90, now)], now }), {
    allowed: true,
  })
  const busy = Array.from({ length: 8 }, (_, i) => push(i % 2 ? 'race_results' : 'race_reminders', i, now))
  assert.deepEqual(evaluateRateLimit({ category: 'ai_tasks', recentPushes: busy, now }), { allowed: false, reason: 'overall_rate_limited' })
  assert.deepEqual(evaluateRateLimit({ category: 'account_security', recentPushes: busy, now }), { allowed: true })
  // Security pushes do not use up the overall budget.
  const security = Array.from({ length: 10 }, (_, i) => push('account_security', i, now))
  assert.deepEqual(evaluateRateLimit({ category: 'ai_tasks', recentPushes: security, now }), { allowed: true })
})

function prefs(over: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return { ...recommendedPreferences(), ...over }
}

test('recipient decisions enforce preferences on the server side', () => {
  const now = new Date('2026-07-05T12:00:00Z')
  const recipient = { prefs: prefs(), deviceTimezone: LONDON, activeDeviceCount: 1, recentPushes: [] }
  assert.deepEqual(decideForRecipient({ category: 'news_major', recipient, now }), { create: false, reason: 'category_disabled' })
  const ok = decideForRecipient({ category: 'race_results', recipient, now })
  assert.deepEqual(ok, { create: true, timeZone: LONDON, push: { action: 'send_now' } })
  // Push switched off: still in-app.
  const noPush = decideForRecipient({ category: 'race_results', recipient: { ...recipient, prefs: prefs({ pushEnabled: false }) }, now })
  assert.deepEqual(noPush, { create: true, timeZone: LONDON, push: { action: 'none', reason: 'push_disabled' } })
  // Push disabled does not silence security alerts.
  const sec = decideForRecipient({ category: 'account_security', recipient: { ...recipient, prefs: prefs({ pushEnabled: false }) }, now })
  assert.deepEqual(sec, { create: true, timeZone: LONDON, push: { action: 'send_now' } })
  // No registered device: app keeps working with in-app notifications.
  const noDevice = decideForRecipient({ category: 'race_results', recipient: { ...recipient, activeDeviceCount: 0 }, now })
  assert.deepEqual(noDevice, { create: true, timeZone: LONDON, push: { action: 'none', reason: 'no_device' } })
  // Preferred timezone is used for quiet hours.
  const tokyo = decideForRecipient({
    category: 'race_results',
    recipient: { ...recipient, prefs: prefs({ timezoneMode: 'preferred', preferredTimezone: 'Asia/Tokyo', quietHours: quiet }) },
    now, // 21:00 in Tokyo: not quiet yet
  })
  assert.equal(tokyo.create && tokyo.push.action, 'send_now')
  const tokyoLate = decideForRecipient({
    category: 'race_results',
    recipient: { ...recipient, prefs: prefs({ timezoneMode: 'preferred', preferredTimezone: 'Asia/Tokyo', quietHours: quiet }) },
    now: new Date('2026-07-05T15:00:00Z'), // 00:00 in Tokyo
  })
  assert.equal(tokyoLate.create && tokyoLate.push.action, 'defer')
})
